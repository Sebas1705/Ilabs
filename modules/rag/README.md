# rag

Give a model the right passages of a small corpus, deterministically and measurably, with identical behavior in Kotlin and TypeScript. `rag` splits documents into chunks, indexes them, retrieves the best chunks for a question with BM25, dense vectors or their fusion, composes a numbered-sources context, checks the citations of an answer and scores retrieval against labelled questions. The behavior is pinned by the shared fixtures in [`contracts/rag`](../../contracts/rag/README.md); read that README for the exact rules and the fixture format.

It builds on [`providers`](../providers/README.md) for the one answer call (`MockProvider` for tests and demos, no API key needed) and on [`context`](../context/README.md) for the token cost of the composed context. Answers and retrievals can be graded with [`evals`](../evals/README.md) (see [Composing](#composing-with-providers-context-and-evals)). It does not use [`structured`](../structured/README.md) (only the Kotlin fixture harness does, to parse fixture files strictly).

**What this is, honestly.** A readable, teaching-scale tour of the standard pieces: chunking, sparse vs dense retrieval, hybrid fusion, grounding and retrieval metrics. The index lives in memory and search is brute force over every chunk; there is no persistence, no approximate nearest neighbour search, no reranker and no stemming. The built-in embedder hashes character trigrams: **it matches spelling, not meaning.** `bicicleta` finds `bicicletas`, but `car` and `automobile` share no trigram, and `card` can sit close to an unrelated chunk that happens to share letters (the [usage example](#typescript) shows exactly that). Plug a real model in through the [`Embedder`](#plugging-in-a-real-embedder) interface for semantic search.

## Pipeline

```
documents --chunkDocument--> chunks --buildIndex--> RagIndex (tokens + BM25 stats, one vector per chunk)
question  --search (bm25 | dense | hybrid)--> hits --composeContext--> one system message with [n] sources
system + question --provider.complete--> reply --extractCitations--> cited / unknown
hits + labelled relevant ids --retrievalMetrics--> recall@k, precision@k, reciprocal rank, hit
```

`answerWithSources` runs search, compose, the call and the citation check in one go.

Every length and offset is in Unicode code points, never UTF-16 units: an emoji is one, and a lone surrogate is one on its own.

## Chunking

A document is `{ id, text }`: ids non-empty and unique within one `buildIndex` call, any text (an empty one gives no chunks). A chunk is `{ id, docId, index, text, start, end }`: `[start, end)` are code-point offsets into the document, `text` is the original slice and `id = docId + "#" + index` (no escaping, so `notes#2024` gives `notes#2024#0`). The index order of chunks is document order, then chunk index; it breaks every tie.

- **`fixed { size, overlap }`** (`size >= 1`, `0 <= overlap < size`): windows of `size` code points advancing by `size - overlap`. The window that reaches the end of the text is the last (it may be shorter), so no window is contained in the previous one.
- **`paragraph { maxSize }`** (`maxSize >= 1`): a line break is LF or CRLF (a lone CR is an ordinary character); a run of two or more adjacent line breaks, or one at the very start or end of the text, separates paragraphs. Paragraphs made only of space, tab, CR and LF are dropped (an NBSP paragraph is kept). Consecutive paragraphs are packed greedily while the ORIGINAL slice from the first paragraph's start to the last one's end has `<= maxSize` code points, separators included. A paragraph longer than `maxSize` flushes the pack and is cut with `fixed { size: maxSize, overlap: 0 }`; its pieces are never packed with later paragraphs.

Worked offsets, both from the fixtures:

- `fixed { size: 4, overlap: 2 }` on `abcdefghij` (10 code points) steps by 2: `[0, 4) abcd`, `[2, 6) cdef`, `[4, 8) efgh`, `[6, 10) ghij`. The fourth window reaches 10, so there is no fifth (`chunk-fixed-overlap`).
- `paragraph { maxSize: 9 }` on `Uno\r\n\r\nDos\r\nmás\r\n\r\nTres`: `Uno` is `[0, 3)`; the separator `\r\n\r\n` is 4 code points, so `Dos` starts at 7; the single CRLF inside `Dos\r\nmás` is not a separator, so that paragraph is `[7, 15)` (8 code points, `á` is one); `Tres` is `[19, 23)`, and packing it would need `23 - 7 = 16 > 9`. In the second document, `abcd\r\n\r\ncd` gives `[0, 4)` and `[8, 10)`: packed, the slice would be 10 code points, one too many. With LF separators (`abcd\n\ncd`, 8 code points) the two would pack into one chunk: a CRLF separator costs more (`chunk-paragraph-crlf-offsets`).

## Tokenization

BM25, the hashing embedder and the "query without tokens" rule share `tokenize(text)`. A token is a maximal run of word code points: ASCII `0-9`, `A-Z`, `a-z`, and every code point `>= 0x80` outside the separator ranges U+00A0 to U+00BF (NBSP, `¡`, `«`, `»`, `¿`, and also `ª`, `º`, `µ`, superscripts and fractions), U+00D7 `×`, U+00F7 `÷` and U+2000 to U+206F (General Punctuation). Every other ASCII character separates, including `_`, `'` and `-` (`it's` gives `it`, `s`).

Folding is per code point: ASCII `A-Z` to `a-z`, then a pinned table for the 62 Latin-1 letters U+00C0 to U+00FF, upper and lower case (`á` and `Á` to `a`, `ñ` to `n`, `ü` to `u`, `ç` to `c`, `ß` to `ss`, `æ` to `ae`, `þ` to `th`, `ð` to `d`, …; the full table is in the [contract](../../contracts/rag/README.md#rules)). So `¿Qué?` gives `que` and `PRESTAMO` matches `préstamo`. Everything else is kept as is: no Unicode case folding (`Ł`, `Œ`, Greek stay), no NFC/NFD (`e` plus a combining accent does not match `é`), no stemming (`libraries` does not match `library` in BM25).

`tokenizeSpans(text)` is the same tokenizer with positions (one additive public function in both languages, added for [`guardrails`](../guardrails/README.md)): it returns `[{ token, start, end }]`, one entry per token of `tokenize` and in the same order, where `token` is the folded token and `[start, end)` are the code-point offsets of the SOURCE run in the original text, `end` exclusive. Because folding can lengthen a code point, `end - start` is the length of the source run, not of `token`: `Straße` gives `{ token: "strasse", start: 0, end: 6 }`. `tokenize(text)` is exactly the list of its `token` fields. In Kotlin `tokenizeSpans(text)` returns `List<TokenSpan>` with the same three fields. The `rag` fixtures are unchanged; the span rules are pinned by unit tests in both languages and by the [guardrails contract](../../contracts/guardrails/README.md).

## BM25

`N` is the number of chunks (all of them, including chunks without tokens), `len(c)` the token count of a chunk and `avgLen` the mean over all chunks. For each DISTINCT query token `q` (a repeated query token counts once), with `n` the number of chunks containing it and `tf` its count in the chunk:

```
idf  = ln(1 + (N - n + 0.5) / (n + 0.5))
term = idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * len / avgLen))      k1 = 1.2, b = 0.75
```

The score is the sum of the terms with `tf > 0`. A chunk that scores 0 is not a hit, so a chunk without tokens is never a BM25 hit, and a query whose words appear nowhere returns nothing.

## The hashing embedder

`hashEmbed(text, dim = 256)` and `hashEmbedder(dim = 256)` (`dim` an integer `>= 1`, checked at construction):

1. Start from `dim` zeros.
2. For each token, wrap it as `<token>` and take every window of 3 code points (`<hola>` gives `<ho`, `hol`, `ola`, `la>`; a one-code-point token gives exactly one window). Every occurrence counts.
3. Encode the window as UTF-8 by hand (a lone surrogate as U+FFFD), hash it with FNV-1a 32-bit, add `+1` (bit 31 clear) or `-1` (bit 31 set) to bucket `h mod dim`.
4. L2-normalize. A text without tokens stays the zero vector.

A dense search scores each chunk with the dot product of its vector and the query vector (the cosine, for these unit vectors); a score `<= 0` is not a hit.

## Hybrid: reciprocal-rank fusion

Hybrid computes the full BM25 and dense rankings, cuts each at `candidates` (default 50) and gives every chunk in at least one cut list `1 / (60 + bm25Rank) + 1 / (60 + denseRank)`, a term only for the lists it is in. Each hybrid hit reports `bm25Rank` and `denseRank` when the chunk is in that list. Fusion rewards agreement: a chunk that both methods rank well beats one that only one method ranks first.

A real flip, from `hybrid-fusion-order` (the shared `town` corpus, query `carné de lector`, `topK: 4`):

| Chunk | BM25 rank | Dense rank | Fused score | Fused rank |
|---|---|---|---|---|
| `es-biblioteca#1` | 1 | 1 | 1/61 + 1/61 = 0.03278688524590164 | 1 |
| `es-biblioteca#2` | 3 | 2 | 1/63 + 1/62 = 0.03200204813108039 | 2 |
| `es-taller#0` | 2 | 4 | 1/62 + 1/64 = 0.031754032258064516 | 3 |
| `es-biblioteca#0` | 4 | 3 | 1/64 + 1/63 = 0.03149801587301587 | 4 |

BM25 alone puts `es-taller#0` second; dense alone puts `es-biblioteca#0` third. The fused order differs from both.

## Ranking and options

Hits are ordered by descending score; only exactly equal doubles tie, and ties keep index order. `rank` is the 1-based position after that order and the `topK` cut. A hit is `{ chunkId, docId, rank, score }`, plus `bm25Rank?` and `denseRank?` in hybrid mode only.

- `topK` is an integer `>= 1`, default 5.
- `candidates` is used and validated in `hybrid` mode only: there it must be an integer `>= 1` and `>=` the effective `topK`. The `bm25` and `dense` modes ignore it completely, even `0`. Absent means 50 and is never compared with `topK` (`topK: 60` alone is valid).
- `dense` and `hybrid` on an index built without an embedder fail with `no_embedder`, checked before the early returns below.
- A query without tokens, or an index without chunks, returns no hits and does not call the embedder.
- `buildIndex` calls the embedder once with all chunk texts (none when there are no chunks) and validates the result eagerly; a dense or hybrid search calls it once with `[query]`.

## Context composition

`composeContext(hits, index, { maxTokens, counter? })` builds ONE `system` message, pinned exactly:

```
RAG_INSTRUCTION + "\n\n" + "[1] " + text1 + "\n\n" + "[2] " + text2 + ...      (no trailing newline)

RAG_INSTRUCTION = "Answer the question using only the numbered sources below. Cite the sources you use as [n]. If the sources do not contain the answer, say so."
```

`RAG_INSTRUCTION` (141 code points) is exported by both implementations. With no source the content is the instruction alone. The cost is `counter(message)`, by default `context`'s `4 + ceil(codePoints / 4)`. The hits are walked in ARRAY order (`rank` is never read): hit `k` becomes source `[k]` if the message with sources `1..k` costs `<= maxTokens`; the first hit that does not fit stops the walk, and later hits are dropped even if shorter. If not even the first fits, `budget_too_small` reports `required`, the cost of the message with that first source. Empty hits need `maxTokens >= 40` (the instruction alone). The result is `{ message, sources: [{ n, chunkId, docId }], droppedCount }`. The user message with the question is not charged to `maxTokens`.

## Citations

`extractCitations(answer, sources)` returns `{ cited, unknown }`. A marker is exactly `[`, 1 to 9 ASCII digits not starting with `0`, `]`; it is tried at every `[`, so `[[2]]` contains `[2]` and `[1][2]` is two markers. `[1,2]`, `[ 1 ]`, `[01]`, `[0]`, `[]`, `[-1]`, Unicode digits and ten digits are not markers. Values are listed in order of first appearance, deduplicated, never sorted. `cited` holds the values equal to some source's `n`, `unknown` the others: in `answerWithSources` the sources are the KEPT ones, so a marker for a hit the budget dropped is `unknown`.

## Retrieval metrics

`retrievalMetrics(hits, relevant, { level? })` scores the hits in ARRAY order (position `k` is rank `k`) against a non-empty set of relevant chunk ids (`level: "chunk"`, the default) or document ids (`level: "doc"`). At doc level the list is the hits' `docId`s deduplicated keeping the first, best-ranked occurrence.

```
recallAtK      = distinct relevant ids in the list / |relevant|
precisionAtK   = relevant entries / length of the list          (0 for an empty list)
reciprocalRank = 1 / position of the first relevant entry       (0 when there is none)
hit            = there is a relevant entry
```

Example (`metrics-doc-level-dedupe`): hits `a#0, a#1, b#0, c#2` with relevant documents `{b, c}` become the list `a, b, c`, so recall is 1, precision 2/3 (`0.6666666666666666`) and reciprocal rank 1/2. At chunk level the hits are not deduplicated, and a document id in `relevant` matches no chunk id. Precision divides by the number of hits, not by `topK`.

## `answerWithSources`

`answerWithSources(provider, index, query, { mode, topK?, candidates?, maxTokens })` validates every option first, then searches, composes and makes exactly ONE `provider.complete` call with `[system: composed content, user: query]` and no other field (no `maxTokens`). It returns `{ answer, sources, citations, hits }`: `answer` is the reply text verbatim (no trimming), `sources` the kept sources. Every `RagError` happens before the call (zero calls), including `budget_too_small` for no hits with `maxTokens < 40`. With no hits and a budget that fits, the call is still made with the instruction alone. A provider error (`rate_limit`, `timeout`, `invalid_output`, `unavailable`, also an exhausted mock script) propagates unchanged after the one call; there are no retries.

## Errors

TypeScript throws `RagError` (an `Error` with `kind` and, for `budget_too_small` only, `required`). Kotlin throws `RagException(kind: RagErrorKind, required: Int?)`; `kind.wire` is the contract string. Kotlin's `RagException` carries no detail text (the TypeScript message is `<kind>: <detail>`); the kind is the contract.

| Kind | Thrown by | When |
|---|---|---|
| `invalid_options` | every operation, before any work | empty or duplicate document id; `size`, `maxSize`, `topK`, `maxTokens`, `dim` not an integer `>= 1`; `overlap` outside `0 <= overlap < size`; in `hybrid`, a given `candidates` below 1 or below the effective `topK`; an unknown chunking `type`, `mode` or `level`; an empty `relevant`; a non-integer number such as `2.5`; in TypeScript, `null` for an option |
| `no_embedder` | `search`, `answerWithSources` | `dense` or `hybrid` on an index built without an embedder (reported after `invalid_options`) |
| `invalid_embedding` | `buildIndex`; `search` in `dense`/`hybrid` | the wrong number of vectors, vectors of different lengths, a non-finite entry (NaN, infinity) or, in TypeScript, a sparse array; a query result that is not exactly one vector of the chunk vectors' length |
| `budget_too_small` | `composeContext`, `answerWithSources` | not even the first source fits, or no hits and the instruction alone does not fit; `required` is the cost of that message |

Programmer errors that fixtures cannot express use the platform types: in TypeScript a `TypeError` for an index not made by `buildIndex`, an embedder without `embed` or a query that is not a string, and a `RangeError` for a hit whose `chunkId` is not in the index (every hit is resolved before any cost is computed, so this is reported before `budget_too_small`); in Kotlin an `IllegalArgumentException` for that hit.

## TypeScript

```ts
import { MockProvider } from "@ilabs/providers";
import { answerWithSources, buildIndex, composeContext, hashEmbedder, RagError, search, type Document, type Mode } from "@ilabs/rag";

const documents: Document[] = [
  { id: "library", text: "The town library opens Monday to Friday.\n\nTo borrow a book you need a library card. A loan lasts three weeks." },
  { id: "taller", text: "El taller de bicicletas repara pinchazos y frenos.\n\nUna reparación sencilla cuesta cinco euros." },
];

// One chunk per paragraph here (two paragraphs together exceed 80 code points); the hashing embedder enables dense and hybrid.
const index = await buildIndex(documents, { chunking: { type: "paragraph", maxSize: 80 }, embedder: hashEmbedder() });
for (const c of index.chunks) console.log(`${c.id} [${c.start}, ${c.end})`);
// library#0 [0, 40)
// library#1 [42, 109)
// taller#0 [0, 50)
// taller#1 [52, 95)

const modes: Mode[] = ["bm25", "dense", "hybrid"];
for (const query of ["bicicleta", "card"]) {
  for (const mode of modes) {
    const hits = await search(index, query, { mode, topK: 3 });
    const ids = hits.map((h) => (mode === "hybrid" ? `${h.chunkId} (${h.bm25Rank ?? "-"}/${h.denseRank ?? "-"})` : h.chunkId));
    console.log(`${query} ${mode}: ${ids.join(", ")}`);
  }
}
// bicicleta bm25:
// bicicleta dense: taller#0, taller#1, library#0
// bicicleta hybrid: taller#0 (-/1), taller#1 (-/2), library#0 (-/3)
// card bm25: library#1
// card dense: taller#1, library#1, taller#0
// card hybrid: library#1 (1/2), taller#1 (-/1), taller#0 (-/3)

// Compose the numbered-sources context by hand...
const hits = await search(index, "How long does a loan last?", { mode: "hybrid", topK: 2 });
const composed = composeContext(hits, index, { maxTokens: 200 });
console.log(composed.message.content);
// Answer the question using only the numbered sources below. Cite the sources you use as [n]. If the sources do not contain the answer, say so.
//
// [1] To borrow a book you need a library card. A loan lasts three weeks.
//
// [2] El taller de bicicletas repara pinchazos y frenos.
console.log(composed.sources.map((s) => `[${s.n}] ${s.chunkId}`).join(" "), "dropped:", composed.droppedCount);
// [1] library#1 [2] taller#0 dropped: 0

// ...or let answerWithSources search, compose and make the one provider call.
const provider = new MockProvider("mock", [{ response: "A loan lasts three weeks [1]. You can renew it [3]." }]);
const out = await answerWithSources(provider, index, "How long does a loan last?", { mode: "hybrid", topK: 2, maxTokens: 200 });
console.log(out.answer); // A loan lasts three weeks [1]. You can renew it [3].
console.log(out.citations); // { cited: [ 1 ], unknown: [ 3 ] }

try {
  composeContext(hits, index, { maxTokens: 50 });
} catch (error) {
  if (error instanceof RagError) console.log(error.kind, error.required); // budget_too_small 58
}
```

What the output shows:

- `bicicleta` has no BM25 hit (no chunk has that exact token; `bicicletas` is a different token), but the trigrams it shares with `bicicletas` rank `taller#0` first in dense mode.
- `card` is the opposite case: BM25 finds the one chunk with the word, while the hashing embedder ranks `taller#1` above it only because of shared letters (it matches spelling, not meaning). Hybrid puts `library#1` back on top: it is in both lists.
- For the loan question, hybrid fills `topK: 2` with a second, unrelated chunk (dense gives it a small positive score) and the budget keeps it. The mock reply cites `[1]` and `[3]`; there is no source 3, so `3` lands in `unknown`.
- Adding the first source costs 58 tokens (214 code points), so a budget of 50 fails with `required` 58.

`tokenize`, `chunkDocument`, `hashEmbed`, `extractCitations`, `retrievalMetrics` and the types (`Chunk`, `Chunking`, `Embedder`, `Hit`, `RagIndex`, `Source`, `Citations`, `RetrievalMetrics`, `SearchOptions`, `AnswerOptions`, `AnswerResult`, `ComposedContext`, `RagErrorKind`, …) are exported too.

## Kotlin

```kotlin
import es.sebas1705.ilabs.providers.*
import es.sebas1705.ilabs.rag.*

suspend fun demo() {
    val documents = listOf(
        Document("library", "The town library opens Monday to Friday.\n\nTo borrow a book you need a library card. A loan lasts three weeks."),
        Document("taller", "El taller de bicicletas repara pinchazos y frenos.\n\nUna reparación sencilla cuesta cinco euros."),
    )

    // One chunk per paragraph here (two paragraphs together exceed 80 code points); the hashing embedder enables dense and hybrid.
    val index = buildIndex(documents, Chunking.Paragraph(maxSize = 80), hashEmbedder())
    for (c in index.chunks) println("${c.id} [${c.start}, ${c.end})")
    // library#0 [0, 40)
    // library#1 [42, 109)
    // taller#0 [0, 50)
    // taller#1 [52, 95)

    for (query in listOf("bicicleta", "card")) {
        for (mode in Mode.entries) {
            val hits = search(index, query, mode, topK = 3)
            val ids = hits.map { h ->
                if (mode == Mode.HYBRID) "${h.chunkId} (${h.bm25Rank ?: "-"}/${h.denseRank ?: "-"})" else h.chunkId
            }
            println("$query ${mode.wire}: ${ids.joinToString(", ")}")
        }
    }
    // bicicleta bm25:
    // bicicleta dense: taller#0, taller#1, library#0
    // bicicleta hybrid: taller#0 (-/1), taller#1 (-/2), library#0 (-/3)
    // card bm25: library#1
    // card dense: taller#1, library#1, taller#0
    // card hybrid: library#1 (1/2), taller#1 (-/1), taller#0 (-/3)

    // Compose the numbered-sources context by hand...
    val hits = search(index, "How long does a loan last?", Mode.HYBRID, topK = 2)
    val composed = composeContext(hits, index, maxTokens = 200)
    println(composed.message.content)
    // Answer the question using only the numbered sources below. Cite the sources you use as [n]. If the sources do not contain the answer, say so.
    //
    // [1] To borrow a book you need a library card. A loan lasts three weeks.
    //
    // [2] El taller de bicicletas repara pinchazos y frenos.
    println("${composed.sources.joinToString(" ") { "[${it.n}] ${it.chunkId}" }} dropped: ${composed.droppedCount}")
    // [1] library#1 [2] taller#0 dropped: 0

    // ...or let answerWithSources search, compose and make the one provider call.
    val provider = MockProvider("mock", listOf(ScriptEntry(response = "A loan lasts three weeks [1]. You can renew it [3].")))
    val out = answerWithSources(provider, index, "How long does a loan last?", Mode.HYBRID, topK = 2, maxTokens = 200)
    println(out.answer) // A loan lasts three weeks [1]. You can renew it [3].
    println(out.citations) // Citations(cited=[1], unknown=[3])

    try {
        composeContext(hits, index, maxTokens = 50)
    } catch (e: RagException) {
        println("${e.kind.wire} ${e.required}") // budget_too_small 58
    }
}
```

In Kotlin the options are parameters (`buildIndex(documents, chunking, embedder = null)`, `search(index, query, mode, topK = 5, candidates = null)`, `composeContext(hits, index, maxTokens, counter = defaultCounter)`, `retrievalMetrics(hits, relevant, level = Level.CHUNK)`, `answerWithSources(provider, index, query, mode, topK = 5, candidates = null, maxTokens)`), `Mode` and `Level` are enums whose `wire` is the contract string, `Chunking` is a sealed interface (`Chunking.Fixed(size, overlap)`, `Chunking.Paragraph(maxSize)`), vectors are `DoubleArray`, `answerWithSources` returns `Answer` and every function that may call an embedder or a provider is `suspend`.

## Composing with `providers`, `context` and `evals`

`answerWithSources` makes one call and never retries. Wrap the model with [`providers`](../providers/README.md) for retries or a fallback; the citations are checked on whatever the chain finally returns:

```ts
// `index` is an index built as in the TypeScript example above.
import { MockProvider, RetryingProvider } from "@ilabs/providers";
import { answerWithSources } from "@ilabs/rag";

const model = new RetryingProvider(
  new MockProvider("primary", [{ error: { kind: "rate_limit" } }, { response: "Three weeks [1]." }]),
  { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1000, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
);
const answer = await answerWithSources(model, index, "How long does a loan last?", { mode: "bm25", maxTokens: 200 });
console.log(answer.answer, answer.citations); // Three weeks [1]. { cited: [ 1 ], unknown: [] }
```

The composed message is a plain `system` message, so [`context`](../context/README.md) can budget a multi-turn chat around it: `slidingWindow` never drops a system message, so the sources stay and the oldest turns go first. Pass the same `counter` to both if you use a real tokenizer.

```ts
import type { Message } from "@ilabs/providers";
import { slidingWindow } from "@ilabs/context";
import { composeContext, search } from "@ilabs/rag";

const hits = await search(index, "How long does a loan last?", { mode: "bm25" });
const { message } = composeContext(hits, index, { maxTokens: 120 });
const history: Message[] = [
  { role: "user", content: "Hi! I have a question about the library." },
  { role: "assistant", content: "Sure, ask away." },
  { role: "user", content: "How long does a loan last?" },
];
const window = slidingWindow([message, ...history], { maxTokens: 75 });
console.log(window.messages.map((m) => m.role), window.droppedCount); // [ 'system', 'user' ] 2
```

To grade grounded answers with [`evals`](../evals/README.md), wrap `answerWithSources` in a `Provider` and use it as a target. Here a `contains` grader on `[1]` checks that the reply cites the first source:

```ts
import { MockProvider, type CompletionRequest, type Provider } from "@ilabs/providers";
import { runSuite, type Suite } from "@ilabs/evals";
import { answerWithSources, buildIndex, hashEmbedder } from "@ilabs/rag";

// `documents` are the two documents of the TypeScript example above.
const index = await buildIndex(documents, { chunking: { type: "paragraph", maxSize: 80 }, embedder: hashEmbedder() });

// A target that answers through rag: the last user message is the query, the reply is answerWithSources' answer.
function ragTarget(id: string, model: Provider): Provider {
  return {
    id,
    async complete(req: CompletionRequest) {
      const query = req.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
      const out = await answerWithSources(model, index, query, { mode: "hybrid", topK: 2, maxTokens: 200 });
      return { text: out.answer, provider: id };
    },
  };
}

const suite: Suite = {
  cases: [
    {
      id: "loan",
      messages: [{ role: "user", content: "How long does a loan last?" }],
      graders: [
        { kind: "contains", value: "[1]" },
        { kind: "contains", value: "three weeks", ignoreCase: true },
      ],
    },
  ],
};
const grounded = ragTarget("grounded", new MockProvider("m1", [{ response: "Three weeks [1]." }]));
const ungrounded = ragTarget("ungrounded", new MockProvider("m2", [{ response: "About three weeks, I think." }]));

const run = await runSuite(suite, { targets: [grounded, ungrounded] });
for (const r of run.results) console.log(r.targetId, r.status, r.graders.map((g) => g.passed));
// grounded pass [ true, true ]
// ungrounded fail [ false, true ]
```

`rag` does not depend on `evals`; the app that runs the suite depends on both. A `contains` grader only sees the text: for a stricter check, also compare `out.citations.unknown` with `[]` in the target and fail the call when it is not. Retrieval itself is measured with `retrievalMetrics`, not with `evals` (the `eval` fixture kind runs labelled questions in the three modes).

## Plugging in a real embedder

`Embedder` is the only seam. It takes the texts and returns one vector per text, all of the same length, with finite numbers:

```ts
interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}
```

```kotlin
fun interface Embedder {
    suspend fun embed(texts: List<String>): List<DoubleArray>
}
```

An adapter over an embeddings client is a few lines; `embedBatch` stands for your client's call (an HTTP API, an on-device model). No such client ships with iLabs, on purpose: it would need a key or a model download and would not be deterministic.

```ts
import { buildIndex, type Embedder } from "@ilabs/rag";

class ClientEmbedder implements Embedder {
  constructor(private readonly embedBatch: (inputs: string[]) => Promise<number[][]>) {}
  async embed(texts: string[]): Promise<number[][]> {
    return this.embedBatch(texts); // one vector per text, all of the same length, finite numbers
  }
}
const realIndex = await buildIndex(documents, { chunking: { type: "paragraph", maxSize: 80 }, embedder: new ClientEmbedder(embedBatch) });
```

`buildIndex` makes one `embed` call with every chunk text (batch it inside your adapter if the API has a size limit) and each dense or hybrid search makes one call with `[query]`. The dense score is the plain dot product of the vectors as returned (no renormalization), so normalize them in the adapter if your model does not, to get cosine scores.

## Limits

- **The built-in embedder is not semantic.** It hashes character trigrams of folded tokens: similar spellings score close, synonyms and translations do not, and unrelated words that share letters can score above the right chunk. Hash collisions (256 buckets by default) add noise.
- **Teaching scale.** The index is in memory, built at once and never updated; every search scores every chunk (brute force). No persistence, approximate search, reranking, query rewriting or stemming.
- **Tokenization is Latin-1 centred.** Only the pinned separator ranges split words: other Unicode punctuation and spaces (U+3000, U+FF0C, …) are word characters, scripts without spaces (Chinese, Japanese) become one long token, and folding stops at U+00FF.
- **Float parity.** Both languages use IEEE-754 doubles and the same operation order, but `ln` comes from the platform and can differ in the last bit between platforms (contract clarification 15), so BM25 scores (and the RRF scores built on them) can differ between Kotlin and TypeScript in the last digits (`sqrt` is correctly rounded on both, so dense scores do not drift). Ranks and ties are identical in practice: the fixtures compare scores with a tolerance of `1e-9` and contain no two different scores closer than that, and exact ties are ties by construction.
- **The token cost is an estimate.** `context`'s default counter is `4 + ceil(codePoints / 4)`; pass a `counter` backed by the model's tokenizer for real budgets.
- **Options.** `candidates` only matters in `hybrid` mode. JSON `null` for an option is a bad value (`invalid_options`), never "absent": in TypeScript leave the key out (`undefined`) for the default; in Kotlin the numeric parameters cannot be `null` except `candidates`, whose `null` is the default (absent). Integers above 2^31 - 1 are out of scope (Kotlin `Int`).
- **The index is read-only.** In TypeScript the index object, its `chunks` array and every chunk are frozen. In Kotlin `RagIndex.chunks` is a read-only copy (a cast to `MutableList` fails and the Java mutators throw), so the token statistics computed at build time can never go out of sync.
- **Fixture test device.** The `script` embedder type in the fixtures (fixed vectors per call, whatever the input) exists only to pin dense and validation rules exactly; it is not part of the library API.

## Contract

[`contracts/rag/README.md`](../../contracts/rag/README.md) defines the behavior, the fixture format and the shared `town` sample corpus. Both implementations must pass every fixture in that folder: `runFixture` (exported by the TypeScript package and, in Kotlin, from `es.sebas1705.ilabs.rag.contract`) runs one fixture with a recording mock provider and the fixture's embedder. The design is in [the rag design spec](../../docs/superpowers/specs/2026-11-14-rag-design.md).

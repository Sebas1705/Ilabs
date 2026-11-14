# rag contract

Shared contract for the `rag` module (Kotlin and TypeScript): split documents into chunks, index them, retrieve the best chunks for a question with BM25, dense vectors or their fusion, compose a numbered-sources context, check the citations of an answer and score retrieval against labelled questions. Everything here is deterministic; a real embedding model, a real model answer and the wording of the demo UI are not in the contract. Both implementations must pass every `*.json` fixture in this folder.

Messages, providers and provider errors are the `providers` types (see [../providers/README.md](../providers/README.md)). The token cost of the composed context is `context`'s default counter (see [../context/README.md](../context/README.md)).

## Rules

**Code points.** Every length and offset in this module is in Unicode code points, never UTF-16 units. A high surrogate followed by a low surrogate is one code point; any other surrogate (lone high, lone low, or a low followed by a high) is one code point on its own and never swallows its neighbour (clarification 1).

**Documents and chunks.** A document is `{ id, text }`: `id` a non-empty string, unique within one `buildIndex` call; `text` any string (empty is valid). `chunkDocument(doc, chunking)` returns chunks `{ id, docId, index, text, start, end }`: `start`/`end` are code-point offsets into the document text (`end` exclusive), `text` is the original slice `[start, end)`, `index` counts from 0 in emission order and `id = docId + "#" + index` (no escaping, so the document `notes#2024` gives `notes#2024#0`). An empty document yields no chunks. The *index order* of chunks is document order (as given to `buildIndex`), then chunk index.

**`fixed { size, overlap }`.** `size` an integer `>= 1`, `overlap` an integer with `0 <= overlap < size`. With `L` the length of the text: if `L = 0` there is no chunk; otherwise `s = 0` and repeat: emit `[s, min(s + size, L))`; stop if that window ends at `L`; else `s = s + (size - overlap)`. So the last window ends at the end of the text (it may be shorter than `size`), no window is emitted after the one that reaches the end, and no window's span is contained in the previous one.

**`paragraph { maxSize }`.** `maxSize` an integer `>= 1`.

1. *Line breaks.* Scan left to right: CR followed by LF is ONE line break of two code points (CRLF); an LF not preceded by such a CR is a line break of one code point; a CR not followed by LF is an ordinary character.
2. *Separators.* A *run* is a maximal sequence of line breaks that are directly adjacent (each starts where the previous ends; any other code point between them, even a space, ends the run). A run is a *separator* when it has two or more line breaks, or when it starts at offset 0, or when it ends at offset `L`.
3. *Paragraphs* are the maximal non-empty spans between separators (separators excluded). A paragraph made only of space (U+0020), tab, CR and LF is dropped, BEFORE packing (it never starts or extends a pack). Only those four code points are whitespace here: a paragraph of NBSP (U+00A0) or other Unicode spaces is kept (do not use `trim()`, `isBlank()`, `\s`).
4. *Packing.* Walk the remaining paragraphs in order with a current pack (initially empty). For a paragraph `[a, b)`:
   - if `b - a > maxSize`: flush the pack (emit it as a chunk if non-empty, then empty it); cut `[a, b)` with the `fixed { size: maxSize, overlap: 0 }` rule (offsets relative to the document) and emit each piece as its own chunk; the pack stays empty, so a piece is never packed with a later paragraph;
   - else if the pack is non-empty and `b - packStart <= maxSize`: extend the pack to `[packStart, b)`;
   - else flush the pack and start a new one with `[a, b)`.
   At the end flush the pack. A pack's chunk text is the ORIGINAL slice from its first paragraph's start to its last paragraph's end: separators (and any dropped paragraph between them) are inside it, so a CRLF separator costs more than an LF one.

**Tokenization** (`tokenize(text) -> string[]`, used by BM25, the hash embedder and the "query without tokens" rule). A token is a maximal run of *word code points*; every other code point is a separator and ends the current token.

- *Word code points*: ASCII `0-9`, `A-Z`, `a-z`; and every code point `>= 0x80` that is not in the pinned separator ranges below. Every other ASCII code point (space, control characters, all ASCII punctuation including `_`, `'`, `-`) is a separator. Lone surrogates are word code points.
- *Pinned separator ranges beyond ASCII* (inclusive): U+00A0 to U+00BF, ALL of it (NBSP, `¡`, `¢` … `«`, `»`, `·`, `¿`, and also the letter-like `ª` U+00AA, `µ` U+00B5, `º` U+00BA, the superscripts `²` `³` `¹` and the fractions `¼` `½` `¾`: `1º` gives `1`, `5µm` gives `5`, `m`); U+00D7 (`×`); U+00F7 (`÷`); U+2000 to U+206F (General Punctuation: the spaces U+2000 to U+200A, zero-width characters, dashes, curly quotes, `…`, per-mille, …). Nothing else is a separator: other Unicode spaces and punctuation (U+3000, U+FF0C, …) are word code points, a documented limit.
- *Folding* is applied to each word code point independently, and the replacements are concatenated in order: ASCII `A-Z` → `a-z` (add 0x20); then the Latin-1 table below; every other code point is kept exactly as is (no Unicode case folding, no NFC/NFD normalization, no stemming). Whether a code point is a separator is decided on the original code point.

| Code points | Replacement |
|---|---|
| U+00C0 `À`, U+00C1 `Á`, U+00C2 `Â`, U+00C3 `Ã`, U+00C4 `Ä`, U+00C5 `Å` | `a` |
| U+00C6 `Æ` | `ae` |
| U+00C7 `Ç` | `c` |
| U+00C8 `È`, U+00C9 `É`, U+00CA `Ê`, U+00CB `Ë` | `e` |
| U+00CC `Ì`, U+00CD `Í`, U+00CE `Î`, U+00CF `Ï` | `i` |
| U+00D0 `Ð` | `d` |
| U+00D1 `Ñ` | `n` |
| U+00D2 `Ò`, U+00D3 `Ó`, U+00D4 `Ô`, U+00D5 `Õ`, U+00D6 `Ö`, U+00D8 `Ø` | `o` |
| U+00D9 `Ù`, U+00DA `Ú`, U+00DB `Û`, U+00DC `Ü` | `u` |
| U+00DD `Ý` | `y` |
| U+00DE `Þ` | `th` |
| U+00DF `ß` | `ss` |
| U+00E0 `à`, U+00E1 `á`, U+00E2 `â`, U+00E3 `ã`, U+00E4 `ä`, U+00E5 `å` | `a` |
| U+00E6 `æ` | `ae` |
| U+00E7 `ç` | `c` |
| U+00E8 `è`, U+00E9 `é`, U+00EA `ê`, U+00EB `ë` | `e` |
| U+00EC `ì`, U+00ED `í`, U+00EE `î`, U+00EF `ï` | `i` |
| U+00F0 `ð` | `d` |
| U+00F1 `ñ` | `n` |
| U+00F2 `ò`, U+00F3 `ó`, U+00F4 `ô`, U+00F5 `õ`, U+00F6 `ö`, U+00F8 `ø` | `o` |
| U+00F9 `ù`, U+00FA `ú`, U+00FB `û`, U+00FC `ü` | `u` |
| U+00FD `ý`, U+00FF `ÿ` | `y` |
| U+00FE `þ` | `th` |

These are the 62 letters of U+00C0 to U+00FF, upper AND lower case of every group (U+00D7 and U+00F7 are separators; the design's shorter list naming only upper case for some groups was shorthand). Copy the table verbatim into both implementations. `Ÿ` (U+0178), `Œ`, `Ł` and every other code point are kept as is.

**BM25.** The index has `N` chunks (ALL chunks, including chunks without tokens). `len(c)` is the token count of chunk `c`; `avgLen = (sum of len over all chunks) / N`. For each DISTINCT query token `q`, in order of first appearance in the query (a token repeated in the query counts once): `n(q)` = number of chunks that contain `q` at least once, `tf` = occurrences of `q` in the chunk, and

```
idf  = ln(1 + (N - n + 0.5) / (n + 0.5))
term = idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * len / avgLen))      k1 = 1.2, b = 0.75
```

`score(c)` is the sum of `term` over the distinct query tokens with `tf > 0`, added in that order starting from `0.0` (terms with `tf = 0` are skipped). Chunks scoring 0 (no query token) are not hits; a chunk without tokens is never a BM25 hit. An index without chunks returns no hits. The expression above is the reference operation order (left to right, as written, in IEEE-754 doubles); `ln` is the natural logarithm.

**Hash embedder** (`hashEmbed(text, dim = 256) -> number[]`, `hashEmbedder(dim = 256)`; `dim` an integer `>= 1`, validated by these functions themselves: `hashEmbed` throws `RagError(invalid_options)` on a bad `dim`, and `hashEmbedder` throws it at construction, before any `embed` call).

1. `v` = `dim` zeros.
2. For each token of `tokenize(text)` (so folded), in order: `w` = the code points `<`, the token's code points, `>`. For every `i` from 0 to `len(w) - 3`, the *window* is `w[i], w[i+1], w[i+2]`. A one-code-point token gives exactly one window; the whole token is NOT added on top of the windows. Every window occurrence counts (repeats add up).
3. For each window: encode its three code points as UTF-8 by hand (1 to 4 bytes each; a lone surrogate encodes as U+FFFD, bytes `EF BF BD`); hash the bytes with FNV-1a 32-bit: `h = 0x811C9DC5`; for each byte `h = h XOR byte`, then `h = (h * 0x01000193) mod 2^32`; `h` is an unsigned 32-bit integer. `bucket = h mod dim` (unsigned); `sign = +1` if bit 31 of `h` is 0, else `-1`; `v[bucket] += sign`. These sums are small integers, exact in both languages.
4. L2-normalize: `s = sum of v[i]^2` for `i` from 0 to `dim - 1` (in that order); if `s = 0` the vector stays the zero vector; else `v[i] = v[i] / sqrt(s)` for every `i`.

A text with no tokens embeds to the zero vector. FNV-1a check values: the empty input gives `0x811C9DC5`, the byte `a` gives `0xE40C292C`, `foobar` gives `0xBF9CF968`.

**Embedder interface and dense retrieval.** `Embedder.embed(texts) -> vectors` is asynchronous and returns one vector per text. `buildIndex(documents, { chunking, embedder? })` validates the documents and the chunking, chunks every document, and, when an embedder is given and the index has at least one chunk, calls `embed` ONCE with the texts of all chunks in index order; the result must have exactly one vector per chunk and all vectors the same length, else `RagError(invalid_embedding)`, thrown by `buildIndex` itself (eagerly, whatever mode is searched later). A dense search embeds the query with ONE call `embed([query])`; the result must be exactly one vector with the length of the chunk vectors, else `invalid_embedding` (clarification 10). `score(c) = sum over d of q[d] * v_c[d]` for `d` from 0 to the length minus 1, in that order, on the vectors as the embedder returned them (no renormalization; with the hash embedder they are unit vectors, so this is the cosine). Chunks with score `<= 0` are not hits.

**Hybrid (reciprocal-rank fusion).** Compute the full BM25 ranking and the full dense ranking (hits only, ordered as below), cut each at `candidates` (when absent, 50). Every chunk present in at least one cut list gets `score = (1 / (60 + bm25Rank) if in the BM25 list, else 0) + (1 / (60 + denseRank) if in the dense list, else 0)`, ranks 1-based within each cut list, the BM25 term first. `k = 60` is fixed. The fused list is ordered as below, then cut at `topK`. A hybrid hit carries `bm25Rank` / `denseRank` exactly when the chunk is in that cut list (absent otherwise).

**Ranking and ties.** Hits are ordered by descending score; only EXACTLY equal doubles tie (no tolerance), and ties are broken by ascending index order. `rank` is the 1-based position after this order and the `topK` cut. `topK` is an integer `>= 1`, default 5. A hit is `{ chunkId, docId, rank, score }`, plus `bm25Rank?` and `denseRank?` in hybrid mode only.

**`search(index, query, { mode, topK?, candidates? })`.** `mode` is `"bm25"`, `"dense"` or `"hybrid"`. `topK` absent means 5 (the *effective* `topK`). `candidates` is optional (`undefined` in TypeScript, `Int? = null` in Kotlin) and is used and validated ONLY in `hybrid` mode: there it must be an integer `>= 1` and `>= ` the effective `topK`; in `bm25` and `dense` mode it is ignored entirely, even if it is `0`. An absent `candidates` means 50 and is never compared with `topK` (`topK: 60` alone is valid). Order of steps: validate the options (clarification 12); `dense`/`hybrid` on an index built without an embedder → `RagError(no_embedder)`, checked before every early return below; a query without tokens → no hits, in every mode, without calling the embedder; an index without chunks → no hits, without calling the embedder; otherwise rank as above.

**Context composition: `composeContext(hits, index, { maxTokens, counter? })`.** `maxTokens` an integer `>= 1`. The result is ONE `system` message whose content is pinned exactly:

```
RAG_INSTRUCTION + "\n\n" + "[1] " + text1 + "\n\n" + "[2] " + text2 + ... (no trailing newline)
```

where `textN` is the chunk text of the N-th kept hit and

```
RAG_INSTRUCTION = "Answer the question using only the numbered sources below. Cite the sources you use as [n]. If the sources do not contain the answer, say so."
```

(141 code points, ASCII only; copy it verbatim). With no kept source the content is `RAG_INSTRUCTION` alone (no blank line). The cost of the message is `counter(message)`, by default `context`'s `4 + ceil(codePoints(content) / 4)`; *fits* means `cost <= maxTokens`. Walk the hits in ARRAY order (the order of the `hits` argument; `hit.rank` is never read, and hits are never re-sorted): the hit at 1-based position `k` is kept (as source `n = k`) if the message with sources `1..k` fits; the first hit that does not fit stops the walk (no skipping; later hits are dropped even if shorter). If not even the first hit fits: `RagError(budget_too_small)` with `required` = the cost of the message with that first source. With empty hits the message is `RAG_INSTRUCTION` alone, `sources: []`, `droppedCount 0`, provided it fits; otherwise `budget_too_small` with `required` = its cost (40 with the default counter; clarification 11). Result: `{ message, sources: [{ n, chunkId, docId }], droppedCount }` with `droppedCount = hits.length - sources.length`. The user message with the query is NOT charged to `maxTokens`.

**Citations: `extractCitations(answer, sources)`.** A *marker* is exactly `[`, then 1 to 9 ASCII digits (`0-9` only) whose first digit is not `0`, then `]`; its value `n` is that decimal integer (so `n >= 1`). Scan the answer and try a marker at every `[` (clarification 13). `[1,2]`, `[ 1 ]`, `[1 ]`, `[01]`, `[0]`, `[]`, `[-1]`, `[+1]`, markers with Unicode digits and ten or more digits are not markers. List the marker values in order of first appearance, deduplicated (never sorted numerically); `cited` = those equal to the `n` of some source (membership in the set of the sources' `n`, not `n <= sources.length`), `unknown` = the others (same first-appearance order). The two lists are disjoint. Adjacent markers (`[1][2]`) are separate markers.

**Retrieval metrics: `retrievalMetrics(hits, relevant, { level? })`.** `level` is `"chunk"` (default) or `"doc"`; `relevant` is a non-empty set of chunk ids (or document ids), duplicates counted once (clarification 14). The hits are taken in ARRAY order (position `k` is rank `k`; `hit.rank` is never read and the hits are never re-sorted). The *list* is the hits' `chunkId`s in that order, or at `"doc"` level their `docId`s deduplicated keeping the first (best-ranked) occurrence. Then, as IEEE-754 doubles with one division each:

```
recallAtK      = (number of distinct relevant ids present in the list) / |relevant|
precisionAtK   = (number of list entries that are relevant) / (length of the list)     0 when the list is empty
reciprocalRank = 1 / (1-based position of the first relevant entry)                    0 when there is none
hit            = (there is a relevant entry)
```

`precisionAtK` divides by the number of hits, not by `topK`. At chunk level the hits are not deduplicated.

**`answerWithSources(provider, index, query, { mode, topK?, candidates?, maxTokens })`.** Validate every option (those of `search` and `maxTokens`) before any work; `search`; `composeContext`; then exactly ONE `provider.complete(request)` where `request` is `{ messages: [ { role: "system", content: <composed content> }, { role: "user", content: query } ] }` with no other field (no `maxTokens`). Result `{ answer: reply.text (verbatim: no trimming or any other change), sources (the KEPT sources of `composeContext`, not one per hit), citations: extractCitations(reply.text, sources), hits }`. A `RagError` (options, `no_embedder`, `invalid_embedding`, `budget_too_small`, including `budget_too_small` for empty hits with `maxTokens < 40`) is thrown before the call (zero calls). A provider error (`rate_limit`, `timeout`, `invalid_output`, `unavailable`, including `unavailable` from an exhausted mock script) propagates unchanged after the one call; there are no retries.

**Errors.** `RagError(kind)` (a TypeScript class / a Kotlin exception) with `kind` one of `invalid_options`, `no_embedder`, `invalid_embedding`, `budget_too_small`; `required` (an integer) is present for `budget_too_small` only. Option rules, each `invalid_options`: document ids non-empty and unique; `size`, `maxSize`, `topK`, `maxTokens`, `dim`, `candidates` integers `>= 1`; `overlap` an integer with `0 <= overlap < size`; in `hybrid` mode only, a given `candidates` `>= ` the effective `topK`; a known chunking `type`, `mode` and `level`; `relevant` non-empty. A JSON number that is not an integer by value (`2.5`) where an integer is required is invalid in both languages. Integers above 2^31 − 1 are out of scope (Kotlin `Int`); no fixture uses them. Typed APIs may additionally throw `RangeError` / `IllegalArgumentException` for programmer errors that fixtures cannot express.

## Fixture format

`contracts/rag/<name>.json`:

```json
{
  "name": "bm25-exact-tie-index-order",
  "setup": {
    "kind": "search",
    "documents": [{ "id": "zeta", "text": "rojo verde" }, { "id": "alfa", "text": "verde rojo" }],
    "chunking": { "type": "paragraph", "maxSize": 100 },
    "query": "rojo",
    "mode": "bm25"
  },
  "expect": {
    "hits": [
      { "chunkId": "zeta#0", "docId": "zeta", "rank": 1, "score": 0.1823215567939546 },
      { "chunkId": "alfa#0", "docId": "alfa", "rank": 2, "score": 0.1823215567939546 }
    ]
  }
}
```

(This is the real `bm25-exact-tie-index-order.json`, only reformatted. Every file is exactly `JSON.stringify(fixture, null, 2) + "\n"`: 2-space indentation, LF, trailing newline; there are no literal-number exceptions in this folder. Lone surrogates are written as JSON escapes such as `"\ud800"`; parsers must turn them into the lone UTF-16 unit.)

Top-level keys: `name` (equal to the file name), `setup`, `expect`. `setup.kind` selects what runs:

| `kind` | `setup` keys (`?` optional) | Runs | `expect` |
|---|---|---|---|
| `tokens` | `text` | `tokenize(text)` | `{ tokens }` |
| `chunk` | `documents`, `chunking` | `buildIndex(documents, { chunking })` without embedder; compares `index.chunks` | `{ chunks: [{ id, docId, index, text, start, end }] }` |
| `embed` | `text`, `dim?` (default 256) | `hashEmbed(text, dim)` | `{ nonZero: [[bucket, value], ...] }` |
| `search` | `documents`, `chunking`, `embedder?`, `query`, `mode`, `topK?`, `candidates?` | `buildIndex` then `search` | `{ hits: [{ chunkId, docId, rank, score, bm25Rank?, denseRank? }] }` |
| `context` | the `search` keys plus `maxTokens` | `buildIndex`, `search`, `composeContext(hits, index, { maxTokens })` | `{ message: { role, content }, sources: [{ n, chunkId, docId }], droppedCount }` |
| `citations` | `sources` (an array of `n`), `answer` | `extractCitations(answer, sources)` with sources `{ n, chunkId, docId }` built by the harness (only `n` matters) | `{ cited, unknown }` |
| `metrics` | `hits` (`[{ chunkId, docId }]`, in rank order), `relevant`, `level?` | `retrievalMetrics(hits, relevant, { level })` (ranks are the positions) | `{ recallAtK, precisionAtK, reciprocalRank, hit }` |
| `eval` | `documents`, `chunking`, `embedder`, `topK`, `questions: [{ query, relevant, level? }]` | for each question, for `bm25`, `dense`, `hybrid` in that order: `search(index, query, { mode, topK })`, then `retrievalMetrics(hits, relevant, { level })` | `{ questions: [{ modes: { bm25, dense, hybrid } }] }`, each mode `{ hitIds, recallAtK, precisionAtK, reciprocalRank, hit }` |
| `answer` | the `search` keys plus `maxTokens`, `provider: { script }` | `buildIndex`, then `answerWithSources(provider, index, query, { mode, topK?, candidates?, maxTokens })` | `{ answer, sources, citations: { cited, unknown }, hitIds, calls, request: { system, user } }` |

- Any kind may instead expect `{ "error": { "kind": <kind>, "required"?: <int> } }`; an `answer` fixture then has `{ "error", "calls", "request"? }`, where `error.kind` may also be a provider error kind (`rate_limit`, `unavailable`, …; `retryAfterMs` is never compared). These are the `invalid-*` fixtures and the error cases of the other areas; every `invalid-*` fixture breaks exactly one rule, except `invalid-size-zero` (`size: 0` necessarily also breaks `overlap < size`).
- `request` (in `answer` fixtures, present exactly when `calls > 0`, also for a failing call) is the EXPECTED provider request written out: `system` is the exact composed system content, `user` the query.
- `documents` entries are `{ id, text }`. `chunking` is `{ "type": "fixed", "size", "overlap" }` or `{ "type": "paragraph", "maxSize" }`.
- `embedder` is absent (no embedder), `{ "type": "hash", "dim"? }` (the harness calls `hashEmbedder(dim)`, default 256, before `buildIndex`; a bad `dim` therefore surfaces as the `RagError(invalid_options)` thrown by `hashEmbedder` at construction) or `{ "type": "script", "responses": [...] }`: a test embedder with fresh state per fixture whose call N (1-based, counting every call: the one in `buildIndex` and the query calls) returns `responses[N-1]` verbatim (an array of vectors, each an array of numbers), whatever the input. Fixtures never call it more often than `responses` has entries.
- `provider` is a `providers` mock: call N consumes `script[N-1]`, an entry is `{"response": "<text>"}` or `{"error": {"kind": ...}}`, and once the script is exhausted every call fails with `unavailable` (`script: []` fails on the first call). Its id is not pinned.
- In `eval`, every question uses the same index (built once) and the default `candidates`; `hitIds` are the hits' chunk ids in rank order.

## Comparison and harness

- `tokens`, `chunks`, `citations`: exact deep equality, in order (strings compared unit by unit).
- `nonZero`: the actual vector's entries that are not exactly `0`, as `[bucket, value]` in ascending bucket order; same length and buckets as expected, each value within `1e-9` absolute.
- `hits`: same length; `chunkId`, `docId`, `rank` exact; `score` within `1e-9` absolute; `bm25Rank` and `denseRank` present exactly when the expected hit has them, and then equal.
- `context`: `message` (role and content) exact; `sources` exact deep equality; `droppedCount` exact.
- `metrics` and every metric in `eval`: compared as IEEE-754 double values exactly (fixtures write the shortest round-trip literal: `0.3333333333333333`, `0.6666666666666666`, …); `hit` exact; `hitIds` exact.
- `answer`: `answer` (verbatim), `sources`, `citations`, `hitIds` and `calls` exact (`calls` counts every `complete()` invocation, including a failing one). The harness wraps the provider to record requests: when `expect.request` is present, exactly one request was recorded and it is exactly `{ messages: [ { role: "system", content: expect.request.system }, { role: "user", content: expect.request.user } ] }` (no other fields anywhere); when it is absent, no request was recorded.
- `error`: `kind` exact; `required` exact when the expected error has it (every `budget_too_small` fixture has it); for `answer` fixtures also `calls` and `request` as above.
- Unknown keys are rejected on the raw JSON (before any typed parsing): the top level accepts only `name`, `setup`, `expect`; `setup` only `kind` and its kind's keys from the table above; a document only `id`, `text`; a known chunking type only its own keys (`type`, `size`, `overlap` / `type`, `maxSize`); an embedder only `type`, `dim` (hash) or `type`, `responses` (script); `provider` only `script`; a question only `query`, `relevant`, `level`; a metrics hit only `chunkId`, `docId`; `expect` only the keys of its kind (or `error`, plus `calls` and `request` for `answer`); `expect.request` only `system`, `user`. Every expected key is compared.
- Values that a typed API cannot represent (an unknown `mode`, `level` or chunking `type`, a non-integer number; `candidates` only in `hybrid` mode, where it is parsed) are converted through a library parse function that throws `RagError(invalid_options)`, so the `invalid-*` fixtures see the library's error, not a harness error.
- Guard: the test asserts `fixtures.length >= 144`. Kotlin aggregates all failures and reports them together.

## Malformed fixtures

`runFixture` fails with the explicit error `invalid fixture: <reason>` (an `Error` in TypeScript, an `IllegalStateException` in Kotlin) when the fixture itself is unusable: an unknown `setup.kind` (`unknown setup kind: <kind>`), an unknown key (as above), a script entry whose `error.kind` is not one of `rate_limit`, `timeout`, `invalid_output`, `unavailable`, citation `sources` that are not integers, a script entry with neither `response` nor `error` (`script entry <n> of provider <id> has neither response nor error`, `n` 1-based), an unknown embedder `type`, a `script` embedder called more often than it has responses or with a `responses` entry that is not an array of arrays of numbers, a missing required key (a document without `id` or `text`, a `fixed` chunking without `size` or `overlap`, a `paragraph` chunking without `maxSize`, a missing `query`, `mode`, `maxTokens`, `provider`, …), or an `expect` that has neither the keys of its kind nor `error`. A missing key is a malformed fixture, never `invalid_options`: the `invalid-*` fixtures always carry every required key, with a bad value.

## Clarifications

These make the Rules exact where two implementations could otherwise differ. They do not change the design (items 2 and 11 also correct the design's wording, see there).

1. **Code points.** Walk the UTF-16 string: a high surrogate (`D800-DBFF`) immediately followed by a low surrogate (`DC00-DFFF`) is one code point; every other unit is one code point, lone surrogates included. A lone surrogate in a token or chunk text is kept as the same lone unit. Pinned by `tokens-lone-surrogate`, `chunk-lone-surrogate` and `chunk-emoji-offsets`.
2. **Tokenizer procedure and the Latin-1 ranges.** The separator test uses the ORIGINAL code point; folding is per word code point; replacements of more than one letter (`ss`, `ae`, `th`) are inserted in place. Folding never produces a separator. The table covers upper AND lower case of every group: all 62 letters U+00C0 to U+00FF except `×` and `÷` (the design's list was shorthand). U+00A0 to U+00BF are ALL separators, including the letter-like `ª`, `º`, `µ`, `¹`, `²`, `³`, `¼`, `½`, `¾`; implement the separators as the pinned RANGES, not as a list of familiar punctuation. Pinned by `tokens-latin1-table-complete`, `tokens-latin1-letterlike-separators`, `tokens-sharp-s-and-ligature`, `tokens-separator-range-edges`.
3. **ASCII word characters are exactly `[0-9A-Za-z]`.** `_`, `'`, `-`, `.`, `/` and every other ASCII symbol separate; `it's` gives `it`, `s`. Do not use Unicode-aware tests (`\w`, `isLetterOrDigit`, `isLetter`, `isDigit`, `lowercase()`, `toLowerCase()`). Pinned by `tokens-punctuation-separators`, `tokens-outside-table-kept`.
4. **Line breaks and runs.** CRLF is recognised greedily from the left, so `\r\r\n` is an ordinary CR followed by one CRLF, and `\n\r\n` is two line breaks. Line breaks separated by any other code point (`\n \n`, `\n\t\n`) are separate runs of one, so they do not separate paragraphs. A single line break (LF or CRLF) at offset 0 or ending at `L` is a separator. Pinned by `chunk-paragraph-cr-before-crlf`, `chunk-paragraph-spaced-breaks-not-separator`, `chunk-paragraph-mixed-break-run`, `chunk-paragraph-leading-trailing-breaks`, `chunk-lone-cr-is-ordinary`.
5. **Whitespace-only paragraphs and packing.** Whitespace means exactly space, tab, CR and LF (a paragraph may contain a single LF and still be whitespace-only; an NBSP-only paragraph is NOT whitespace-only and becomes a chunk). Whitespace-only paragraphs are dropped before packing. The length tested when packing is `b - packStart` on the original text, separators included; a dropped paragraph between two packed paragraphs is inside the slice, but a dropped paragraph never starts, extends or ends a pack. `<= maxSize` packs. Pinned by `chunk-paragraph-nbsp-not-whitespace`, `chunk-paragraph-whitespace-with-inner-lf`, `chunk-paragraph-whitespace-dropped-before-packing`, `chunk-paragraph-dropped-inside-pack`, `chunk-paragraph-exact-max-size`, `chunk-paragraph-crlf-offsets`.
6. **Fixed windows.** The loop stops after the window that reaches `L`; `overlap = 0` with `L` a multiple of `size` gives no empty trailing window; a text shorter than `overlap` still gives one window (do not loop while `s < L - overlap`). The pieces of an oversized paragraph follow the same rule with `size = maxSize`, `overlap = 0`. Pinned by `chunk-fixed-no-contained-window`, `chunk-fixed-exact-multiple`, `chunk-fixed-text-shorter-than-overlap`, `chunk-paragraph-oversized-flushes`.
7. **Shapes and integers.** Integers are judged by value (`2.5` is not an integer); no fixture writes an integral float such as `2.0`, so the Kotlin parser needs no literal-number special case here. Integers above 2^31 − 1 are out of scope. A chunking `type` other than `fixed`/`paragraph` is `invalid_options`. A MISSING required key (a `fixed` chunking without `overlap`, a document without `text`, …) is a malformed fixture (`invalid fixture: …`), not `invalid_options`. Pinned by `invalid-non-integer-size`, `invalid-non-integer-overlap`, `invalid-non-integer-topk`, `invalid-non-integer-dim`, `invalid-unknown-chunking-type`.
8. **`topK` and `candidates`.** `topK` absent means 5 in every mode. `candidates` is used and validated ONLY in `hybrid`: there a given value must be an integer `>= 1` and `>= ` the effective `topK` (the explicit `topK`, or 5 when absent). In `bm25` and `dense` mode it is ignored, even when invalid (`candidates: 0`). An absent `candidates` is `undefined` / `null` (Kotlin `Int? = null`), its effective value is 50, and it is never compared with `topK` (with `topK > 50` the fused list can still hold up to 100 chunks). Pinned by `invalid-candidates-less-than-topk`, `invalid-candidates-below-default-topk`, `bm25-ignores-candidates`, `hybrid-candidates-cut`, `hybrid-default-candidates-with-large-topk`, `hybrid-default-candidates-fifty`, `bm25-default-topk-five`.
9. **Dense score.** The score is the plain dot product of the stored chunk vector and the query vector as the embedder returned them: an embedder that returns non-unit vectors gets non-cosine scores, and negative or zero scores are never hits. Pinned by `dense-custom-embedder-dot-product`, `dense-negative-score-excluded`, `dense-zero-score-excluded`.
10. **Embedder calls and validation.** `buildIndex` makes one `embed` call (all chunk texts, index order) only when an embedder is given and there is at least one chunk, and validates the result itself, eagerly: a wrong count or ragged vectors fail `buildIndex` with `invalid_embedding` even if only `bm25` is searched later. A search makes one `embed([query])` call only in `dense`/`hybrid` mode, when the query has tokens and the index has chunks. Vector lengths are checked only for equality (between chunk vectors, and between the query vector and the chunk vectors). The fixture `script` embedder has fresh state per fixture; call N (counting the build call and every query call) returns `responses[N-1]` verbatim; calling it more often than it has responses, or a `responses` entry that is not an array of numeric arrays, is a malformed fixture. Pinned by `invalid-embedding-wrong-count`, `invalid-embedding-ragged`, `invalid-embedding-query-count`, `invalid-embedding-query-length`, `invalid-embedding-checked-at-build`.
11. **Empty hits and the budget.** The composed message must always fit: with empty hits, `RAG_INSTRUCTION` alone (cost 40 with the default counter) needs `maxTokens >= 40`, otherwise `budget_too_small` with `required` = the cost of the instruction message (40). In `answerWithSources` this happens before the provider call: zero calls. Pinned by `context-empty-hits`, `context-empty-hits-budget-too-small`, `answer-no-hits-budget-too-small`.
12. **Validation comes first; who raises what.** Every operation validates all its options before doing any work (chunking, embedding, ranking, provider call): `buildIndex` the documents and the chunking; `hashEmbed` / `hashEmbedder` their own `dim` (`hashEmbedder` at construction, so a fixture `{ "type": "hash", "dim": 0 }` fails when the harness builds the embedder, before `buildIndex`); `search` `mode`, `topK`, `candidates` (hybrid only), then `no_embedder`, which is checked BEFORE the early returns for a query without tokens or an empty index; `composeContext` `maxTokens`; `answerWithSources` all of these before searching. Each `invalid-*` fixture breaks exactly one rule, except `invalid-size-zero` (`size: 0` necessarily also breaks `overlap < size`; both are `invalid_options`), so the order among `invalid_options` checks is not observable; `invalid_options` before `no_embedder` is pinned by unit tests. Pinned by `invalid-answer-validated-before-call`, `invalid-hash-dim-zero-in-search`, `dense-no-embedder-query-without-tokens`.
13. **Citation scan.** At every `[` (position `i`), read the maximal run of ASCII digits (`0-9` only; Arabic-Indic, fullwidth and other Unicode digits are not digits) starting at `i + 1`; it is a marker when the run has 1 to 9 digits, the first is not `0`, and the code point after the run is `]`. Whatever the outcome, scanning continues at `i + 1`, so `[[2]]` contains `[2]`, `[3[1]]` contains `[1]` and `[1][2]` contains both. Nine digits fit in a 32-bit integer. `cited` and `unknown` keep first-appearance order (`unknown` is never sorted); `cited` means membership in the sources' `n` values. Pinned by `citations-bracket-rescan`, `citations-adjacent-markers`, `citations-ten-digits`, `citations-not-markers`, `citations-unicode-digits-not-markers`, `citations-unknown-first-appearance-order`, `citations-membership-not-count`.
14. **Metric sets and order.** `|relevant|` counts distinct ids. The hits are used in ARRAY order (position = rank; `hit.rank` is not read). Hits are deduplicated only at `"doc"` level (by `docId`, FIRST occurrence kept, so `a, b, a, c` becomes `a, b, c`). An id in `relevant` that is a document id never matches at chunk level. Pinned by `metrics-relevant-duplicates-collapsed`, `metrics-doc-level-dedupe`, `metrics-chunk-level-default`, `eval-three-modes` (its last question has the doc pattern `es-biblioteca, es-taller, es-biblioteca` in `bm25` mode).
15. **Float parity.** Both languages use IEEE-754 doubles, `ln`/`sqrt` from the platform, and the operation orders given in the Rules (BM25 terms in first-appearance order, the BM25 expression left to right, embedding sums and dot products in dimension order, division by `sqrt(s)` component by component, the BM25 RRF term before the dense one). Scores are compared with `1e-9`; ranks exactly. Within every ranking a fixture computes (including the full lists behind a `topK` or `candidates` cut): two different scores are more than `1e-9` apart; every exact tie is a tie by construction (identical token statistics, identical vectors, or the same set of RRF terms), never a numerical coincidence; and every dense score that is excluded for being `0` is zero by construction (the query and the chunk share no non-zero bucket), never a sum of terms that happens to cancel in one summation order.
16. **No normalization of the query or the chunks beyond tokenization.** `PRESTAMO` matches `préstamo` through folding; `cafe` + U+0301 does not match `café`. Pinned by `bm25-folded-match`, `tokens-combining-mark-kept`, `embed-folded-before-hashing`.
17. **`composeContext` uses array order.** It walks `hits` in the order given and numbers the sources by 1-based position; it never reads `hit.rank` and never re-sorts (the fixtures always pass `search` results, whose array order equals rank order, so this is also pinned by unit tests).
18. **`answerWithSources` results.** `answer` is the reply text verbatim (`"  You need a library card [1].\n"` stays as is); `sources` are the kept sources of `composeContext` (fewer than the hits when the budget drops some, so a marker for a dropped hit is `unknown`); a provider error kind (`rate_limit`, `unavailable`, …) is reported as `error.kind` in `answer` fixtures, and `retryAfterMs` is not compared. Pinned by `answer-reply-verbatim`, `answer-drops-source`, `answer-provider-error`, `answer-exhausted-script`.
19. **`null` is a bad value, never "absent".** JSON `null` for an option (`topK`, `candidates` in `hybrid`, `mode`, `level`, `dim`, `size`, `overlap`, `maxSize`, `maxTokens`) is `invalid_options`; only an absent key (TypeScript `undefined`, Kotlin `null` default) means "absent". `candidates` outside `hybrid` is ignored even when `null`. Unit-test rule, no fixture.
20. **Harness typing.** The harness checks JSON types before calling the library: a document `id`/`text`, `query`, `text` or `answer` that is not a string, a numeric option that is neither a number nor `null`, a `mode`/`level` that is neither a string nor `null`, a chunking `type` that is not a string (`null` included), a `relevant` that is not an array of strings, citation sources that are not integers, a script entry whose `response` is not a string or whose `error.kind` is not a string, a script entry or error with keys other than `response`/`error` and `kind`/`retryAfterMs`, and an unknown `setup.kind` (including names such as `constructor` or `__proto__`) are MALFORMED FIXTURES (`invalid fixture: <reason>`). The typed library functions still validate at runtime and throw `invalid_options` for programmer errors that fixtures cannot express.
21. **Source `docId`.** `composeContext` takes each source's `chunkId` and `docId` from the index chunk found by `hit.chunkId`; a `chunkId` that is not in the index is a programmer error (`RangeError` in TypeScript, `IllegalArgumentException` in Kotlin). Unit-test rule.
22. **Embedding vectors are finite.** A vector with a non-finite entry (NaN, infinity) or, in TypeScript, a sparse array is `invalid_embedding`, at build and for the query. Unit-test rule.

## Pinned by unit tests, not fixtures

- `invalid_options` is reported before `no_embedder` when both apply; options are validated before `buildIndex`/`search` do any work.
- `buildIndex` does not call the embedder for an index without chunks; `search` does not call it for a query without tokens or for `bm25` mode.
- `composeContext` and `retrievalMetrics` use the array order of the hits they are given (a hand-built list whose `rank` fields disagree with its order).
- A custom `counter` passed to `composeContext` is used for every cost, including `required`.
- The hand-written UTF-8 encoder (1 to 4 bytes, lone surrogate → `EF BF BD`) and FNV-1a check values above.
- Inputs (documents, hits, sources) are not mutated; `CancellationException` (Kotlin) and non-provider exceptions propagate unchanged from `answerWithSources`.

## Sample corpus

The `town` corpus (four short documents written for this repo, two in Spanish and two in English, chunked with `paragraph { maxSize: 120 }` into one chunk per paragraph) is shared by the search, context, eval and answer fixtures and by the demos:

| Chunk | Offsets | Content |
|---|---|---|
| `es-biblioteca#0` / `#1` / `#2` | `[0, 102)`, `[104, 211)`, `[213, 292)` | opening hours; borrowing with the reader card (three-week loan); lost card |
| `en-library#0` / `#1` / `#2` | `[0, 103)`, `[105, 196)`, `[198, 274)` | the same three topics in English |
| `es-taller#0` / `#1` | `[0, 93)`, `[95, 169)` | the neighbourhood bike workshop; repair prices |
| `en-garden#0` / `#1` / `#2` | `[0, 75)`, `[77, 156)`, `[158, 200)` | the community garden lends tools; volunteers; bring gloves |

## Costs used by the fixtures

Default counter, `4 + ceil(codePoints / 4)` on the whole composed content.

| Message | Code points | Cost |
|---|---|---|
| `RAG_INSTRUCTION` alone (`context-empty-hits`, `answer-no-hits-still-calls`, `answer-no-hits-budget-too-small`) | 141 | 40 |
| `context-stops-at-first-misfit` with `[1] Faro.` / plus the long source / plus all three | 152 / 244 / 281 | 42 / 65 / 75 (budget 52) |
| `context-stops-at-first-misfit` if the long source were skipped (`[1] Faro.` + `[2] Un faro rojo…`) | 189 | 52 |
| `context-cost-code-points` (12 astral emoji; UTF-16 would count 178 units, cost 49) | 166 | 46 (budget 46) |
| `context-separators-exact` with one / two / three sources | 151 / 168 / 190 | 42 / 46 / 52 |
| `context-budget-exact` with one / two / three sources | 199 / 229 / 266 | 54 / 62 / 71 (budget 62) |
| `answer-budget-too-small-after-no-call`, first source `en-library#1`; also the system message of `answer-reply-verbatim` | 238 | 64 |
| `context-first-source-too-big`, first source `es-biblioteca#1` | 254 | 68 |
| `answer-drops-source` with two / three sources | 353 / 438 | 93 / 114 (budget 93) |
| `context-basic`, two sources | 339 | 89 |

## Fixtures

144 fixtures. "Expected" summarises the expectation (chunk spans as `[start, end)`; hybrid hits as `(bRank/dRank)`, `-` when absent; metrics as R, P, RR; context costs as cost / `maxTokens`). Exact values are in the files.

| Fixture | Kind | Rule it pins | Expected |
|---|---|---|---|
| `tokens-ascii-fold` | `tokens` | ASCII `A-Z` fold to `a-z`; every other ASCII character that is not a letter or digit separates | `hello`, `world`, `mixed`, `case` |
| `tokens-digits` | `tokens` | ASCII digits are word code points (`101`, `9am`, `v2`) | `room`, `101`, `opens`, `at`, `9am`, `v2` |
| `tokens-punctuation-separators` | `tokens` | ASCII punctuation separates, including `-`, `'`, `_`, `/`, `.` (clarification 3) | `state`, `of`, `the`, `art`, `it`, `s`, `really`, `snake`, `case`, `path`, `v1` |
| `tokens-spanish-accents-fold` | `tokens` | the Latin-1 table folds Spanish accents and `ñ`/`ü` (upper and lower case) | `cancion`, `arbol`, `pinguino`, `y`, `nandu` |
| `tokens-spanish-inverted-marks` | `tokens` | `¿` and `¡` (U+00BF, U+00A1) separate, so `¿Qué` gives `que` | `que`, `hora`, `es`, `ya` |
| `tokens-sharp-s-and-ligature` | `tokens` | multi-letter replacements: `ß` → `ss`, `Æ`/`æ` → `ae`, `Þ` → `th`, `ð` → `d` | `strasse`, `aesir`, `aether`, `thorr`, `de` |
| `tokens-nbsp-and-general-punctuation` | `tokens` | NBSP, `«`, `»`, `·` and General Punctuation (em dash, curly quotes, ellipsis, thin space) separate | `uno`, `dos`, `tres`, `cuatro`, `cinco`, `seis`, `siete`, `ocho`, `nueve` |
| `tokens-outside-table-kept` | `tokens` | code points outside the table are kept as is: no Unicode case folding (`Ł`, `ź`, `Œ`, `Ÿ`, Greek, CJK) | `Łodź`, `Œuvre`, `Ÿ`, `日本語`, `Σοφία` |
| `tokens-lone-surrogate` | `tokens` | a lone surrogate is a word code point (high or low; a low followed by a high is two lone surrogates) | `a\ud800b`, `\udc00`, `x\ud83d`, `\ude00\ud83d` |
| `tokens-separator-range-edges` | `tokens` | range edges: U+009F, U+00C0, U+1FFF, U+2070 are word code points; U+00BF, U+00D7, U+00F7, U+2000, U+206F separate | `a\u009fb`, `c`, `d`, `eaf`, `g`, `h`, `i`, `j`, `k\u1fffl`, `m`, `n`, `o`, `p`, `q\u2070r` |
| `tokens-combining-mark-kept` | `tokens` | no normalization: `e` + U+0301 stays two code points (the mark is a word code point), unlike the precomposed `é` | `cafe\u0301`, `cafe` |
| `tokens-latin1-table-complete` | `tokens` | the whole folding table: the 62 letters U+00C0 to U+00FF (without `×`, `÷`), upper and lower case, in code point order | `a`, `a`, `a`, `a`, `a`, `a`, `ae`, `c`, `e`, `e`, `e`, `e`, `i`, `i`, `i`, `i`, `d`, `n`, `o`, `o`, `o`, `o`, `o`, `o`, `u`, `u`, `u`, `u`, `y`, `th`, `ss`, `a`, `a`, `a`, `a`, `a`, `a`, `ae`, `c`, `e`, `e`, `e`, `e`, `i`, `i`, `i`, `i`, `d`, `n`, `o`, `o`, `o`, `o`, `o`, `o`, `u`, `u`, `u`, `u`, `y`, `th`, `y` |
| `tokens-latin1-letterlike-separators` | `tokens` | clarification 2: the letter-like `ª`, `º`, `µ`, `¹`, `²`, `³`, `¼`, `½`, `¾` are in U+00A0 to U+00BF, so they separate | `1`, `2`, `n`, `5`, `m`, `x`, `a`, `b`, `c`, `d`, `e` |
| `tokens-separators-only` | `tokens` | a text made only of separators has no tokens | no tokens |
| `chunk-fixed-basic` | `chunk` | `fixed`: windows of `size` code points advancing by `size - overlap`; the last one is shorter | d#0 [0, 4), d#1 [4, 8), d#2 [8, 10) |
| `chunk-fixed-overlap` | `chunk` | `fixed` with overlap: step `size - overlap`; the last window ends at the end of the text | d#0 [0, 4), d#1 [2, 6), d#2 [4, 8), d#3 [6, 10) |
| `chunk-fixed-shorter-than-size` | `chunk` | a text shorter than `size` is one chunk | d#0 [0, 4) |
| `chunk-fixed-exact-multiple` | `chunk` | a length that is a multiple of `size` gives no empty trailing chunk | d#0 [0, 4), d#1 [4, 8) |
| `chunk-fixed-no-contained-window` | `chunk` | no window whose span is contained in the previous one: the window that reaches the end is the last | d#0 [0, 6), d#1 [2, 8), d#2 [4, 10) |
| `chunk-paragraph-pack` | `chunk` | `paragraph`: consecutive paragraphs are packed greedily while the original slice has `<= maxSize` code points | d#0 [0, 10), d#1 [12, 23) |
| `chunk-paragraph-oversized-flushes` | `chunk` | a paragraph longer than `maxSize` flushes the current pack, then is cut with `fixed { size: maxSize, overlap: 0 }` | d#0 [0, 3), d#1 [5, 10), d#2 [10, 15), d#3 [15, 17), d#4 [19, 22) |
| `chunk-paragraph-oversized-pieces-standalone` | `chunk` | the pieces of an oversized paragraph are never packed with the next paragraph (`ij` + `Yo.` would fit in 8) | d#0 [0, 8), d#1 [8, 10), d#2 [12, 15) |
| `chunk-paragraph-crlf-offsets` | `chunk` | CRLF is a line break of two code points: offsets count both, and a CRLF separator costs 4 code points in a pack | a#0 [0, 3), a#1 [7, 15), a#2 [19, 23), b#0 [0, 4), b#1 [8, 10) |
| `chunk-paragraph-whitespace-only-dropped` | `chunk` | a paragraph made only of space, tab, CR, LF is dropped (it never becomes a chunk) | d#0 [0, 3), d#1 [14, 17) |
| `chunk-paragraph-dropped-inside-pack` | `chunk` | clarification 5: a dropped paragraph between two packed paragraphs stays inside the original slice | d#0 [0, 11) |
| `chunk-paragraph-leading-trailing-breaks` | `chunk` | one line break (LF or CRLF) at the very start or end of the text is a separator and is excluded | a#0 [1, 9), b#0 [2, 6) |
| `chunk-lone-cr-is-ordinary` | `chunk` | a lone CR is an ordinary character, not a line break (`\r\r` does not separate paragraphs) | d#0 [0, 7), d#1 [7, 8), d#2 [10, 14) |
| `chunk-empty-document` | `chunk` | an empty document yields no chunks (and is valid); the next document's indexes start at 0 | b#0 [0, 3) |
| `chunk-emoji-offsets` | `chunk` | offsets are code points: an astral emoji counts 1 (UTF-16 would count 2) | d#0 [0, 4), d#1 [3, 7), d#2 [6, 10), d#3 [9, 13), d#4 [12, 14) |
| `chunk-lone-surrogate` | `chunk` | a lone surrogate is one code point and never swallows its neighbour; a valid pair is one code point | d#0 [0, 2), d#1 [2, 4), d#2 [4, 6), d#3 [6, 7) |
| `chunk-ids-and-indexes` | `chunk` | `id = docId + "#" + index`, index from 0 per document, documents in input order, no escaping of `#` in ids | doc-a#0 [0, 5), doc-a#1 [5, 10), doc-a#2 [10, 12), notes#2024#0 [0, 3) |
| `chunk-paragraph-spaced-breaks-not-separator` | `chunk` | clarification 4: line breaks separated by a space are not a run, so `\n \n` does not separate | d#0 [0, 4), d#1 [4, 8), d#2 [8, 9) |
| `chunk-paragraph-exact-max-size` | `chunk` | a pack whose slice has exactly `maxSize` code points is kept (`<=`) | d#0 [0, 7) |
| `chunk-paragraph-mixed-break-run` | `chunk` | a run of 2+ adjacent line breaks of any mix (LF, CRLF) is one separator | d#0 [0, 3), d#1 [7, 10), d#2 [13, 17) |
| `chunk-paragraph-whitespace-document` | `chunk` | a document whose paragraphs are all whitespace-only yields no chunks | no chunks |
| `chunk-paragraph-nbsp-not-whitespace` | `chunk` | clarification 5: only space, tab, CR, LF count as whitespace: an NBSP-only paragraph is kept as a chunk | d#0 [0, 3), d#1 [5, 6), d#2 [8, 11) |
| `chunk-paragraph-whitespace-with-inner-lf` | `chunk` | a whitespace-only paragraph may contain a single LF (LF is in the whitespace set): it is dropped | d#0 [0, 3), d#1 [10, 13) |
| `chunk-paragraph-whitespace-dropped-before-packing` | `chunk` | clarification 5: whitespace-only paragraphs are dropped BEFORE packing, so they never extend or start a pack | d#0 [0, 3), d#1 [8, 11) |
| `chunk-paragraph-cr-before-crlf` | `chunk` | clarification 4: CRLF is matched greedily from the left, so `\r\r\n\r\n` is an ordinary CR then a two-break separator | d#0 [0, 4), d#1 [8, 11) |
| `chunk-paragraph-empty-document` | `chunk` | `paragraph`: an empty document yields no chunks (and is valid) | b#0 [0, 5) |
| `chunk-fixed-text-shorter-than-overlap` | `chunk` | `fixed`: a text shorter than `overlap` still gives one chunk (the loop does not stop at `L - overlap`) | d#0 [0, 2) |
| `embed-one-code-point-token` | `embed` | a one-code-point token gives `w` of 3 code points: one window, counted once (the token is not added on top) | 1 non-zero: 56: -1 |
| `embed-repeated-token-adds` | `embed` | every window occurrence adds (repeats count like term frequency) before normalization | 3 non-zero: 28: 0.666667, 194: -0.333333, 228: 0.666667 |
| `embed-no-tokens-zero-vector` | `embed` | a non-empty text without tokens embeds to the zero vector (no entries) | zero vector |
| `embed-empty-string-zero-vector` | `embed` | the empty string embeds to the zero vector (no entries, no division by zero) | zero vector |
| `embed-utf8-two-and-three-bytes` | `embed` | 2- and 3-byte UTF-8 sequences (`ł`, `ź`, `日`, `本`) are encoded by hand before hashing | 6 non-zero: 49: 0.408248, 162: 0.408248, 170: -0.408248, 187: -0.408248, 189: -0.408248, 240: -0.408248 |
| `embed-known-word-buckets` | `embed` | FNV-1a 32-bit over the UTF-8 bytes of each 3-code-point window of `<hola>`, bucket `h % 256`, sign from bit 31 | 4 non-zero: 12: -0.5, 114: 0.5, 160: -0.5, 181: -0.5 |
| `embed-sign-collision` | `embed` | two windows in the same bucket with opposite signs cancel: the bucket is 0 and is not listed | 1 non-zero: 0: -1 |
| `embed-lone-surrogate-fffd` | `embed` | a lone surrogate is UTF-8 encoded as U+FFFD (`EF BF BD`) | 1 non-zero: 182: -1 |
| `embed-lone-low-surrogate-fffd` | `embed` | a lone LOW surrogate is also encoded as U+FFFD (`EF BF BD`), not as a 3-byte CESU sequence | 1 non-zero: 182: -1 |
| `embed-astral-utf8` | `embed` | an astral code point is one code point and 4 UTF-8 bytes (`😀` = `F0 9F 98 80`) | 1 non-zero: 148: 1 |
| `embed-dim-small` | `embed` | `dim` other than 256: buckets are `h % dim` (here 3) | 2 non-zero: 0: -0.894427, 1: 0.447214 |
| `embed-folded-before-hashing` | `embed` | the embedder hashes folded tokens: `HÓLA` embeds exactly like `hola` | 4 non-zero: 12: -0.5, 114: 0.5, 160: -0.5, 181: -0.5 |
| `bm25-basic-ranking` | `search` | BM25 ranking over the sample corpus (`k1 = 1.2`, `b = 0.75`), descending score | es-biblioteca#1, es-taller#0, es-biblioteca#2, es-biblioteca#0 |
| `bm25-single-chunk-idf` | `search` | `N = 1`, `n = 1`: idf = ln(1 + 0.5/1.5) = ln(4/3); with `len = avgLen` the score equals the idf | d#0 |
| `bm25-repeated-query-token` | `search` | a query token repeated in the query counts once | a#0 |
| `bm25-zero-score-excluded` | `search` | chunks that share no token with the query are not hits, even with `topK` larger than the hits | a#0 |
| `bm25-length-normalization` | `search` | with equal tf, the shorter chunk scores higher (length normalization; the longer chunk comes first in the index) | short#0, long#0 |
| `bm25-exact-tie-index-order` | `search` | exactly equal scores are ordered by index order (document order, not id order) | zeta#0, alfa#0 |
| `bm25-empty-chunk-counts-in-avglen` | `search` | a chunk without tokens counts in `N` and in `avgLen` (here `N = 3`, `avgLen = 5/3`) | a#0 |
| `bm25-query-without-tokens` | `search` | a query without tokens returns no hits | no hits |
| `bm25-topk-cut` | `search` | `topK` cuts the ranking after ordering | en-library#2, en-garden#0 |
| `bm25-folded-match` | `search` | folding applies to query and chunks alike: `PRESTAMO` matches `préstamo` | es-biblioteca#1 |
| `bm25-empty-index` | `search` | an index without chunks (only an empty document) returns no hits | no hits |
| `bm25-default-topk-five` | `search` | `topK` absent means 5 (the query matches 10 chunks) | es-biblioteca#2, es-taller#0, es-biblioteca#1, es-biblioteca#0, es-taller#1 |
| `bm25-ignores-candidates` | `search` | clarification 8: `candidates` is ignored, and not validated, outside `hybrid` (`candidates: 0` in `bm25` mode) | es-biblioteca#1, es-taller#0, es-biblioteca#2 |
| `dense-basic-ranking` | `search` | dense ranking with the hash embedder (dim 256): score = dot product of the normalized vectors | es-biblioteca#1, es-biblioteca#2, es-biblioteca#0, es-taller#0 |
| `dense-similar-spelling-beats-unrelated` | `search` | shared character trigrams rank `bicicletas` above unrelated text for the query `bicicleta` (BM25 would find nothing) | bikes#0 |
| `dense-zero-score-excluded` | `search` | a chunk with score 0 (here a chunk without tokens: zero vector) is not a hit | a#0 |
| `dense-negative-score-excluded` | `search` | a chunk with a negative score is not a hit (dim 2 forces collisions) | pos#0 |
| `dense-no-embedder-error` | `search` | dense search on an index built without an embedder fails with `no_embedder` | error `no_embedder` |
| `dense-no-embedder-query-without-tokens` | `search` | clarification 12: `no_embedder` is checked before the early return for a query without tokens | error `no_embedder` |
| `dense-exact-tie-index-order` | `search` | identical chunk texts tie exactly in dense mode and keep index order | zeta#0, alfa#0 |
| `dense-query-without-tokens` | `search` | a query without tokens returns no hits in dense mode too | no hits |
| `dense-custom-embedder-dot-product` | `search` | clarification 9: the score is the dot product of the vectors as the embedder returns them (no renormalization) | a#0, b#0 |
| `hybrid-fusion-order` | `search` | RRF `1/(60 + rank)` summed over both lists gives an order different from BM25 alone and from dense alone | es-biblioteca#1 (b1/d1), es-biblioteca#2 (b3/d2), es-taller#0 (b2/d4), es-biblioteca#0 (b4/d3) |
| `hybrid-chunk-in-one-list` | `search` | a chunk present in one list only gets that term alone and no rank for the other list | one#0 (b1/d1), bikes#0 (b-/d2) |
| `hybrid-candidates-cut` | `search` | each list is cut at `candidates` before fusion: ranks beyond it give no term | es-biblioteca#1 (b1/d1), es-biblioteca#2 (b-/d2) |
| `hybrid-ranks-reported` | `search` | every hybrid hit reports `bm25Rank`/`denseRank` exactly when the chunk is in that list | en-library#2 (b1/d1), en-library#0 (b2/d3), en-garden#2 (b3/d4), en-garden#0 (b4/d5), en-garden#1 (b5/d6), es-biblioteca#2 (b-/d2) |
| `hybrid-symmetric-tie-index-order` | `search` | ranks (1, 2) and (2, 1) fuse to exactly equal scores; the tie keeps index order | x#0 (b2/d1), y#0 (b1/d2) |
| `hybrid-default-candidates-with-large-topk` | `search` | clarification 8: an absent `candidates` (default 50) is never compared with `topK`, so `topK: 60` alone is valid | en-library#1 (b1/d1), en-library#2 (b2/d10), en-library#0 (b3/d9), es-biblioteca#1 (b-/d2), en-garden#2 (b-/d3), en-garden#0 (b-/d4), es-taller#0 (b-/d5), es-taller#1 (b-/d6), es-biblioteca#0 (b-/d7), es-biblioteca#2 (b-/d8) |
| `hybrid-default-candidates-fifty` | `search` | the default `candidates` is 50: dense rank 51 gives no term (`b1` alone, 1/61), dense rank 50 still does | c02#0 (b2/d50), c01#0 (b1/d-), c03#0 (b-/d1) |
| `hybrid-no-embedder-error` | `search` | hybrid search without an embedder fails with `no_embedder` | error `no_embedder` |
| `context-basic` | `context` | the composed system message: `RAG_INSTRUCTION`, a blank line, then `[n] text` sources in rank order | 2 source(s) es-biblioteca#1, es-biblioteca#2, dropped 0, cost 89 / 200 |
| `context-budget-exact` | `context` | a message whose cost equals `maxTokens` fits (`<=`); the next source would not | 2 source(s) c#0, a#0, dropped 1, cost 62 / 62 |
| `context-stops-at-first-misfit` | `context` | the walk stops at the first source that does not fit, even if a later, shorter one would | 1 source(s) top#0, dropped 2, cost 42 / 52 |
| `context-first-source-too-big` | `context` | `budget_too_small` when not even the first source fits; `required` = cost of the message with it | error `budget_too_small`, required 68 |
| `context-empty-hits` | `context` | empty hits give `RAG_INSTRUCTION` alone, no sources, `droppedCount 0` | 0 source(s), dropped 0, cost 40 / 40 |
| `context-empty-hits-budget-too-small` | `context` | clarification 11: with empty hits, an instruction that does not fit is `budget_too_small` with `required` 40 | error `budget_too_small`, required 40 |
| `context-separators-exact` | `context` | exact separators: one blank line between entries, `[n] ` prefix, no trailing newline (three sources) | 3 source(s) a#0, b#0, c#0, dropped 0, cost 52 / 100 |
| `context-cost-code-points` | `context` | the token cost counts code points: astral emoji count 1 each (UTF-16 would need a bigger budget) | 1 source(s) rain#0, dropped 0, cost 46 / 46 |
| `citations-basic` | `citations` | markers `[n]` whose `n` is a source are `cited` | cited [1,2], unknown [] |
| `citations-dedupe-order` | `citations` | markers are listed in order of first appearance, deduplicated | cited [2,1,3], unknown [] |
| `citations-unknown` | `citations` | markers whose `n` is not a source go to `unknown` (first appearance, deduplicated, disjoint from `cited`) | cited [1,2], unknown [4,7] |
| `citations-not-markers` | `citations` | `[1,2]`, `[ 1 ]`, `[01]`, `[0]`, `[1a]`, `[-1]`, `[+1]`, `[]`, `[1 ]` are not markers; `[2]` is | cited [2], unknown [] |
| `citations-ten-digits` | `citations` | ten or more digits are not a marker; nine digits are (and go to `unknown`) | cited [], unknown [123456789] |
| `citations-unicode-digits-not-markers` | `citations` | only ASCII `0-9` are digits: Arabic-Indic `٢` and fullwidth `３` (values 2 and 3) are not markers | cited [1], unknown [] |
| `citations-adjacent-markers` | `citations` | adjacent markers `[1][2]` are two markers | cited [1,2], unknown [] |
| `citations-unknown-first-appearance-order` | `citations` | `unknown` keeps first-appearance order (not numeric order) | cited [1], unknown [7,4] |
| `citations-membership-not-count` | `citations` | `cited` is decided by membership in the sources' `n`, not by `n <= number of sources` | cited [2,3], unknown [1] |
| `citations-bracket-rescan` | `citations` | clarification 13: a marker is tried at every `[`, so `[[2]]` and `[3[1]]` contain `[2]` and `[1]` | cited [2,1], unknown [] |
| `metrics-recall-precision` | `metrics` | recall = distinct relevant found / \|relevant\|; precision = relevant hits / hits | R 2/3, P 0.5, RR 1/3, hit true |
| `metrics-reciprocal-rank` | `metrics` | reciprocal rank = 1 / rank of the first relevant hit | R 1, P 1/3, RR 0.5, hit true |
| `metrics-no-hit` | `metrics` | no relevant hit: everything 0, `hit` false | R 0, P 0, RR 0, hit false |
| `metrics-doc-level-dedupe` | `metrics` | `level: "doc"` first deduplicates hits by document keeping the best-ranked one | R 1, P 2/3, RR 0.5, hit true |
| `metrics-no-hits-precision-zero` | `metrics` | with no hits, precision is 0 (not NaN) | R 0, P 0, RR 0, hit false |
| `metrics-empty-relevant-invalid` | `metrics` | an empty `relevant` set is `invalid_options` | error `invalid_options` |
| `metrics-relevant-duplicates-collapsed` | `metrics` | clarification 14: `relevant` is a set: duplicate ids count once in `\|relevant\|` | R 0.5, P 1, RR 1, hit true |
| `metrics-chunk-level-default` | `metrics` | `level` absent means `"chunk"`: a doc id in `relevant` matches no chunk id | R 0, P 0, RR 0, hit false |
| `eval-three-modes` | `eval` | labelled questions run in the three modes with the same `topK`; metrics per mode (chunk and doc level) | 5 questions × 3 modes |
| `answer-basic` | `answer` | search, compose, ONE call with `[system, user]`; the reply's citations are checked against the sources | sources 2, cited [1], unknown [], calls 1 |
| `answer-provider-error` | `answer` | a provider error propagates unchanged after one call (no retry) | error `rate_limit`, calls 1 |
| `answer-budget-too-small-after-no-call` | `answer` | `budget_too_small` from composition happens before the call: zero calls | error `budget_too_small`, required 64, calls 0 |
| `answer-unknown-citation` | `answer` | a marker beyond the sources is reported in `unknown` | sources 2, cited [1,2], unknown [3], calls 1 |
| `answer-exhausted-script` | `answer` | an exhausted script fails with `unavailable` after one call | error `unavailable`, calls 1 |
| `answer-no-hits-still-calls` | `answer` | with no hits the call is still made, with `RAG_INSTRUCTION` alone as the system message | sources 0, cited [], unknown [], calls 1 |
| `answer-no-hits-budget-too-small` | `answer` | clarification 11: no hits and `maxTokens < 40` is `budget_too_small` (`required` 40) with zero calls | error `budget_too_small`, required 40, calls 0 |
| `answer-drops-source` | `answer` | `sources` are the KEPT sources only: 3 hits, the budget keeps 2, so `[3]` in the reply is `unknown` | sources 2, cited [1], unknown [3], calls 1 |
| `answer-reply-verbatim` | `answer` | clarification 18: `answer` is the reply text verbatim (leading spaces and the trailing newline kept) | sources 1, cited [1], unknown [], calls 1 |
| `invalid-duplicate-doc-id` | `chunk` | document ids are unique | error `invalid_options` |
| `invalid-empty-doc-id` | `chunk` | document ids are non-empty | error `invalid_options` |
| `invalid-size-zero` | `chunk` | `size >= 1` (size 0 necessarily also breaks `overlap < size`; both give the same kind) | error `invalid_options` |
| `invalid-overlap-ge-size` | `chunk` | `overlap < size` | error `invalid_options` |
| `invalid-overlap-negative` | `chunk` | `overlap >= 0` | error `invalid_options` |
| `invalid-max-size-zero` | `chunk` | `maxSize >= 1` | error `invalid_options` |
| `invalid-non-integer-size` | `chunk` | a non-integer JSON number where an integer is required (`size: 2.5`) | error `invalid_options` |
| `invalid-unknown-chunking-type` | `chunk` | clarification 7: an unknown chunking `type` is invalid | error `invalid_options` |
| `invalid-topk-zero` | `search` | `topK >= 1` | error `invalid_options` |
| `invalid-non-integer-topk` | `search` | `topK` must be an integer (`1.5`) | error `invalid_options` |
| `invalid-candidates-less-than-topk` | `search` | `candidates >= topK` | error `invalid_options` |
| `invalid-candidates-below-default-topk` | `search` | clarification 8: in `hybrid`, `candidates` is compared with the EFFECTIVE `topK` (absent `topK` = 5, so `candidates: 3` is invalid) | error `invalid_options` |
| `invalid-non-integer-overlap` | `chunk` | `overlap` must be an integer (`0.5`) | error `invalid_options` |
| `invalid-non-integer-dim` | `embed` | `dim` must be an integer (`2.5`) | error `invalid_options` |
| `invalid-hash-dim-zero-in-search` | `search` | clarification 12: `hashEmbedder(0)` throws `invalid_options` at construction (the harness builds the embedder from `setup.embedder`) | error `invalid_options` |
| `invalid-embedding-checked-at-build` | `search` | clarification 10: embeddings are validated by `buildIndex`, so a wrong count fails even for a `bm25` search | error `invalid_embedding` |
| `invalid-unknown-mode` | `search` | an unknown `mode` is invalid | error `invalid_options` |
| `invalid-max-tokens-zero` | `context` | `maxTokens >= 1` | error `invalid_options` |
| `invalid-answer-validated-before-call` | `answer` | `answerWithSources` validates options before any call (`topK: 0`): zero calls | error `invalid_options`, calls 0 |
| `invalid-dim-zero` | `embed` | `dim >= 1` | error `invalid_options` |
| `invalid-unknown-level` | `metrics` | an unknown metrics `level` is invalid | error `invalid_options` |
| `invalid-embedding-wrong-count` | `search` | an embedder returning a number of vectors different from the number of chunks fails with `invalid_embedding` | error `invalid_embedding` |
| `invalid-embedding-ragged` | `search` | vectors of different lengths fail with `invalid_embedding` | error `invalid_embedding` |
| `invalid-embedding-query-count` | `search` | clarification 10: the query embedding must be exactly one vector | error `invalid_embedding` |
| `invalid-embedding-query-length` | `search` | clarification 10: the query vector must have the length of the chunk vectors | error `invalid_embedding` |

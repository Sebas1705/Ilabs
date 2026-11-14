# `rag` Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Run independent tasks in parallel** (see "Execution order"): each parallel implementer works in its own git worktree and must FIRST verify that its base is the commit named in its dispatch (worktrees are not always cut from the current branch tip: `git merge-base --is-ancestor <sha> HEAD`, else `git merge --ff-only <full sha>`), and its commits are cherry-picked onto the branch after review.

**Goal:** Ship the fifth iLabs module, `rag` (chunk documents, retrieve with BM25, dense vectors and their fusion, compose a cited context, check citations, measure retrieval), in Kotlin and TypeScript, pinned by shared fixtures and shown in a web page and an Android screen.

**Architecture:** `contracts/rag/` holds the contract and the fixtures. Each language implements `tokenize`, `chunkDocument`, `hashEmbed`/`hashEmbedder`, `buildIndex`, `search`, `composeContext`, `extractCitations`, `retrievalMetrics`, `answerWithSources` and a `runFixture` harness, on top of `providers` (`Provider`, `MockProvider`, errors) and `context` (the token counter). Contract tests run every fixture. Demos use the live implementations over the fixtures' sample corpora.

**Tech Stack:** as the previous modules: Kotlin Multiplatform (Android + JVM), TypeScript (pnpm workspace, Vitest), Vite + React, Compose + Material 3, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-14-rag-design.md` (binding). Read the sibling modules for conventions (modules/context and modules/evals in `ts` and `kotlin`, `contracts/context/README.md` and `contracts/evals/README.md`, `modules/*/kotlin/**/contract/Contract.kt` harness pattern, the shared web fixture loader `demos/web/src/fixtureLoader.ts`, the Evals page/screen as the newest demo pattern): fixture runner pattern, aggregated Kotlin contract failures, `invalid fixture:` errors, test guard `>= <real fixture count>`, the harness rules (unknown fixture keys rejected, expectations that need calls declare them), strict JSON parsing of fixture files in Kotlin, literal-number fixtures not reformatted.

**Base:** `main` at the evals squash commit `2d055a8` (branch `feat/rag`: design commit `5b6fed1` plus this plan); the dispatch of every task names the exact base commit.

## Global Constraints

- Public repo `Sebas1705/ilabs`, MIT; no secrets, no local paths or usernames in tracked files. Commits conventional, no trailers (no Co-Authored-By, no "Generated with"); do NOT push; push/PR/tag only when the owner asks.
- Repo content in English (code, docs, commits); demo UI texts in es + en (identical key sets; Android keys prefixed `rag_`). The sample corpus is written for the repo, small, bilingual, no third-party text.
- Same results in Kotlin and TS = deterministic logic only; the wording of the demo UI is not in the contract. `RAG_INSTRUCTION` IS pinned (exact text in `contracts/rag/README.md`, copied verbatim).
- Kotlin targets Android + JVM only; Gradle project `:modules:rag-kotlin` (dir `modules/rag/kotlin`), package `es.sebas1705.ilabs.rag` (harness in `es.sebas1705.ilabs.rag.contract`); TS package `@ilabs/rag` (dir `modules/rag/ts`) depending on `@ilabs/providers` and `@ilabs/context` as `workspace:*`; Kotlin `api(project(":modules:providers-kotlin"))` and `api(project(":modules:context-kotlin"))`.
- Code points, not UTF-16 units, everywhere; no regular expressions in tokenization, chunking or citation parsing (hand-written scans); no Kotlin stdlib calls that are Unicode- or locale-aware for these rules (`lowercase()`, `isLetter`, `isDigit`, `isWhitespace`, `Regex`, `String.format`, `toRegex`, `ignoreCase = true`); the UTF-8 encoder for hashing is hand-written in both languages (lone surrogate -> U+FFFD).
- Floating point: ranking uses scores computed in the same operation order in both languages; fixtures compare scores with absolute tolerance `1e-9` and ranks exactly; no fixture may contain two different scores closer than `1e-9`.
- Demos work offline with the built-in embedder and the mock provider; no keys, no network.
- Tooling on this machine: pnpm via `corepack pnpm`; Kotlin builds need JDK 21 (`JAVA_HOME`) and the Android SDK (`ANDROID_HOME` or `local.properties`).
- CI aggregates Kotlin module tests through `./gradlew jvmContractTests` (picks `:modules:*-kotlin` automatically); do not edit CI per module.

## Review Focus

1. Tokenization and the pinned Latin-1 table (shared by BM25 and the embedder): `¿qué` matches `que`, `canción` matches `cancion`, `ß` -> `ss`, `Æ` -> `ae`, `¡«»—“”…` and NBSP separate words, digits are word characters, characters outside the table are kept (`ł`, `日本`), a lone surrogate is a word code point, no NFC (Tasks 1/2/3).
2. Chunking edges counted in code points on the ORIGINAL text: CRLF paragraph separators, whitespace-only paragraphs dropped, an oversized paragraph flushes the pack and its pieces never merge with the next paragraph, the last fixed window ends at the end of the text and no window is fully contained in the previous one, empty document, emoji and lone surrogate offsets (Tasks 1/2/3).
3. Ranking and float parity: exact ties broken by index order, `topK` and `candidates` cut points, zero scores excluded, RRF with a chunk present in one list only, BM25 `N = 1`, empty chunks counted in `N` and `avgLen`, queries with no tokens return no hits, a zero vector never retrieves (Tasks 1/2/3).
4. Context composition: `RAG_INSTRUCTION` + `\n\n` + `[n] text` entries separated by `\n\n`, no trailing newline, the walk stops at the first source that does not fit (no skipping), `budget_too_small` with the exact `required`, empty hits give the instruction alone, the query is not charged (Tasks 1/2/3).
5. Citations and metrics: `[1,2]`, `[ 1 ]`, `[01]`, ten-digit markers and Unicode digits are not markers; duplicates deduplicated; `cited`/`unknown` disjoint; metrics at `"doc"` level deduplicate by document, empty `relevant` is invalid, exact doubles (Tasks 1/2/3).

Also pinned by tests in Tasks 2/3: option validation before any work (every rule of the design's API paragraph incl. a non-integer JSON number), an embedder returning the wrong count or lengths, `no_embedder`, a provider error propagating unchanged from `answerWithSources` after zero retries, `CancellationException` never swallowed.

---

## Contract reference (used by Tasks 1-6)

The binding rules are the "Rules" section of the spec. Fixtures live in `contracts/rag/<name>.json` as `{ "name", "setup": { "kind": ..., ... }, "expect": { ... } }`; `name` equals the file name. Documents are `{ "id", "text" }`. `chunking` is `{ "type": "fixed", "size": n, "overlap": m }` or `{ "type": "paragraph", "maxSize": n }`. `embedder` is absent or `{ "type": "hash", "dim": n? }`. Kinds and what each pins (the `expect` of an invalid case is `{ "error": { "kind": "<kind>", "required"?: n } }`, with zero provider calls):

- `tokens`: `{ text }` -> `{ tokens: [...] }` (the public `tokenize`).
- `chunk`: `{ documents, chunking }` -> `{ chunks: [{ id, docId, index, text, start, end }] }` (offsets in code points).
- `embed`: `{ text, dim? }` -> `{ nonZero: [[bucket, value], ...] }` sorted by bucket (values compared with the tolerance; the vector is L2-normalized; empty means the zero vector).
- `search`: `{ documents, chunking, embedder?, query, mode, topK?, candidates? }` -> `{ hits: [{ chunkId, docId, rank, score, bm25Rank?, denseRank? }] }` (ranks exact, scores with the tolerance; absent optional ranks must be absent).
- `context`: `search` fields plus `maxTokens` -> `{ message, sources: [{ n, chunkId, docId }], droppedCount }` (message compared exactly).
- `citations`: `{ sources: [n...], answer }` -> `{ cited: [...], unknown: [...] }`.
- `metrics`: `{ hits: [{ chunkId, docId }], relevant: [...], level? }` -> `{ recallAtK, precisionAtK, reciprocalRank, hit }` (exact doubles).
- `eval`: `{ documents, chunking, embedder, topK, questions: [{ query, relevant, level? }] }` -> `{ questions: [{ modes: { bm25, dense, hybrid } }] }` where each mode is `{ hitIds: [...], recallAtK, precisionAtK, reciprocalRank, hit }`.
- `answer`: `search` fields plus `maxTokens`, `provider: { script }` -> `{ answer, sources, citations: { cited, unknown }, hitIds, calls }`; the harness also asserts the provider request is exactly `[system = composed message, user = query]` with no other fields.
- `invalid`: the option rules of the design (`setup.kind` is the operation under test plus its bad option).

Harness rules (both languages): guard `fixtures.length >= <real count>`; aggregated failures in Kotlin; unknown keys rejected in fixture files (checked on the raw JSON); every key an expectation lists is compared and an absent optional rank must be absent; `calls` required for `answer` fixtures; the three literal-number cases (if any) not reformatted.

---

### Task 1: `rag` contract, sample corpus and fixtures (first; run alone)

**Files:**
- Create: `contracts/rag/README.md` (the spec's rules as the contract, the pinned Latin-1 folding table, the separators list, `RAG_INSTRUCTION`, fixture kinds and comparison rules above, a Clarifications section, a fixture table with one row per fixture and the single rule it pins), `contracts/rag/*.json` (about 70 fixtures; sample corpora small and bilingual, written for the repo: 3 to 5 short documents, 2 to 4 paragraphs each)

**Interfaces:**
- Produces: fixtures consumed by Tasks 2-6. Names (each one rule), at least: tokens — `tokens-ascii-fold`, `tokens-digits`, `tokens-punctuation-separators`, `tokens-spanish-accents-fold`, `tokens-spanish-inverted-marks`, `tokens-sharp-s-and-ligature`, `tokens-nbsp-and-general-punctuation`, `tokens-outside-table-kept`, `tokens-lone-surrogate`; chunk — `chunk-fixed-basic`, `chunk-fixed-overlap`, `chunk-fixed-shorter-than-size`, `chunk-fixed-exact-multiple`, `chunk-fixed-no-contained-window`, `chunk-paragraph-pack`, `chunk-paragraph-oversized-flushes`, `chunk-paragraph-crlf-offsets`, `chunk-paragraph-whitespace-only-dropped`, `chunk-paragraph-leading-trailing-breaks`, `chunk-lone-cr-is-ordinary`, `chunk-empty-document`, `chunk-emoji-offsets`, `chunk-lone-surrogate`, `chunk-ids-and-indexes`; embed — `embed-one-code-point-token`, `embed-repeated-token-adds`, `embed-no-tokens-zero-vector`, `embed-empty-string-zero-vector`, `embed-known-word-buckets`, `embed-sign-collision`, `embed-lone-surrogate-fffd`, `embed-astral-utf8`, `embed-dim-small`; search — `bm25-basic-ranking`, `bm25-single-chunk-idf`, `bm25-repeated-query-token`, `bm25-zero-score-excluded`, `bm25-length-normalization`, `bm25-exact-tie-index-order`, `bm25-empty-chunk-counts-in-avglen`, `bm25-query-without-tokens`, `bm25-topk-cut`, `dense-basic-ranking`, `dense-similar-spelling-beats-unrelated`, `dense-zero-score-excluded`, `dense-no-embedder-error`, `hybrid-fusion-order`, `hybrid-chunk-in-one-list`, `hybrid-candidates-cut`, `hybrid-ranks-reported`; context — `context-basic`, `context-budget-exact`, `context-stops-at-first-misfit`, `context-first-source-too-big`, `context-empty-hits`, `context-separators-exact`; citations — `citations-basic`, `citations-dedupe-order`, `citations-unknown`, `citations-not-markers`, `citations-ten-digits`; metrics — `metrics-recall-precision`, `metrics-reciprocal-rank`, `metrics-no-hit`, `metrics-doc-level-dedupe`, `metrics-no-hits-precision-zero`, `metrics-empty-relevant-invalid`; eval — `eval-three-modes`; answer — `answer-basic`, `answer-provider-error`, `answer-budget-too-small-after-no-call`, `answer-unknown-citation`, `answer-exhausted-script`; invalid — one per rule: `invalid-duplicate-doc-id`, `invalid-empty-doc-id`, `invalid-size-zero`, `invalid-overlap-ge-size`, `invalid-overlap-negative`, `invalid-max-size-zero`, `invalid-topk-zero`, `invalid-candidates-less-than-topk`, `invalid-max-tokens-zero`, `invalid-dim-zero`, `invalid-unknown-mode`, `invalid-unknown-level`, `invalid-non-integer-size`, `invalid-embedding-wrong-count`, `invalid-embedding-ragged`; add extras for rules you find unpinned (state them in the README).

- [ ] **Step 1: Write `contracts/rag/README.md`** (English): rules, the Latin-1 table written as an explicit code point -> replacement list, the separator ranges, `RAG_INSTRUCTION`, the formulas (BM25, hashing embedder steps, RRF, metrics), fixture kinds, comparison and harness rules, a fixture table.
- [ ] **Step 2: Write the fixtures**, deriving every expectation by hand from the rules (token lists, offsets, BM25 and cosine values to at least 12 significant digits, ranks, composed messages with exact separators, token costs with `4 + ceil(codePoints/4)`). Build the sample corpora first and reuse them across search/eval/answer fixtures.
- [ ] **Step 3: Verify** every expectation with a throwaway Node verifier kept OUTSIDE the repo (an independent implementation of the rules in about 300 lines, importing nothing from the repo and no tokenizer/BM25 library; fixtures are read only); run it over all fixtures and report the output; run it against a mutated copy with 3 deliberately wrong expectations and against at least 20 known-wrong implementations (e.g. Unicode lower-casing, no accent folding, `¿` as a letter, UTF-16 offsets, CRLF counted as one, whole token added to the embedder, no sign bit, idf without the `1 +`, query token counted twice, ties by insertion order reversed, RRF `k = 0`, skipping misfit sources, `[01]` accepted, doc-level without dedupe, `precision` over `topK` instead of hits) to prove the fixtures discriminate; fix any fixture that lets a wrong implementation pass; check near-ties (no two different scores closer than `1e-9` in any fixture). Check JSON well-formedness, `name` == file name, formatting (2-space indent, trailing newline, LF).
- [ ] **Step 4: Commit** `docs: add rag contract and fixtures`.

### Task 2: TypeScript `rag` (after Task 1; parallel with Task 3)

**Files:**
- Create: `modules/rag/ts/package.json` (name `@ilabs/rag`, `@ilabs/providers` and `@ilabs/context` as `workspace:*`, same scripts/devDependencies as `@ilabs/evals`), `tsconfig.json`, `src/errors.ts`, `src/tokenize.ts` (word code points, separators, the folding table), `src/chunk.ts`, `src/bm25.ts`, `src/embed.ts` (FNV-1a, the hand-written UTF-8 encoder, `hashEmbedder`), `src/index-build.ts` (`buildIndex`), `src/search.ts` (modes, RRF, ranking), `src/compose.ts` (`RAG_INSTRUCTION`, `composeContext`), `src/citations.ts`, `src/metrics.ts`, `src/answer.ts`, `src/contract.ts`, `src/index.ts`, tests (`contract.test.ts` + per-file unit tests)

**Interfaces:**
- Consumes: Task 1 fixtures; `Provider`, `CompletionRequest`, `Message`, `MockProvider`, `ProviderError` from `@ilabs/providers`; `defaultCounter`, `estimateTokens`, `TokenCounter` from `@ilabs/context`.
- Produces:
  - `interface Document { id: string; text: string }`; `type Chunking = { type: "fixed"; size: number; overlap: number } | { type: "paragraph"; maxSize: number }`; `interface Chunk { id: string; docId: string; index: number; text: string; start: number; end: number }`
  - `tokenize(text: string): string[]`; `chunkDocument(doc: Document, chunking: Chunking): Chunk[]`
  - `interface Embedder { embed(texts: string[]): Promise<number[][]> }`; `hashEmbed(text: string, dim?: number): number[]`; `hashEmbedder(dim?: number): Embedder`
  - `interface RagIndex { chunks: Chunk[]; ... }` (opaque to callers except `chunks`); `buildIndex(documents: Document[], options: { chunking: Chunking; embedder?: Embedder }): Promise<RagIndex>`
  - `type Mode = "bm25" | "dense" | "hybrid"`; `interface Hit { chunkId: string; docId: string; rank: number; score: number; bm25Rank?: number; denseRank?: number }`; `search(index: RagIndex, query: string, options: { mode: Mode; topK?: number; candidates?: number }): Promise<Hit[]>`
  - `RAG_INSTRUCTION: string`; `interface Source { n: number; chunkId: string; docId: string }`; `composeContext(hits: Hit[], index: RagIndex, options: { maxTokens: number; counter?: TokenCounter }): { message: Message; sources: Source[]; droppedCount: number }` (throws `RagError("budget_too_small", { required })`)
  - `extractCitations(answer: string, sources: Source[]): { cited: number[]; unknown: number[] }`; `retrievalMetrics(hits: Hit[], relevant: string[], options?: { level?: "chunk" | "doc" }): { recallAtK: number; precisionAtK: number; reciprocalRank: number; hit: boolean }`
  - `answerWithSources(provider: Provider, index: RagIndex, query: string, options: { mode: Mode; topK?: number; candidates?: number; maxTokens: number }): Promise<{ answer: string; sources: Source[]; citations: { cited: number[]; unknown: number[] }; hits: Hit[] }>`
  - `class RagError extends Error { kind: "no_embedder" | "invalid_options" | "invalid_embedding" | "budget_too_small"; required?: number }`
  - `runFixture(fixture: Fixture): Promise<FixtureRun>` (browser-safe, no Node APIs outside tests; `invalid fixture: <reason>` for unusable fixtures; returns the actual outputs per kind so the demos and the harness share it). Export everything above from `src/index.ts`.

- [ ] **Step 1: Write the failing tests:** `contract.test.ts` (every `contracts/rag/*.json`, path relative to the test file, guard `fixtures.length >= <real count>`, per-fixture `it`, comparison and harness rules above, unknown-key rejection test), unit tests per file: tokenization edges incl. the whole table, chunk offsets, FNV-1a known vectors, the UTF-8 encoder (1-4 bytes, lone surrogate -> `EF BF BD`), BM25 hand values, RRF, ranking ties, compose budget, citation scanner, metrics, option validation (every rule), `answerWithSources` single call and error propagation, inputs not mutated. Run `corepack pnpm --filter @ilabs/rag test` -> FAIL (record output).
- [ ] **Step 2: Implement** per the spec Rules: scans over code points with `for...of`, no regex; folding via the table (a `Map<number, string>`); BM25 sums in query-token order; embedding sums in dimension order; sorting by `(score desc, chunk order asc)` with exact comparison; sources and `required` computed with `defaultCounter`.
- [ ] **Step 3: Run** `corepack pnpm --filter @ilabs/rag test`, `typecheck`, then `corepack pnpm -r typecheck && corepack pnpm -r test` -> PASS, no noise.
- [ ] **Step 4: Commit** `feat(rag): add TypeScript implementation`.

### Task 3: Kotlin `rag` (after Task 1; parallel with Task 2)

**Files:**
- Create: `modules/rag/kotlin/build.gradle.kts` (same plugins/targets/SDK levels as the other modules, namespace `es.sebas1705.ilabs.rag`, `api` on providers and context, the jvmTest input declaration for `contracts/rag` with the `*.json` filter and RELATIVE sensitivity), `src/commonMain/kotlin/es/sebas1705/ilabs/rag/{Types,Errors,Tokenize,Chunk,Bm25,Embed,Index,Search,Compose,Citations,Metrics,Answer}.kt`, `src/commonMain/kotlin/es/sebas1705/ilabs/rag/contract/Contract.kt`, `src/commonTest/.../*Test.kt`, `src/jvmTest/.../ContractTest.kt`, a `WildcardImportsTest`
- Modify: `settings.gradle.kts` (`include(":modules:rag-kotlin")` + `projectDir = file("modules/rag/kotlin")`)

**Interfaces:**
- Consumes: Task 1 fixtures; providers and context Kotlin APIs (`Provider`, `Message`, `CompletionRequest`, `ProviderException`, `defaultCounter`/`estimateTokens`, `TokenCounter`); structured's `parseStrict` for fixture files (as in evals).
- Produces (mirror of Task 2): `data class Document(id, text)`; `sealed interface Chunking` (`Fixed(size, overlap)`, `Paragraph(maxSize)`); `data class Chunk(...)`; `fun tokenize(text: String): List<String>`; `fun chunkDocument(doc, chunking): List<Chunk>`; `fun interface Embedder { suspend fun embed(texts: List<String>): List<DoubleArray> }`; `fun hashEmbed(text: String, dim: Int = 256): DoubleArray`; `fun hashEmbedder(dim: Int = 256): Embedder`; `class RagIndex`; `suspend fun buildIndex(documents, chunking, embedder = null): RagIndex`; `enum class Mode`; `data class Hit(...)`; `suspend fun search(index, query, mode, topK = 5, candidates = 50): List<Hit>`; `const val RAG_INSTRUCTION`; `data class Source(...)`; `fun composeContext(hits, index, maxTokens, counter = ::defaultCounter): ComposedContext`; `fun extractCitations(answer, sources): Citations`; `fun retrievalMetrics(hits, relevant, level = Level.CHUNK): RetrievalMetrics`; `suspend fun answerWithSources(provider, index, query, mode, topK, candidates, maxTokens): Answer`; `class RagException(kind: RagErrorKind, required: Int? = null)`; and in `commonMain` `.contract` `parseFixture`/`suspend fun runFixture(fixture): FixtureOutcome` reused by the Android demo (`checkOutcome` as in evals).

- [ ] **Step 1: Write the failing tests:** JVM `ContractTest` (walks up from `user.dir`, guard `size >= <real count>`, aggregated failures, same comparison and harness rules as Task 2 incl. unknown-key rejection on the raw JSON and strict parsing), unit tests mirroring Task 2's (incl. the code-point scanner on lone surrogates and astral characters, FNV-1a vectors, the UTF-8 encoder), `WildcardImportsTest`. Run `./gradlew :modules:rag-kotlin:jvmTest` -> FAIL (record output).
- [ ] **Step 2: Implement** per the spec Rules, mirroring Task 2 exactly: code points via explicit surrogate-pair walks in common code (no `lowercase()`, `isLetter`, `isDigit`, `isWhitespace`, regex), the same folding table, `UInt` arithmetic for FNV-1a, sums in the same order, sorting with a total order `(score desc, chunk order asc)`, `CancellationException` and `Error` never caught, only `ProviderException` handled where the contract says.
- [ ] **Step 3: Run** `./gradlew :modules:rag-kotlin:jvmTest :modules:rag-kotlin:assemble jvmContractTests` -> PASS; `./gradlew jvmContractTests --dry-run` lists five modules.
- [ ] **Step 4: Commit** `feat(rag): add Kotlin implementation`.

### Task 4: Web demo (after Task 2; parallel with Tasks 5 and 6)

**Files:**
- Create: `demos/web/src/pages/RagPage.tsx`, `src/components/{HitTable,ContextView,ModeMetrics}.tsx`, `src/ragFixtures.ts` (through the shared `parseFixtureFiles` loader), `src/pages/RagPage.test.tsx`, component tests
- Modify: `demos/web/package.json` (`@ilabs/rag` as `workspace:*`; lockfile committed, only the importer link), `src/routes.ts` (one registry entry), `src/i18n.ts` (es + en), `src/styles.css`

**Interfaces:**
- Consumes: the public API of `@ilabs/rag` (only what `index.ts` exports), the shared fixture loader, route registry, shell conventions of the existing pages (read the Evals and Context pages first).
- Produces: route `#/rag` and a nav entry: corpus picker (fixtures that carry documents: `search`, `context`, `eval`, `answer` kinds, grouped by kind), question input (typed, or a labelled question from an `eval` fixture), mode switch (BM25 / dense / hybrid), `topK` control, chunk list with positions, the hit table with BM25 rank, dense rank, fused rank and score side by side (text values plus a bar `aria-hidden`), the composed context with `[n]` sources and the token budget bar (`TokenBar` pattern), the citation check of an `answer` fixture's scripted reply, and for labelled questions recall / precision / MRR per mode; a note that the dense side is the built-in n-gram hashing embedder, not a model; a polite coarse status line; translated parameter errors; every string in es + en.

- [ ] **Step 1: Write the failing tests:** nav to `#/rag` through the registry; picking a `hybrid-fusion-order` sample shows the three rankings and the fused order; changing the mode changes the table; a question without tokens shows the empty state; `context-budget-exact` shows the budget bar with text values and the dropped count; an `answer` sample shows cited and unknown markers; a labelled `eval` question shows the metrics of the three modes; every fixture with documents renders (count from the contracts directory, lower bound); dictionary parity; a rejected run shows the error state; the loader shape check covers the render path. Run `corepack pnpm --filter @ilabs/demo-web test` -> FAIL.
- [ ] **Step 2: Implement** pages and components following the other pages' conventions (named regions, focus on navigation, language/theme shared, 44 px targets, mobile-first, reduced motion, text values for every bar, glyph + text for hit states, no colour-only meaning); results come ONLY from the library (no scoring logic in the demo); stale async results ignored when the question or mode changes quickly.
- [ ] **Step 3: Verify:** tests, `typecheck`, `build`, `corepack pnpm -r typecheck && corepack pnpm -r test`; real browser: every fixture group renders, the question and the mode react live, no console errors, 375 px and 1280 px without horizontal page scroll, es and en, light and dark, keyboard operation. Report what could not be verified.
- [ ] **Step 4: Commit** `feat(demo-web): add the rag page`.

### Task 5: Android demo (after Task 3; parallel with Tasks 4 and 6)

**Files:**
- Create: `demos/android/src/main/kotlin/es/sebas1705/ilabs/demo/{RagScreen,RagViewModel,RagHits,RagContext}.kt`, `demos/android/src/test/kotlin/es/sebas1705/ilabs/demo/{RagViewModelTest,RagResourcesTest}.kt`
- Modify: `demos/android/build.gradle.kts` (`implementation(project(":modules:rag-kotlin"))`), `ModuleHome.kt`, `MainActivity.kt`, `res/values/strings.xml`, `res/values-es/strings.xml`

**Interfaces:**
- Consumes: Task 3's API and its `contract` harness; `FixtureLoader`, the module home and navigation of the existing demo; assets `contracts/rag/*.json` (copied by `copyContracts`); the web twin's groups and defaults (same content and behavior).
- Produces: a fifth module on the home list; `RagViewModel(loader, savedState, runner)` exposing fixture names/groups (same taxonomy and order as the web), the selected fixture, the question and mode, the run output (chunks, hits with the three ranks, composed context, budget, citations, metrics per mode), partial `loadError`, `runError`; a screen with the same content and behavior as the web page (48 dp targets, centered max width on tablets, insets incl. IME, es + en, `plurals`, one spoken sentence per hit row, `heading()` on header rows, `SelectionContainer` for long text, polite coarse live status, per-field state persisted via `SavedStateHandle`); the question is validated by the library only.

- [ ] **Step 1: Write the failing `RagViewModelTest` (JVM):** the hybrid fixture exposes the fused order and the per-list ranks; the context fixture the sources and the dropped count; an `answer` fixture the citations; the labelled questions the metrics of the three modes; a question without tokens the empty state; a malformed fixture among valid ones keeps the valid ones with a partial `loadError`; a throwing runner sets `runError` (CancellationException rethrown); a slow run of fixture A is ignored after selecting B; selection and question survive via `SavedStateHandle`; ALL fixtures with documents (count derived from the contracts directory, lower bound) run through a test loader and match their `expect` via the harness; `RagResourcesTest` checks `rag_` keys, plurals and placeholders in both locales. Run `./gradlew :demos:android:testDebugUnitTest` -> FAIL.
- [ ] **Step 2: Implement** ViewModel, screen, home entry and strings (keys prefixed `rag_`, identical in both locales).
- [ ] **Step 3: Verify:** `./gradlew jvmContractTests :demos:android:testDebugUnitTest :demos:android:assembleDebug --rerun-tasks --warning-mode all` -> PASS with 0 warnings of ours; emulator (dedicated AVD `ilabs_api36`; never wipe other projects' AVDs; leave it as found): home lists five modules; every fixture group renders; the question field with the keyboard open stays visible; es and en, light and dark, phone and tablet size (`wm size`, reset afterwards), font scale 1.5, rotation, process death and "Don't keep activities" keep module, fixture and question. Screenshots stay outside the repo. Report what could not be verified (TalkBack, foldables).
- [ ] **Step 4: Commit** `feat(demo-android): add the rag screen`.

### Task 6: Module docs (after Tasks 2 and 3; parallel with Tasks 4 and 5)

**Files:**
- Create: `modules/rag/README.md`
- Modify: `README.md` (Modules table: `rag` done; run commands; status line)

- [ ] **Step 1: Write `modules/rag/README.md`** (style of `modules/evals/README.md`): purpose and the honest limits (the built-in embedder matches n-grams, not meaning; teaching scale, in-memory, brute force), the pipeline (chunk, index, retrieve, compose, cite, measure), chunking strategies with a worked offset example, tokenization and the Latin-1 table, BM25 formula, the hashing embedder steps, RRF with a worked example of a fusion flip, `RAG_INSTRUCTION` and the exact context layout, citations rules, metrics with doc-level dedupe, errors, composing with `providers`, `context` and `evals` (an `evals` suite that grades `answerWithSources` replies with a `contains`/`oneOf` grader is a snippet), plugging a real embedder through the `Embedder` interface (a TypeScript snippet using a `Provider`-style call is described, not shipped), limits, usage snippets in TypeScript and Kotlin that compile against the real APIs (two documents, three modes, a mock provider answer with citations), a link to `contracts/rag/README.md` and the sibling READMEs. Update the root README.
- [ ] **Step 2: Verify** both snippets compile and run (throwaway copies outside the repo or temporary tests deleted before the commit) and their printed output matches the README; every relative link resolves.
- [ ] **Step 3: Commit** `docs: document the rag module`.

---

## Execution order (parallelism)

1. **Wave 1:** Task 1 (contract + fixtures) alone with the strongest model; review it with independent hand derivation of every fixture by the strongest model (three reviewers split by area: tokens/chunk/embed, search/context, citations/metrics/eval/answer/invalid) plus a mechanical re-check against the independent verifier; fix rounds until clean; integrate.
2. **Wave 2 (parallel):** Task 2 (TS) and Task 3 (Kotlin) from the integrated tip; review both in parallel; then a differential TS-vs-Kotlin-vs-reference harness over generated adversarial corpora and queries (random documents with accents, emoji, lone surrogates, CRLF, empty paragraphs; random chunking options; the three modes; random budgets; random answers for the citation scanner; random relevant sets), including a timing check (1 MB corpus, 2,000 chunks, 200 queries); fix rounds; integrate by cherry-pick.
3. **Wave 3 (parallel):** Tasks 4 (web), 5 (Android) and 6 (docs); review in parallel; one fix round each; integrate.
4. **Final:** one whole-branch review (hygiene, clean-clone verification of the exact CI commands, parity, architecture, docs truthfulness) and ONE fix wave split into parallel fixers with disjoint files, then a clean-clone re-run; squash-merge and push only when the owner asks.

## Self-review notes

- Spec coverage: chunking (both strategies), tokenization with the pinned table, BM25, hashing embedder, dense, hybrid RRF, ranking and ties, API and option rules, context composition with `RAG_INSTRUCTION`, citations, metrics, `answerWithSources`, fixture kinds incl. `eval` (Tasks 1-3); demos with side-by-side rankings, budget bar, citations and metrics (4-5); docs (6); CI needs no edit.
- Types consistent across tasks: `Document`, `Chunking`, `Chunk`, `Embedder`, `RagIndex`, `Mode`, `Hit`, `Source`, `RagError`/`RagException`, `tokenize`, `chunkDocument`, `hashEmbed`, `hashEmbedder`, `buildIndex`, `search`, `composeContext`, `extractCitations`, `retrievalMetrics`, `answerWithSources`, `runFixture`.
- Additions the spec leaves to the builder and the plan fixes so fixtures can exist: public `tokenize` and `hashEmbed` (the `tokens` and `embed` fixture kinds), `RagError` kinds, the fixture kinds list.
- Not covered by design: persistence, SQLite, approximate search, real embedding models, rerankers, query rewriting, stemming, pushing or tagging (owner's call).

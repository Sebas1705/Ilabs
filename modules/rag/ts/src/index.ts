export type {
  Chunk,
  Chunking,
  Citations,
  Document,
  Embedder,
  Hit,
  MetricsLevel,
  Mode,
  RagIndex,
  RetrievalMetrics,
  SearchOptions,
  Source,
} from "./types.js";
export { RagError, type RagErrorKind } from "./errors.js";
export { tokenize } from "./tokenize.js";
export { chunkDocument } from "./chunk.js";
export { hashEmbed, hashEmbedder } from "./embed.js";
export { buildIndex } from "./index-build.js";
export { search } from "./search.js";
export { composeContext, RAG_INSTRUCTION, type ComposedContext } from "./compose.js";
export { extractCitations } from "./citations.js";
export { retrievalMetrics } from "./metrics.js";
export { answerWithSources, type AnswerOptions, type AnswerResult } from "./answer.js";
export { runFixture, type Fixture, type FixtureError, type FixtureOutput, type FixtureRun, type ModeResult } from "./contract.js";

/** A document to index: `id` non-empty and unique within one `buildIndex` call, `text` any string. */
export interface Document {
  id: string;
  text: string;
}

/** How documents are split; every size is in code points. */
export type Chunking = { type: "fixed"; size: number; overlap: number } | { type: "paragraph"; maxSize: number };

/** A chunk: `[start, end)` are code-point offsets into the document text, `text` the original slice, `id = docId + "#" + index`. */
export interface Chunk {
  id: string;
  docId: string;
  index: number;
  text: string;
  start: number;
  end: number;
}

/** Turns texts into vectors, one per text, all of the same length. */
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

/** An index built by `buildIndex`; opaque to callers except `chunks` (index order). */
export interface RagIndex {
  readonly chunks: Chunk[];
}

export type Mode = "bm25" | "dense" | "hybrid";

/** A retrieved chunk; `bm25Rank` / `denseRank` only in hybrid mode, when the chunk is in that cut list. */
export interface Hit {
  chunkId: string;
  docId: string;
  rank: number;
  score: number;
  bm25Rank?: number;
  denseRank?: number;
}

export interface SearchOptions {
  mode: Mode;
  /** Integer `>= 1`, default 5. */
  topK?: number;
  /** Hybrid only: integer `>= 1` and `>=` the effective `topK`; default 50. Ignored by the other modes. */
  candidates?: number;
}

/** A kept source of a composed context: `n` is its 1-based position. */
export interface Source {
  n: number;
  chunkId: string;
  docId: string;
}

export interface Citations {
  cited: number[];
  unknown: number[];
}

export interface RetrievalMetrics {
  recallAtK: number;
  precisionAtK: number;
  reciprocalRank: number;
  hit: boolean;
}

export type MetricsLevel = "chunk" | "doc";

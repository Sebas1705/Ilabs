import { buildBm25, type Bm25Stats } from "./bm25.js";
import { chunkValidated, validateChunking, validateDocument } from "./chunk.js";
import { invalidOptions, RagError } from "./errors.js";
import { tokenize } from "./tokenize.js";
import type { Chunk, Chunking, Document, Embedder, RagIndex } from "./types.js";

/** What `search` needs beyond the public chunks. */
export interface IndexState {
  chunks: readonly Chunk[];
  byId: Map<string, Chunk>;
  bm25: Bm25Stats;
  embedder: Embedder | null;
  /** One vector per chunk (copies of what the embedder returned), or null without an embedder. */
  vectors: number[][] | null;
  /** Length of the chunk vectors (meaningful only with vectors and at least one chunk). */
  dim: number;
}

const states = new WeakMap<RagIndex, IndexState>();

/** The internal state of an index made by `buildIndex`; a `TypeError` for anything else (a programmer error). */
export function stateOf(index: RagIndex): IndexState {
  const state = typeof index === "object" && index !== null ? states.get(index) : undefined;
  if (state === undefined) throw new TypeError("not an index built by buildIndex");
  return state;
}

/**
 * Checks an embedder result: a dense array of `count` dense arrays of finite numbers, all of the same length; returns
 * copies. NaN, infinities and holes are `invalid_embedding` (a library hardening beyond the contract's count/length rules).
 */
export function checkVectors(result: unknown, count: number): number[][] {
  const fail = (detail: string): never => {
    throw new RagError("invalid_embedding", { detail });
  };
  if (!Array.isArray(result) || result.length !== count) fail(`expected ${count} vector(s)`);
  const vectors = result as unknown[];
  const out: number[][] = [];
  for (let i = 0; i < vectors.length; i++) {
    if (!(i in vectors)) fail("a missing vector");
    const v = vectors[i];
    if (!Array.isArray(v)) fail("a vector is not an array");
    const arr = v as unknown[];
    const copy: number[] = [];
    for (let d = 0; d < arr.length; d++) {
      const x = arr[d];
      if (!(d in arr) || typeof x !== "number" || !Number.isFinite(x)) fail("a vector entry is not a finite number");
      copy.push(x as number);
    }
    if (out.length > 0 && copy.length !== out[0]!.length) fail("vectors of different lengths");
    out.push(copy);
  }
  return out;
}

/**
 * Validates the documents and the chunking, chunks every document (index order: document order, then chunk index)
 * and, with an embedder and at least one chunk, embeds all chunk texts in ONE call, validated eagerly.
 */
export async function buildIndex(documents: Document[], options: { chunking: Chunking; embedder?: Embedder }): Promise<RagIndex> {
  if (!Array.isArray(documents)) invalidOptions("documents must be an array");
  if (typeof options !== "object" || options === null) invalidOptions("options must be an object");
  const ids = new Set<string>();
  for (const doc of documents) {
    validateDocument(doc);
    if (ids.has(doc.id)) invalidOptions(`duplicate document id: ${doc.id}`);
    ids.add(doc.id);
  }
  validateChunking(options.chunking);
  const embedder = options.embedder ?? null;
  if (embedder !== null && (typeof embedder !== "object" || typeof embedder.embed !== "function")) {
    throw new TypeError("embedder must have an embed function");
  }

  const chunks: Chunk[] = [];
  for (const doc of documents) for (const c of chunkValidated(doc, options.chunking)) chunks.push(Object.freeze(c));
  Object.freeze(chunks);

  let vectors: number[][] | null = null;
  if (embedder !== null && chunks.length > 0) {
    vectors = checkVectors(await embedder.embed(chunks.map((c) => c.text)), chunks.length);
  }

  const index: RagIndex = Object.freeze({ chunks });
  states.set(index, {
    chunks,
    byId: new Map(chunks.map((c) => [c.id, c])),
    bm25: buildBm25(chunks.map((c) => tokenize(c.text))),
    embedder,
    vectors,
    dim: vectors !== null && vectors.length > 0 ? vectors[0]!.length : 0,
  });
  return index;
}

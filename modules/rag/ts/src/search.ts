import { bm25Scores } from "./bm25.js";
import { invalidOptions, isIntAtLeast, RagError } from "./errors.js";
import { checkVectors, stateOf, type IndexState } from "./index-build.js";
import { tokenize } from "./tokenize.js";
import type { Hit, Mode, RagIndex, SearchOptions } from "./types.js";

const DEFAULT_TOP_K = 5;
const DEFAULT_CANDIDATES = 50;
const RRF_K = 60;

/** Effective search options after validation. */
export interface ResolvedSearch {
  mode: Mode;
  topK: number;
  candidates: number;
}

/**
 * Validates `mode`, `topK` and, in hybrid mode only, `candidates` (integer `>= 1` and `>=` the effective `topK`).
 * Outside hybrid `candidates` is ignored entirely; an absent one means 50 and is never compared with `topK`.
 */
export function resolveSearchOptions(options: SearchOptions): ResolvedSearch {
  if (typeof options !== "object" || options === null) invalidOptions("options must be an object");
  const { mode, topK, candidates } = options;
  if (mode !== "bm25" && mode !== "dense" && mode !== "hybrid") invalidOptions(`unknown mode: ${String(mode)}`);
  if (topK !== undefined && !isIntAtLeast(topK, 1)) invalidOptions("topK must be an integer >= 1");
  const effectiveTopK = topK ?? DEFAULT_TOP_K;
  if (mode === "hybrid" && candidates !== undefined) {
    if (!isIntAtLeast(candidates, 1)) invalidOptions("candidates must be an integer >= 1");
    if (candidates < effectiveTopK) invalidOptions("candidates must be >= topK");
  }
  return { mode, topK: effectiveTopK, candidates: mode === "hybrid" && candidates !== undefined ? candidates : DEFAULT_CANDIDATES };
}

interface Scored {
  /** Position in index order. */
  order: number;
  score: number;
}

/** Descending score (exact comparison), ties by ascending index order: a total order. */
function byScoreThenOrder(a: Scored, b: Scored): number {
  if (a.score > b.score) return -1;
  if (a.score < b.score) return 1;
  return a.order - b.order;
}

/** Chunks with a score `> 0`, ranked. */
function rankPositive(scores: number[]): Scored[] {
  const out: Scored[] = [];
  scores.forEach((score, order) => {
    if (score > 0) out.push({ order, score });
  });
  return out.sort(byScoreThenOrder);
}

async function denseScores(state: IndexState, query: string): Promise<number[]> {
  const [q] = checkVectors(await state.embedder!.embed([query]), 1);
  if (q!.length !== state.dim) throw new RagError("invalid_embedding", { detail: "query vector length differs from the chunk vectors" });
  return state.vectors!.map((v) => {
    let s = 0.0;
    for (let d = 0; d < v.length; d++) s += q![d]! * v[d]!;
    return s;
  });
}

/** Search with already validated options (shared by `search` and `answerWithSources`). */
export async function searchResolved(index: RagIndex, query: string, opts: ResolvedSearch): Promise<Hit[]> {
  const state = stateOf(index);
  if (typeof query !== "string") throw new TypeError("query must be a string");
  if (opts.mode !== "bm25" && state.embedder === null) throw new RagError("no_embedder");
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0 || state.chunks.length === 0) return [];

  const toHit = (s: Scored, rank: number): Hit => {
    const c = state.chunks[s.order]!;
    return { chunkId: c.id, docId: c.docId, rank, score: s.score };
  };

  if (opts.mode === "bm25") {
    return rankPositive(bm25Scores(state.bm25, queryTokens))
      .slice(0, opts.topK)
      .map((s, i) => toHit(s, i + 1));
  }
  if (opts.mode === "dense") {
    return rankPositive(await denseScores(state, query))
      .slice(0, opts.topK)
      .map((s, i) => toHit(s, i + 1));
  }

  const bm25List = rankPositive(bm25Scores(state.bm25, queryTokens)).slice(0, opts.candidates);
  const denseList = rankPositive(await denseScores(state, query)).slice(0, opts.candidates);
  const bm25Rank = new Map<number, number>();
  bm25List.forEach((s, i) => bm25Rank.set(s.order, i + 1));
  const denseRank = new Map<number, number>();
  denseList.forEach((s, i) => denseRank.set(s.order, i + 1));
  const fused: Scored[] = [];
  for (let order = 0; order < state.chunks.length; order++) {
    const b = bm25Rank.get(order);
    const d = denseRank.get(order);
    if (b === undefined && d === undefined) continue;
    const score = (b !== undefined ? 1 / (RRF_K + b) : 0) + (d !== undefined ? 1 / (RRF_K + d) : 0);
    fused.push({ order, score });
  }
  return fused
    .sort(byScoreThenOrder)
    .slice(0, opts.topK)
    .map((s, i) => {
      const hit = toHit(s, i + 1);
      const b = bm25Rank.get(s.order);
      const d = denseRank.get(s.order);
      if (b !== undefined) hit.bm25Rank = b;
      if (d !== undefined) hit.denseRank = d;
      return hit;
    });
}

/**
 * Retrieves the best chunks for `query`. Order of steps: validate the options; `no_embedder` for dense/hybrid on an
 * index without an embedder; a query without tokens or an index without chunks gives no hits (no embedder call);
 * otherwise rank (descending score, ties by index order) and cut at `topK`.
 */
export async function search(index: RagIndex, query: string, options: SearchOptions): Promise<Hit[]> {
  const opts = resolveSearchOptions(options);
  return searchResolved(index, query, opts);
}

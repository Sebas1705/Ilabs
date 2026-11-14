const K1 = 1.2;
const B = 0.75;

/** Token statistics of an index: per chunk term frequencies and lengths, document frequencies, N and avgLen. */
export interface Bm25Stats {
  termFreqs: Map<string, number>[];
  lengths: number[];
  docFreq: Map<string, number>;
  n: number;
  avgLen: number;
}

/** Builds the statistics from each chunk's tokens (chunks without tokens count in N and avgLen). */
export function buildBm25(chunkTokens: string[][]): Bm25Stats {
  const termFreqs: Map<string, number>[] = [];
  const lengths: number[] = [];
  const docFreq = new Map<string, number>();
  let total = 0;
  for (const tokens of chunkTokens) {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
    termFreqs.push(tf);
    lengths.push(tokens.length);
    total += tokens.length;
  }
  const n = chunkTokens.length;
  return { termFreqs, lengths, docFreq, n, avgLen: n === 0 ? 0 : total / n };
}

/** Distinct tokens in order of first appearance. */
export function distinct(tokens: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * BM25 score of every chunk for the distinct query tokens (first-appearance order), each term in the reference
 * operation order `idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * len / avgLen))`, summed from 0 in that order.
 */
export function bm25Scores(stats: Bm25Stats, queryTokens: string[]): number[] {
  const { termFreqs, lengths, docFreq, n: N, avgLen } = stats;
  const scores: number[] = [];
  const terms = distinct(queryTokens);
  for (let c = 0; c < N; c++) {
    const tfs = termFreqs[c]!;
    const len = lengths[c]!;
    let score = 0.0;
    for (const q of terms) {
      const tf = tfs.get(q) ?? 0;
      if (tf === 0) continue;
      const n = docFreq.get(q)!;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const term = (idf * (tf * (K1 + 1))) / (tf + K1 * (1 - B + (B * len) / avgLen));
      score += term;
    }
    scores.push(score);
  }
  return scores;
}

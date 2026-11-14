import { invalidOptions } from "./errors.js";
import type { Hit, MetricsLevel, RetrievalMetrics } from "./types.js";

/**
 * Retrieval metrics of `hits` in ARRAY order (position k is rank k; `hit.rank` is never read) against a non-empty set
 * of relevant ids. At `"doc"` level the list is the hits' docIds deduplicated keeping the first occurrence.
 */
export function retrievalMetrics(hits: Hit[], relevant: string[], options?: { level?: MetricsLevel }): RetrievalMetrics {
  if (options !== undefined && (typeof options !== "object" || options === null)) invalidOptions("options must be an object");
  // Only an absent (undefined) level means "chunk"; null is a bad value like any other.
  const level = options === undefined || options.level === undefined ? "chunk" : options.level;
  if (level !== "chunk" && level !== "doc") invalidOptions(`unknown level: ${String(level)}`);
  if (!Array.isArray(relevant) || relevant.length === 0) invalidOptions("relevant must be a non-empty set");

  const relevantSet = new Set(relevant);
  let list: string[];
  if (level === "chunk") {
    list = hits.map((h) => h.chunkId);
  } else {
    const seen = new Set<string>();
    list = [];
    for (const h of hits) {
      if (!seen.has(h.docId)) {
        seen.add(h.docId);
        list.push(h.docId);
      }
    }
  }

  const listSet = new Set(list);
  let found = 0;
  for (const id of relevantSet) if (listSet.has(id)) found++;
  let relevantEntries = 0;
  let firstPosition = 0;
  list.forEach((id, i) => {
    if (relevantSet.has(id)) {
      relevantEntries++;
      if (firstPosition === 0) firstPosition = i + 1;
    }
  });
  return {
    recallAtK: found / relevantSet.size,
    precisionAtK: list.length === 0 ? 0 : relevantEntries / list.length,
    reciprocalRank: firstPosition === 0 ? 0 : 1 / firstPosition,
    hit: firstPosition !== 0,
  };
}

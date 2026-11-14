import { describe, expect, it } from "vitest";
import { RagError } from "./errors.js";
import { retrievalMetrics } from "./metrics.js";
import type { Hit } from "./types.js";

const hits = (...ids: string[]): Hit[] =>
  ids.map((chunkId, i) => ({ chunkId, docId: chunkId.slice(0, chunkId.indexOf("#")), rank: i + 1, score: 1 }));

function invalidOptions(f: () => unknown): void {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(RagError);
    expect((e as RagError).kind).toBe("invalid_options");
    return;
  }
  throw new Error("expected RagError(invalid_options)");
}

describe("retrievalMetrics", () => {
  it("computes recall, precision over hits, reciprocal rank and hit at chunk level", () => {
    expect(retrievalMetrics(hits("x#0", "a#0", "y#0", "b#0"), ["a#0", "b#0", "c#0"])).toEqual({
      recallAtK: 2 / 3,
      precisionAtK: 2 / 4,
      reciprocalRank: 1 / 2,
      hit: true,
    });
  });

  it("gives zeros and no NaN without hits or without a relevant entry", () => {
    expect(retrievalMetrics([], ["a#0"])).toEqual({ recallAtK: 0, precisionAtK: 0, reciprocalRank: 0, hit: false });
    expect(retrievalMetrics(hits("x#0"), ["a#0"])).toEqual({ recallAtK: 0, precisionAtK: 0, reciprocalRank: 0, hit: false });
  });

  it("collapses duplicate relevant ids and does not deduplicate chunk-level hits", () => {
    expect(retrievalMetrics(hits("a#0", "a#0", "x#0"), ["a#0", "a#0", "b#0"])).toEqual({
      recallAtK: 1 / 2,
      precisionAtK: 2 / 3,
      reciprocalRank: 1,
      hit: true,
    });
  });

  it("deduplicates by document at doc level, keeping the first occurrence; doc ids never match at chunk level", () => {
    const h = hits("a#0", "b#0", "a#1", "c#0");
    expect(retrievalMetrics(h, ["c"], { level: "doc" })).toEqual({ recallAtK: 1, precisionAtK: 1 / 3, reciprocalRank: 1 / 3, hit: true });
    expect(retrievalMetrics(h, ["c"])).toEqual({ recallAtK: 0, precisionAtK: 0, reciprocalRank: 0, hit: false });
    expect(retrievalMetrics(h, ["c"], { level: "chunk" })).toEqual(retrievalMetrics(h, ["c"]));
  });

  it("uses the array order of the hits, never their rank field", () => {
    const h: Hit[] = [
      { chunkId: "x#0", docId: "x", rank: 1, score: 9 },
      { chunkId: "a#0", docId: "a", rank: 9, score: 1 },
      { chunkId: "b#0", docId: "b", rank: 1, score: 9 },
    ];
    expect(retrievalMetrics(h, ["b#0"]).reciprocalRank).toBe(1 / 3);
    expect(retrievalMetrics(h, ["a#0"]).reciprocalRank).toBe(1 / 2);
  });

  it("validates level and a non-empty relevant set", () => {
    invalidOptions(() => retrievalMetrics(hits("a#0"), []));
    invalidOptions(() => retrievalMetrics(hits("a#0"), ["a#0"], { level: "document" as "doc" }));
    invalidOptions(() => retrievalMetrics(hits("a#0"), ["a#0"], { level: null as unknown as "doc" }));
    for (const bad of [null, "doc", 3, true]) {
      invalidOptions(() => retrievalMetrics(hits("a#0"), ["a#0"], bad as unknown as { level?: "doc" }));
    }
    expect(retrievalMetrics(hits("a#0"), ["a#0"], undefined).hit).toBe(true);
    expect(retrievalMetrics(hits("a#0"), ["a#0"], { level: undefined }).hit).toBe(true);
  });

  it("does not mutate its inputs", () => {
    const h = hits("a#0", "b#0", "a#1");
    const relevant = ["b", "b"];
    retrievalMetrics(Object.freeze(h) as Hit[], Object.freeze(relevant) as string[], { level: "doc" });
    expect(h).toEqual(hits("a#0", "b#0", "a#1"));
    expect(relevant).toEqual(["b", "b"]);
  });
});

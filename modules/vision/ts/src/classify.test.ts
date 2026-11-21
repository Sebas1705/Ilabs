import { describe, expect, it } from "vitest";
import { postprocessClassification } from "./classify.js";
import { VisionError } from "./errors.js";
import { parseModelSpec } from "./spec.js";

const input = { width: 1, height: 1, layout: "nhwc", channels: "rgb", mode: "stretch", resample: "nearest", dtype: "float" };
const cls = (type: string, extra: Record<string, unknown> = {}) => parseModelSpec({ input, output: { type }, ...extra });

function kindOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(VisionError);
    return (e as VisionError).kind;
  }
  return "no error";
}

describe("postprocessClassification", () => {
  it("probabilities are used as given, ordered by score", () => {
    expect(postprocessClassification([0.2, 0.5, 0.1], cls("probabilities"))).toEqual([
      { index: 1, label: "#1", score: 0.5 },
      { index: 0, label: "#0", score: 0.2 },
      { index: 2, label: "#2", score: 0.1 },
    ]);
  });

  it("logits use the stable softmax", () => {
    const out = postprocessClassification([2, 1, 0.1], cls("logits"));
    const e = [Math.exp(0), Math.exp(1 - 2), Math.exp(0.1 - 2)];
    const s = e.reduce((a, b) => a + b, 0);
    expect(out.map((x) => x.index)).toEqual([0, 1, 2]);
    out.forEach((x, i) => expect(Math.abs(x.score - e[i]! / s)).toBeLessThan(1e-12));
    expect(out.reduce((a, x) => a + x.score, 0)).toBeCloseTo(1, 12);
  });

  it("huge logits do not overflow, a very negative one is exactly 0 and is kept by the default minScore", () => {
    const out = postprocessClassification([1000, 1000, -5000], cls("logits"));
    expect(out).toEqual([
      { index: 0, label: "#0", score: 0.5 },
      { index: 1, label: "#1", score: 0.5 },
      { index: 2, label: "#2", score: 0 },
    ]);
  });

  it("exact ties go by ascending index and topK cuts them", () => {
    const out = postprocessClassification([0, 0, 0], cls("logits"), { topK: 2 });
    expect(out.map((x) => x.index)).toEqual([0, 1]);
  });

  it("topK defaults to 5 and larger than the class count returns every class", () => {
    expect(postprocessClassification([1, 2, 3, 4, 5, 6, 7], cls("logits"))).toHaveLength(5);
    expect(postprocessClassification([1, 2], cls("logits"), { topK: 9 })).toHaveLength(2);
  });

  it("minScore is inclusive and may leave an empty list", () => {
    const p = cls("probabilities");
    expect(postprocessClassification([0.25, 0.75], p, { minScore: 0.25 }).map((x) => x.index)).toEqual([1, 0]);
    expect(postprocessClassification([0.25, 0.75], p, { minScore: 0.5 }).map((x) => x.index)).toEqual([1]);
    expect(postprocessClassification([0.25, 0.75], p, { minScore: 1 })).toEqual([]);
  });

  it("the cut by topK comes before the minScore filter", () => {
    expect(postprocessClassification([0.1, 0.9, 0.6], cls("probabilities"), { topK: 1, minScore: 0.7 }).map((x) => x.index)).toEqual([1]);
    expect(postprocessClassification([0.1, 0.9, 0.6], cls("probabilities"), { topK: 2, minScore: 0.7 }).map((x) => x.index)).toEqual([1]);
  });

  it("labels: offset only shifts the lookup, out of range falls back to #<index>", () => {
    const s = cls("probabilities", { labels: ["a", "b"], labelOffset: 1 });
    expect(postprocessClassification([0.5, 0.3, 0.2, 0.1], s, { topK: 4 })).toEqual([
      { index: 0, label: "#0", score: 0.5 },
      { index: 1, label: "a", score: 0.3 },
      { index: 2, label: "b", score: 0.2 },
      { index: 3, label: "#3", score: 0.1 },
    ]);
    expect(postprocessClassification([1], cls("probabilities", { labels: [], labelOffset: -2 }))[0]!.label).toBe("#0");
  });

  it("minus zero is accepted for minScore and labelOffset", () => {
    expect(postprocessClassification([0.5, 0.5], cls("probabilities", { labels: ["a", "b"], labelOffset: -0 }), { minScore: -0 })).toHaveLength(2);
  });

  it("a single class gets probability 1", () => {
    expect(postprocessClassification([-3], cls("logits"))).toEqual([{ index: 0, label: "#0", score: 1 }]);
  });

  it("invalid_output: empty, non-finite, negative probability, not an array", () => {
    expect(kindOf(() => postprocessClassification([], cls("logits")))).toBe("invalid_output");
    for (const v of [NaN, Infinity, -Infinity]) expect(kindOf(() => postprocessClassification([1, v], cls("logits")))).toBe("invalid_output");
    expect(kindOf(() => postprocessClassification([0.5, -0.1], cls("probabilities")))).toBe("invalid_output");
    expect(kindOf(() => postprocessClassification([1, "2" as unknown as number], cls("logits")))).toBe("invalid_output");
    expect(kindOf(() => postprocessClassification(null as unknown as number[], cls("logits")))).toBe("invalid_output");
    expect(kindOf(() => postprocessClassification([-1, 1], cls("logits")))).toBe("no error");
  });

  it("invalid_options: options, null included, before the output is looked at", () => {
    const p = cls("probabilities");
    for (const o of [{ topK: 0 }, { topK: 1.5 }, { topK: null }, { topK: "1" }, { minScore: -0.1 }, { minScore: 1.1 }, { minScore: null }, { minScore: NaN }]) {
      expect(kindOf(() => postprocessClassification([], p, o as never))).toBe("invalid_options");
    }
    expect(kindOf(() => postprocessClassification([0.5], p, null as never))).toBe("invalid_options");
    expect(kindOf(() => postprocessClassification([0.5], p, { topK: undefined }))).toBe("no error");
  });

  it("a detector spec is invalid_options, a broken spec is invalid_spec", () => {
    const det = parseModelSpec({ input, output: { format: "ssd" } });
    expect(kindOf(() => postprocessClassification([1], det))).toBe("invalid_options");
    expect(kindOf(() => postprocessClassification([1], {} as never))).toBe("invalid_spec");
  });

  it("does not mutate the output vector or the spec", () => {
    const out = [3, 1, 2];
    const s = cls("logits", { labels: ["x"] });
    const before = JSON.stringify(s);
    postprocessClassification(out, s);
    expect(out).toEqual([3, 1, 2]);
    expect(JSON.stringify(s)).toBe(before);
  });
});

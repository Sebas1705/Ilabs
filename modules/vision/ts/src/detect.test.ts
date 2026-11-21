import { describe, expect, it } from "vitest";
import { postprocessDetections } from "./detect.js";
import { VisionError } from "./errors.js";
import { preprocessGeometry } from "./geometry.js";
import { parseModelSpec } from "./spec.js";
import type { Tensor } from "./tensor.js";

type Opts = Parameters<typeof postprocessDetections>[4];

function kindOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(VisionError);
    return (e as VisionError).kind;
  }
  return "no error";
}

const t = (shape: number[], data: number[]): Tensor => ({ shape, data });

/** Decodes with a 200x100 model input and a 200x100 source (identity geometry) unless told otherwise. */
function decode(
  outputs: Record<string, Tensor>,
  output: Record<string, unknown>,
  options?: Opts,
  extra: { labels?: string[]; labelOffset?: number; mode?: string; src?: [number, number]; inp?: [number, number] } = {},
) {
  const [iw, ih] = extra.inp ?? [200, 100];
  const [sw, sh] = extra.src ?? [200, 100];
  const spec = parseModelSpec({
    input: { width: iw, height: ih, layout: "nhwc", channels: "rgb", mode: extra.mode ?? "stretch", resample: "nearest", dtype: "float" },
    output,
    ...(extra.labels !== undefined ? { labels: extra.labels } : {}),
    ...(extra.labelOffset !== undefined ? { labelOffset: extra.labelOffset } : {}),
  });
  return postprocessDetections(outputs, spec, preprocessGeometry(sw, sh, spec), { width: sw, height: sh }, options);
}

const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);

describe("ssd decoder", () => {
  it("yxyx normalized scales by the MODEL input size, batched shapes", () => {
    const out = decode(
      { boxes: t([1, 2, 4], [0.1, 0.2, 0.5, 0.6, 0, 0, 1, 1]), classes: t([1, 2], [1, 0]), scores: t([1, 2], [0.9, 0.1]) },
      { format: "ssd" },
      undefined,
      { inp: [200, 100], src: [400, 300] },
    );
    expect(out).toHaveLength(1);
    const d = out[0]!;
    near(d.box.x1, (0.2 * 200) / 0.5);
    near(d.box.y1, (0.1 * 100) / (100 / 300));
    near(d.box.x2, (0.6 * 200) / 0.5);
    near(d.box.y2, (0.5 * 100) / (100 / 300));
    expect(d).toMatchObject({ classIndex: 1, label: "#1", score: 0.9 });
  });

  it("xyxy pixels without a batch dimension, no labels", () => {
    const out = decode({ boxes: t([1, 4], [10, 20, 30, 40]), classes: t([1], [3]), scores: t([1], [0.5]) }, { format: "ssd", boxOrder: "xyxy", coordinates: "pixels" });
    expect(out).toEqual([{ box: { x1: 10, y1: 20, x2: 30, y2: 40 }, classIndex: 3, label: "#3", score: 0.5 }]);
  });

  const four = {
    boxes: t([4, 4], [0, 0, 10, 10, 0, 0, 20, 20, 0, 0, 30, 30, 0, 0, 40, 40]),
    classes: t([4], [0, 0, 0, 0]),
    scores: t([4], [0.9, 0.8, 0.7, 0.6]),
  };
  const px = { format: "ssd", boxOrder: "xyxy", coordinates: "pixels" };

  it("count truncates, clamps and may be negative; shape [] or [1] only", () => {
    expect(decode({ ...four, count: t([1], [2.9]) }, px)).toHaveLength(2);
    expect(decode({ ...four, count: t([], [10]) }, px)).toHaveLength(4);
    expect(decode({ ...four, count: t([1], [-3]) }, px)).toHaveLength(0);
    expect(kindOf(() => decode({ ...four, count: t([2], [1, 1]) }, px))).toBe("invalid_output");
    expect(kindOf(() => decode({ ...four, count: t([1, 1], [1]) }, px))).toBe("invalid_output");
    expect(kindOf(() => decode({ ...four, count: t([1], [NaN]) }, px))).toBe("invalid_output");
  });

  it("rows beyond count are not examined at all", () => {
    const o = {
      boxes: t([2, 4], [0, 0, 10, 10, NaN, 0, 1, 1]),
      classes: t([2], [0, 99]),
      scores: t([2], [0.9, 0.9]),
      count: t([1], [1]),
    };
    expect(decode(o, px, undefined, { labels: ["a"] })).toHaveLength(1);
    expect(kindOf(() => decode({ ...o, count: t([1], [2]) }, px, undefined, { labels: ["a"] }))).toBe("invalid_output");
  });

  it("class ids: validated on every examined row before the threshold", () => {
    const base = (cls: number) => ({ boxes: t([1, 4], [0, 0, 1, 1]), classes: t([1], [cls]), scores: t([1], [0.01]) });
    for (const c of [-1, 1.5, 2147483648, NaN, Infinity]) expect(kindOf(() => decode(base(c), px))).toBe("invalid_output");
    expect(kindOf(() => decode(base(2147483647), px))).toBe("no error");
    expect(kindOf(() => decode(base(2), px, undefined, { labels: ["a", "b"] }))).toBe("invalid_output");
    expect(kindOf(() => decode(base(0), px, undefined, { labels: [] }))).toBe("invalid_output");
    expect(kindOf(() => decode(base(0), px, undefined, { labels: ["a"], labelOffset: 1 }))).toBe("invalid_output");
    expect(kindOf(() => decode(base(1), px, undefined, { labels: ["a"], labelOffset: 1 }))).toBe("no error");
  });

  it("a -0 class id is accepted", () => {
    const out = decode({ boxes: t([1, 4], [0, 0, 10, 10]), classes: t([1], [-0]), scores: t([1], [0.9]) }, px, undefined, { labels: ["a"] });
    expect(out[0]!.label).toBe("a");
  });

  it("labelOffset shifts the lookup, classIndex stays the model id", () => {
    const out = decode({ boxes: t([1, 4], [0, 0, 10, 10]), classes: t([1], [1]), scores: t([1], [0.9]) }, px, undefined, { labels: ["person", "car"], labelOffset: 1 });
    expect(out[0]).toMatchObject({ classIndex: 1, label: "person" });
  });

  it("threshold is inclusive; sort by score, equal scores by row; maxDetections cuts after the sort", () => {
    const o = { boxes: t([4, 4], [0, 0, 1, 1, 0, 0, 2, 2, 0, 0, 3, 3, 0, 0, 4, 4]), classes: t([4], [0, 1, 2, 3]), scores: t([4], [0.5, 0.6, 0.5, 0.49]) };
    expect(decode(o, px, { scoreThreshold: 0.5 }).map((d) => d.classIndex)).toEqual([1, 0, 2]);
    expect(decode(o, px, { scoreThreshold: 0.5, maxDetections: 2 }).map((d) => d.classIndex)).toEqual([1, 0]);
  });

  it("swaps each axis independently, ssd runs no NMS unless asked", () => {
    const o = { boxes: t([2, 4], [30, 20, 10, 40, 0, 0, 10, 10]), classes: t([2], [0, 0]), scores: t([2], [0.9, 0.8]) };
    const out = decode(o, px);
    expect(out[0]!.box).toEqual({ x1: 10, y1: 20, x2: 30, y2: 40 });
    const both = decode({ ...o, boxes: t([2, 4], [30, 40, 10, 20, 0, 0, 10, 10]) }, px);
    expect(both[0]!.box).toEqual({ x1: 10, y1: 20, x2: 30, y2: 40 });
    expect(decode({ ...o, boxes: t([2, 4], [0, 0, 10, 10, 0, 0, 10, 9]) }, px)).toHaveLength(2);
    expect(decode({ ...o, boxes: t([2, 4], [0, 0, 10, 10, 0, 0, 10, 9]) }, px, { nms: true })).toHaveLength(1);
  });

  it("n = 0 is valid", () => {
    expect(decode({ boxes: t([1, 0, 4], []), classes: t([1, 0], []), scores: t([1, 0], []) }, px)).toEqual([]);
  });

  it("invalid_output: missing tensors, wrong shapes, length mismatch, negative dimensions, non-finite", () => {
    const ok = four;
    for (const k of ["boxes", "classes", "scores"]) {
      const o = { ...ok } as Record<string, Tensor>;
      delete o[k];
      expect(kindOf(() => decode(o, px))).toBe("invalid_output");
    }
    expect(kindOf(() => decode({ ...ok, boxes: t([2, 4, 4], new Array(32).fill(0)) }, px))).toBe("invalid_output");
    expect(kindOf(() => decode({ ...ok, boxes: t([16], new Array(16).fill(0)) }, px))).toBe("invalid_output");
    expect(kindOf(() => decode({ ...ok, boxes: t([4, 3], new Array(12).fill(0)) }, px))).toBe("invalid_output");
    expect(kindOf(() => decode({ ...ok, classes: t([2, 4], new Array(8).fill(0)) }, px))).toBe("invalid_output");
    expect(kindOf(() => decode({ ...ok, scores: t([3], [0.1, 0.1, 0.1]) }, px))).toBe("invalid_output");
    expect(kindOf(() => decode({ ...ok, scores: t([4], [0.1, 0.1, 0.1]) }, px))).toBe("invalid_output");
    expect(kindOf(() => decode({ ...ok, scores: t([-4], []) }, px))).toBe("invalid_output");
    expect(kindOf(() => decode({ ...ok, scores: t([4], [0.1, 0.1, 0.1, NaN]) }, px))).toBe("invalid_output");
    expect(kindOf(() => decode({ ...ok, scores: t([4], [0.1, 0.1, 0.1, Infinity]) }, px))).toBe("invalid_output");
    expect(kindOf(() => decode({ ...ok, boxes: t([4, 4], [0, 0, 1, Infinity, ...new Array(12).fill(0)]) }, px))).toBe("invalid_output");
    expect(kindOf(() => decode({ boxes: t([1, 4], [0, 0, 1, 1e308]), classes: t([1], [0]), scores: t([1], [0.9]) }, { format: "ssd" }))).toBe("invalid_output");
    expect(kindOf(() => decode({ ...ok, scores: { shape: [4], data: "x" } as unknown as Tensor }, px))).toBe("invalid_output");
  });
});

describe("rows decoder", () => {
  const rowsSpec = { format: "rows" };

  it("xywh: best class per row, lowest index on ties", () => {
    const out = decode(
      { rows: t([3, 6], [100, 50, 20, 10, 0.6, 0.6, 100, 50, 20, 10, 0.1, 0.7, 1, 1, 2, 2, 0.1, 0.1]) },
      rowsSpec,
    );
    // rows 0 and 1 have the same box and different classes (0 and 1): NMS is class aware, both survive
    expect(out.map((d) => [d.classIndex, d.score])).toEqual([
      [1, 0.7],
      [0, 0.6],
    ]);
    expect(out[0]!.box).toEqual({ x1: 90, y1: 45, x2: 110, y2: 55 });
  });

  it("xyxy boxes are taken as they are", () => {
    const out = decode({ rows: t([1, 5], [1, 2, 30, 40, 0.9]) }, { format: "rows", boxFormat: "xyxy" });
    expect(out[0]!.box).toEqual({ x1: 1, y1: 2, x2: 30, y2: 40 });
  });

  it("transposed with a batch dimension reads column j of row i at j * b + i", () => {
    // 6 columns (4 box + 2 classes), 2 rows
    const data = [50, 150, /*cx*/ 50, 50, /*cy*/ 20, 20, /*w*/ 10, 10, /*h*/ 0.9, 0.1, /*c0*/ 0.1, 0.8 /*c1*/];
    const out = decode({ rows: t([1, 6, 2], data) }, { format: "rows", transposed: true });
    expect(out.map((d) => [d.classIndex, d.score, d.box.x1])).toEqual([
      [0, 0.9, 40],
      [1, 0.8, 140],
    ]);
  });

  it("objectness multiplies the class scores", () => {
    const out = decode({ rows: t([2, 6], [50, 50, 10, 10, 0.5, 0.9, 50, 50, 10, 10, 0.2, 0.9]) }, { format: "rows", objectness: true, boxFormat: "xywh" }, { nms: false });
    expect(out).toHaveLength(1);
    near(out[0]!.score, 0.45);
  });

  it("sigmoid applies before objectness, exp(0 - z) overflow stays finite", () => {
    const out = decode({ rows: t([3, 6], [50, 50, 10, 10, 0, 2, 150, 50, 10, 10, 1000, -1000, 90, 90, 10, 10, -2, -2]) }, { format: "rows", scoreActivation: "sigmoid" });
    const logistic = (z: number) => 1 / (1 + Math.exp(0 - z));
    expect(out.map((d) => [d.classIndex, d.score])).toEqual([
      [0, 1],
      [1, logistic(2)],
    ]);
    const withObj = decode({ rows: t([1, 6], [50, 50, 10, 10, 0, 2]) }, { format: "rows", scoreActivation: "sigmoid", objectness: true });
    near(withObj[0]!.score, logistic(0) * logistic(2));
  });

  it("class-aware NMS is on by default for rows and the option turns it off", () => {
    const rows = t([2, 6], [50, 50, 20, 20, 0.9, 0.1, 52, 52, 20, 20, 0.8, 0.1]);
    expect(decode({ rows }, rowsSpec)).toHaveLength(1);
    expect(decode({ rows }, rowsSpec, { nms: false })).toHaveLength(2);
    expect(decode({ rows }, rowsSpec, { iouThreshold: 1 })).toHaveLength(2);
  });

  it("an empty rows tensor gives no detections; shapes [a, b] and [1, a, b]", () => {
    expect(decode({ rows: t([0, 6], []) }, rowsSpec)).toEqual([]);
    expect(decode({ rows: t([1, 0, 6], []) }, rowsSpec)).toEqual([]);
    expect(decode({ rows: t([1, 6, 0], []) }, { format: "rows", transposed: true })).toEqual([]);
  });

  it("invalid_output: no class column, too few columns, batch 2, rank, missing tensor, non-finite anywhere", () => {
    expect(kindOf(() => decode({ rows: t([1, 4], [1, 2, 3, 4]) }, rowsSpec))).toBe("invalid_output");
    expect(kindOf(() => decode({ rows: t([1, 5], [1, 2, 3, 4, 5]) }, { format: "rows", objectness: true }))).toBe("invalid_output");
    expect(kindOf(() => decode({ rows: t([2, 1, 5], new Array(10).fill(0)) }, rowsSpec))).toBe("invalid_output");
    expect(kindOf(() => decode({ rows: t([10], new Array(10).fill(0)) }, rowsSpec))).toBe("invalid_output");
    expect(kindOf(() => decode({ boxes: t([1, 5], [1, 2, 3, 4, 5]) }, rowsSpec))).toBe("invalid_output");
    expect(kindOf(() => decode({ rows: t([1, 6], [1, 2, 3, 4, 0.9, NaN]) }, rowsSpec))).toBe("invalid_output");
    expect(kindOf(() => decode({ rows: t([1, 5], [1.7e308, 0, 1.7e308, 10, 0.9]) }, rowsSpec))).toBe("invalid_output");
    expect(kindOf(() => decode({ rows: t([1, 6], [1, 2, 3, 4, 0.9, 0.1]) }, rowsSpec, undefined, { labels: [] }))).toBe("invalid_output");
    expect(kindOf(() => decode({ rows: t([1, 5], [1, 2, 3, 4, 0.01]) }, rowsSpec, undefined, { labels: ["a"], labelOffset: 3 }))).toBe("invalid_output");
  });

  it("labels apply to the best class of every row", () => {
    const out = decode({ rows: t([1, 6], [50, 50, 10, 10, 0.1, 0.9]) }, rowsSpec, undefined, { labels: ["a", "b"] });
    expect(out[0]).toMatchObject({ classIndex: 1, label: "b" });
  });
});

describe("detection order and unmapping", () => {
  const px = { format: "ssd", boxOrder: "xyxy", coordinates: "pixels" };

  it("NMS before the cut: a suppressed box does not take a slot", () => {
    const o = {
      boxes: t([3, 4], [0, 0, 10, 10, 0, 0, 10, 10, 50, 50, 60, 60]),
      classes: t([3], [0, 0, 1]),
      scores: t([3], [0.9, 0.85, 0.8]),
    };
    expect(decode(o, px, { nms: true, maxDetections: 2 }).map((d) => d.classIndex)).toEqual([0, 1]);
  });

  it("boxes in the padding are dropped after the cut, partly padded ones are clamped", () => {
    // 100x100 letterbox of a 200x100 source: scale 0.5, padY 25
    const o = {
      boxes: t([3, 4], [0, 0, 100, 20, 0, 20, 100, 40, 0, 60, 50, 90]),
      classes: t([3], [0, 1, 2]),
      scores: t([3], [0.9, 0.8, 0.7]),
    };
    const out = decode(o, px, undefined, { mode: "letterbox", inp: [100, 100], src: [200, 100] });
    expect(out.map((d) => d.classIndex)).toEqual([1, 2]);
    expect(out[0]!.box).toEqual({ x1: 0, y1: 0, x2: 200, y2: 30 });
    // the cut comes before the drop: with maxDetections 1 the dropped box still used the slot
    expect(decode(o, px, { maxDetections: 1 }, { mode: "letterbox", inp: [100, 100], src: [200, 100] })).toHaveLength(0);
    expect(decode(o, px, { maxDetections: 2 }, { mode: "letterbox", inp: [100, 100], src: [200, 100] })).toHaveLength(1);
  });
});

describe("options and kinds", () => {
  const px = { format: "ssd", boxOrder: "xyxy", coordinates: "pixels" };
  const o = { boxes: t([1, 4], [0, 0, 10, 10]), classes: t([1], [0]), scores: t([1], [0.9]) };

  it("defaults: score threshold 0.3, 100 detections", () => {
    const many = {
      boxes: t([120, 4], new Array(120).fill([0, 0, 10, 10]).flat()),
      classes: t([120], new Array(120).fill(0)),
      scores: t([120], new Array(120).fill(0.3)),
    };
    expect(decode(many, px)).toHaveLength(100);
    expect(decode({ ...many, scores: t([120], new Array(120).fill(0.29)) }, px)).toHaveLength(0);
  });

  it("validates all four options even when nms is false, null included (invalid_options before the output)", () => {
    const bad = { boxes: t([1, 4], [0, 0, 1, 1]) };
    for (const opt of [
      { scoreThreshold: -0.1 },
      { scoreThreshold: 1.1 },
      { scoreThreshold: null },
      { iouThreshold: 2 },
      { iouThreshold: null },
      { maxDetections: 0 },
      { maxDetections: 1.5 },
      { maxDetections: null },
      { nms: null },
      { nms: 1 },
      { nms: "true" },
    ]) {
      expect(kindOf(() => decode(bad, px, { nms: false, ...opt } as never))).toBe("invalid_options");
    }
    expect(kindOf(() => decode(o, px, null as never))).toBe("invalid_options");
  });

  it("a classifier spec is invalid_options, a broken spec invalid_spec, a bad source size invalid_options", () => {
    const cls = parseModelSpec({ input: { width: 1, height: 1, layout: "nhwc", channels: "rgb", mode: "stretch", resample: "nearest", dtype: "float" }, output: { type: "logits" } });
    const g = { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0, newWidth: 1, newHeight: 1 };
    expect(kindOf(() => postprocessDetections(o, cls, g, { width: 1, height: 1 }))).toBe("invalid_options");
    expect(kindOf(() => postprocessDetections(o, {} as never, g, { width: 1, height: 1 }))).toBe("invalid_spec");
    const det = parseModelSpec({ input: cls.input, output: px });
    for (const s of [{ width: 0, height: 1 }, { width: 1, height: 16385 }, { width: null, height: 1 }]) {
      expect(kindOf(() => postprocessDetections(o, det, g, s as never))).toBe("invalid_options");
    }
  });

  it("does not mutate outputs, spec or options", () => {
    const outputs = JSON.parse(JSON.stringify(o));
    const options = { scoreThreshold: 0.1 };
    decode(outputs, px, options);
    expect(outputs).toEqual(o);
    expect(options).toEqual({ scoreThreshold: 0.1 });
  });
});

import { describe, expect, it } from "vitest";
import { VisionError } from "./errors.js";
import { averagePrecision, meanAveragePrecision, topKAccuracy, type MetricDetection, type MetricTruth } from "./metrics.js";
import type { Box } from "./nms.js";

function kindOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(VisionError);
    return (e as VisionError).kind;
  }
  return "no error";
}

const box = (x1: number, y1: number, x2: number, y2: number): Box => ({ x1, y1, x2, y2 });
const B = box(0, 0, 10, 10);
const det = (image: string, classIndex: number, score: number, b: Box = B): MetricDetection => ({ image, classIndex, score, box: b });
const truth = (image: string, classIndex: number, b: Box = B): MetricTruth => ({ image, classIndex, box: b });
const opts = { iouThreshold: 0.5 };

describe("topKAccuracy", () => {
  it("counts the samples whose truth is in the first k entries", () => {
    expect(topKAccuracy([[1, 2, 3], [4, 5, 6], [7, 8, 9], [1, 0]], [2, 6, 1, 0], 2)).toBe(2 / 4);
    expect(topKAccuracy([[1, 2, 3], [4, 5, 6]], [3, 4], 3)).toBe(1);
  });
  it("k larger than the lists searches only what exists; no samples give 0", () => {
    expect(topKAccuracy([[1]], [1], 5)).toBe(1);
    expect(topKAccuracy([], [], 1)).toBe(0);
  });
  it("invalid_options: k and lengths", () => {
    for (const k of [0, -1, 1.5, null, NaN, "1"]) expect(kindOf(() => topKAccuracy([[1]], [1], k as number))).toBe("invalid_options");
    expect(kindOf(() => topKAccuracy([[1]], [], 1))).toBe("invalid_options");
    expect(kindOf(() => topKAccuracy(null as never, [], 1))).toBe("invalid_options");
  });
  it("does not mutate", () => {
    const p = [[3, 2, 1]];
    topKAccuracy(p, [1], 3);
    expect(p).toEqual([[3, 2, 1]]);
  });
});

describe("averagePrecision", () => {
  it("a perfect detector has AP 1", () => {
    expect(averagePrecision([det("a", 0, 0.9)], [truth("a", 0)], opts)).toEqual({ byClass: [{ classIndex: 0, ap: 1 }] });
  });

  it("the envelope example: FP, TP, FP, TP, TP over three truths gives 0.6", () => {
    const far = box(100, 100, 110, 110);
    const t1 = box(0, 0, 10, 10);
    const t2 = box(20, 0, 30, 10);
    const t3 = box(40, 0, 50, 10);
    const truths = [truth("a", 0, t1), truth("a", 0, t2), truth("a", 0, t3)];
    const detections = [det("a", 0, 0.2, t3), det("a", 0, 0.9, far), det("a", 0, 0.8, t1), det("a", 0, 0.7, far), det("a", 0, 0.6, t2)];
    // sorted: 0.9 FP, 0.8 TP, 0.7 FP, 0.6 TP, 0.2 TP
    const { byClass } = averagePrecision(detections, truths, opts);
    expect(byClass[0]!.ap).toBeCloseTo(0.6, 12);
  });

  it("a duplicate is a false positive, the best truth only (no fallback)", () => {
    const dup = averagePrecision([det("a", 0, 0.9), det("a", 0, 0.8)], [truth("a", 0)], opts);
    expect(dup.byClass[0]!.ap).toBe(1);
    // the best-IoU truth is taken: the second detection overlaps truth 1 best, never falls back to truth 2
    const t1 = box(0, 0, 10, 10);
    const t2 = box(2, 0, 12, 10);
    const r = averagePrecision([det("a", 0, 0.9, t1), det("a", 0, 0.8, box(1, 0, 11, 10))], [truth("a", 0, t1), truth("a", 0, t2)], { iouThreshold: 0.5 });
    expect(r.byClass[0]!.ap).toBeCloseTo(0.5, 12);
  });

  it("detections and truths only meet on the same image and class", () => {
    const r = averagePrecision([det("a", 0, 0.9), det("b", 0, 0.8)], [truth("a", 0), truth("b", 0)], opts);
    expect(r.byClass[0]!.ap).toBe(1);
    expect(averagePrecision([det("b", 0, 0.9)], [truth("a", 0)], opts).byClass[0]!.ap).toBe(0);
  });

  it("the IoU test is inclusive; with 0 a disjoint box is a true positive; equal IoU takes the first truth", () => {
    const half = box(0, 0, 10, 5);
    expect(averagePrecision([det("a", 0, 0.9, half)], [truth("a", 0)], { iouThreshold: 0.5 }).byClass[0]!.ap).toBe(1);
    expect(averagePrecision([det("a", 0, 0.9, box(50, 50, 60, 60))], [truth("a", 0)], { iouThreshold: 0 }).byClass[0]!.ap).toBe(1);
    const r = averagePrecision([det("a", 0, 0.9, box(5, 0, 10, 10)), det("a", 0, 0.8, box(5, 0, 10, 10))], [truth("a", 0, box(0, 0, 10, 10)), truth("a", 0, box(0, 0, 10, 10))], opts);
    expect(r.byClass[0]!.ap).toBeCloseTo(0.5 + 0, 12);
  });

  it("equal scores keep input order (the first one is matched first)", () => {
    const t = [truth("a", 0)];
    const hit = det("a", 0, 0.5);
    const miss = det("a", 0, 0.5, box(100, 100, 110, 110));
    expect(averagePrecision([hit, miss], t, opts).byClass[0]!.ap).toBe(1);
    expect(averagePrecision([miss, hit], t, opts).byClass[0]!.ap).toBe(0.5);
  });

  it("classes: only classes with truths, ascending; a class without detections has AP 0", () => {
    const r = averagePrecision([det("a", 5, 0.9), det("a", 2, 0.9)], [truth("a", 2), truth("a", 1)], opts);
    expect(r.byClass).toEqual([
      { classIndex: 1, ap: 0 },
      { classIndex: 2, ap: 1 },
    ]);
  });

  it("invalid_options: threshold and entries", () => {
    for (const v of [-0.1, 1.1, null, NaN, undefined, "0.5"]) expect(kindOf(() => averagePrecision([], [], { iouThreshold: v as number }))).toBe("invalid_options");
    expect(kindOf(() => averagePrecision([], [], null as never))).toBe("invalid_options");
    const bad: Array<[unknown, unknown]> = [
      [{ ...det("a", 0, NaN) }, truth("a", 0)],
      [{ ...det("a", 0, 0.5), box: box(0, 0, 1, Infinity) }, truth("a", 0)],
      [{ ...det("a", 0, 0.5), image: 1 }, truth("a", 0)],
      [{ ...det("a", 0, 0.5), classIndex: -1 }, truth("a", 0)],
      [{ ...det("a", 0, 0.5), classIndex: 1.5 }, truth("a", 0)],
      [det("a", 0, 0.5), { ...truth("a", 0), classIndex: 0.5 }],
      [det("a", 0, 0.5), { ...truth("a", 0), box: box(NaN, 0, 1, 1) }],
      [det("a", 0, 0.5), { ...truth("a", 0), image: null }],
      [{ ...det("a", 0, 0.5), classIndex: 2147483648 }, truth("a", 0)],
      [det("a", 0, 0.5), { ...truth("a", 0), classIndex: 2147483648 }],
      [null, truth("a", 0)],
    ];
    for (const [d, t] of bad) {
      expect(kindOf(() => averagePrecision([d] as never, [t] as never, opts))).toBe("invalid_options");
      expect(kindOf(() => meanAveragePrecision([d] as never, [t] as never, opts))).toBe("invalid_options");
    }
  });

  it("does not mutate", () => {
    const ds = [det("a", 0, 0.5), det("a", 0, 0.9)];
    const copy = JSON.stringify(ds);
    averagePrecision(ds, [truth("a", 0)], opts);
    expect(JSON.stringify(ds)).toBe(copy);
  });
});

describe("meanAveragePrecision", () => {
  it("averages the classes with truths, ignoring classes with detections only", () => {
    const r = meanAveragePrecision([det("a", 0, 0.9), det("a", 1, 0.9, box(100, 100, 110, 110)), det("a", 7, 0.9)], [truth("a", 0), truth("a", 1)], opts);
    expect(r.byClass).toEqual([
      { classIndex: 0, ap: 1 },
      { classIndex: 1, ap: 0 },
    ]);
    expect(r.map).toBe(0.5);
  });
  it("no truths give 0, no detections count as 0", () => {
    expect(meanAveragePrecision([det("a", 0, 0.9)], [], opts)).toEqual({ map: 0, byClass: [] });
    expect(meanAveragePrecision([], [truth("a", 3)], opts).map).toBe(0);
  });
});

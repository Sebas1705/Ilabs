import { describe, expect, it } from "vitest";
import { VisionError } from "./errors.js";
import { iou, iouRaw, nms, nmsKeep, type Box, type Detection } from "./nms.js";

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
const det = (b: Box, score: number, classIndex = 0, label = `L${classIndex}`): Detection => ({ box: b, classIndex, label, score });

describe("iou", () => {
  it("partial, disjoint, identical, contained", () => {
    expect(iou(box(0, 0, 10, 10), box(5, 5, 15, 15))).toBe(25 / 175);
    expect(iou(box(0, 0, 10, 10), box(20, 20, 30, 30))).toBe(0);
    expect(iou(box(0, 0, 10, 10), box(0, 0, 10, 10))).toBe(1);
    expect(iou(box(0, 0, 10, 10), box(3, 3, 7, 7))).toBe(16 / 100);
  });
  it("edge or corner contact is intersection 0", () => {
    expect(iou(box(0, 0, 10, 10), box(10, 0, 20, 10))).toBe(0);
    expect(iou(box(0, 0, 10, 10), box(10, 10, 20, 20))).toBe(0);
  });
  it("two identical zero-area boxes give 0, never a division by zero", () => {
    expect(iou(box(5, 5, 5, 5), box(5, 5, 5, 5))).toBe(0);
  });
  it("never reorders corners: swapped identical boxes give 0", () => {
    expect(iou(box(10, 10, 0, 0), box(10, 10, 0, 0))).toBe(0);
    expect(iou(box(10, 0, 0, 10), box(10, 0, 0, 10))).toBe(0);
  });
  it("a non-finite coordinate is invalid_options", () => {
    for (const v of [NaN, Infinity, -Infinity, "1", null]) {
      expect(kindOf(() => iou(box(0, 0, 1, v as number), box(0, 0, 1, 1)))).toBe("invalid_options");
      expect(kindOf(() => iou(box(0, 0, 1, 1), box(v as number, 0, 1, 1)))).toBe("invalid_options");
    }
    expect(kindOf(() => iou(null as never, box(0, 0, 1, 1)))).toBe("invalid_options");
  });
});

describe("nms", () => {
  it("returns the survivors in INPUT order (a subsequence)", () => {
    const list = [det(box(0, 0, 10, 10), 0.5), det(box(0, 0, 10, 10), 0.9), det(box(50, 50, 60, 60), 0.1)];
    expect(nms(list, 0.5)).toEqual([list[1], list[2]]);
  });
  it("is class aware", () => {
    const list = [det(box(0, 0, 10, 10), 0.9, 0), det(box(0, 0, 10, 10), 0.8, 1), det(box(0, 0, 10, 10), 0.7, 0)];
    expect(nms(list, 0.5).map((d) => d.classIndex)).toEqual([0, 1]);
  });
  it("the boundary is strict", () => {
    // IoU exactly 0.5: 50 / (100 + 100 - 50) is not 0.5, use 10x10 against 10x5 (inter 50, union 100)
    const list = [det(box(0, 0, 10, 10), 0.9), det(box(0, 0, 10, 5), 0.8)];
    expect(iou(list[0]!.box, list[1]!.box)).toBe(0.5);
    expect(nms(list, 0.5)).toHaveLength(2);
    expect(nms(list, 0.49)).toHaveLength(1);
  });
  it("equal scores: the lower input position wins", () => {
    const list = [det(box(0, 0, 10, 10), 0.5), det(box(0, 0, 10, 10), 0.5)];
    expect(nms(list, 0.5)).toEqual([list[0]]);
  });
  it("a suppressed box never suppresses", () => {
    const a = det(box(0, 0, 10, 10), 0.9);
    const b = det(box(4, 0, 14, 10), 0.8); // IoU with a: 60 / 140 = 0.43 (< 0.45? no, > 0.4)
    const c = det(box(8, 0, 18, 10), 0.7); // IoU with b: 0.43, with a: 20 / 180 = 0.11
    expect(nms([a, b, c], 0.4)).toEqual([a, c]);
  });
  it("threshold 1 keeps identical boxes, threshold 0 suppresses any overlap but not contact", () => {
    const same = [det(box(0, 0, 10, 10), 0.9), det(box(0, 0, 10, 10), 0.8)];
    expect(nms(same, 1)).toHaveLength(2);
    expect(nms(same, 0)).toHaveLength(1);
    const touch = [det(box(0, 0, 10, 10), 0.9), det(box(10, 0, 20, 10), 0.8), det(box(10, 10, 20, 20), 0.7)];
    expect(nms(touch, 0)).toHaveLength(3);
  });
  it("carries every field through unchanged and returns new objects", () => {
    const d = { ...det(box(1, 2, 3, 4), 0.5, 7, "seven"), extra: 1 };
    const [out] = nms([d], 0.5) as Array<typeof d>;
    expect(out).toEqual(d);
    expect(out).not.toBe(d);
    expect(out!.box).not.toBe(d.box);
  });
  it("empty in, empty out", () => expect(nms([], 0.5)).toEqual([]));
  it("validates the threshold: [0, 1], null included", () => {
    for (const v of [-0.1, 1.1, null, NaN, "0.5", undefined]) expect(kindOf(() => nms([], v as number))).toBe("invalid_options");
  });
  it("does not mutate the input", () => {
    const list = [det(box(0, 0, 10, 10), 0.5), det(box(0, 0, 10, 10), 0.9)];
    const copy = JSON.stringify(list);
    nms(list, 0.3);
    expect(JSON.stringify(list)).toBe(copy);
  });
  it("classIndex must be an integer from 0 to 2147483647", () => {
    for (const c of [-1, 1.5, 2147483648, NaN, "1"]) expect(kindOf(() => nms([det(box(0, 0, 1, 1), 0.5, c as number)], 0.5))).toBe("invalid_options");
    expect(nms([det(box(0, 0, 1, 1), 0.5, 2147483647)], 0.5)).toHaveLength(1);
  });
  it("20,000 pairwise-disjoint boxes of one class all survive (regression guard, 5 seconds)", () => {
    const list: Detection[] = [];
    for (let i = 0; i < 20_000; i++) list.push(det(box(i * 3, 0, i * 3 + 2, 2), 1 - i / 40_000));
    const start = Date.now();
    expect(nms(list, 0.5)).toHaveLength(20_000);
    expect(Date.now() - start).toBeLessThan(5000);
  });
  it("100,000 pairwise-disjoint boxes of one class all survive (regression guard, 5 seconds)", () => {
    const list: Detection[] = [];
    for (let i = 0; i < 100_000; i++) list.push(det(box(i * 3, 0, i * 3 + 2, 2), 1 - i / 200_000));
    const start = Date.now();
    expect(nms(list, 0.5)).toHaveLength(100_000);
    expect(Date.now() - start).toBeLessThan(5000);
  });
  it("100,000 candidate boxes of one class finish quickly", () => {
    const list: Detection[] = [];
    for (let i = 0; i < 100_000; i++) {
      const cluster = i % 100;
      list.push(det(box(cluster * 20, 0, cluster * 20 + 10, 10), 1 - i / 1_000_000));
    }
    const start = Date.now();
    const out = nms(list, 0.5);
    expect(out).toHaveLength(100);
    expect(Date.now() - start).toBeLessThan(5000);
  });
  it("rejects a non-finite score or box coordinate with invalid_options", () => {
    for (const v of [NaN, Infinity, -Infinity]) {
      expect(kindOf(() => nms([det(box(0, 0, 1, 1), v)], 0.5))).toBe("invalid_options");
      for (const key of ["x1", "y1", "x2", "y2"] as const) {
        const b = box(0, 0, 1, 1);
        b[key] = v;
        expect(kindOf(() => nms([det(box(5, 5, 6, 6), 0.9), det(b, 0.5, 1)], 0.5))).toBe("invalid_options");
      }
    }
    expect(kindOf(() => nms([{ box: null, classIndex: 0, label: "a", score: 0.5 } as unknown as Detection], 0.5))).toBe("invalid_options");
    expect(kindOf(() => nms([{ box: box(0, 0, 1, 1), classIndex: 0, label: "a", score: "0.5" } as unknown as Detection], 0.5))).toBe("invalid_options");
    // a NaN score never reaches the sort, whatever the list size
    const many: Detection[] = [];
    for (let i = 0; i < 3000; i++) many.push(det(box(i, 0, i + 1, 1), i % 5 === 0 ? NaN : 0.5));
    expect(kindOf(() => nms(many, 0.5))).toBe("invalid_options");
  });
});

/** The quadratic scan the sweep replaced, kept as a test-only reference. */
function naiveNmsKeep(boxes: Box[], classes: number[], scores: number[], iouThreshold: number): number[] {
  const groups = new Map<number, number[]>();
  for (let i = 0; i < boxes.length; i++) {
    const g = groups.get(classes[i]!);
    if (g === undefined) groups.set(classes[i]!, [i]);
    else g.push(i);
  }
  const kept: number[] = [];
  for (const positions of groups.values()) {
    const order = positions.sort((p, q) => (scores[p]! > scores[q]! ? -1 : scores[p]! < scores[q]! ? 1 : p - q));
    const suppressed: boolean[] = new Array<boolean>(order.length).fill(false);
    for (let i = 0; i < order.length; i++) {
      if (suppressed[i]) continue;
      const p = order[i]!;
      kept.push(p);
      for (let j = i + 1; j < order.length; j++) {
        if (!suppressed[j] && iouRaw(boxes[p]!, boxes[order[j]!]!) > iouThreshold) suppressed[j] = true;
      }
    }
  }
  return kept.sort((a, b) => a - b);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("nmsKeep sweep against the quadratic reference", () => {
  it("gives exactly the same survivors on 30,000 random cases", () => {
    const rnd = mulberry32(20261122);
    const thresholds = [0, 1e-12, 0.3, 0.5, 1];
    for (let c = 0; c < 30_000; c++) {
      const n = Math.floor(rnd() * 40);
      const classCount = 1 + Math.floor(rnd() * (c % 7 === 0 ? 12 : 3));
      const grid = c % 3 === 0; // small integer grid: touching edges, identical boxes, many ties
      const span = grid ? 6 : 100;
      const coord = () => (grid ? Math.floor(rnd() * span) : rnd() * span);
      const boxes: Box[] = [];
      const classes: number[] = [];
      const scores: number[] = [];
      for (let i = 0; i < n; i++) {
        const kind = rnd();
        const x1 = coord();
        const y1 = coord();
        let x2 = x1 + (grid ? Math.floor(rnd() * 4) : rnd() * 40);
        let y2 = y1 + (grid ? Math.floor(rnd() * 4) : rnd() * 40);
        if (kind < 0.1) x2 = x1 - rnd() * 5; // inverted in x
        else if (kind < 0.15) y2 = y1 - rnd() * 5; // inverted in y
        else if (kind < 0.25) x2 = x1; // zero width
        else if (kind < 0.3) y2 = y1; // zero height
        boxes.push(box(x1, y1, x2, y2));
        classes.push(Math.floor(rnd() * classCount));
        scores.push(c % 2 === 0 ? Math.floor(rnd() * 4) / 4 : rnd());
      }
      const t = thresholds[c % thresholds.length]!;
      expect(nmsKeep(boxes, classes, scores, t), `case ${c}`).toEqual(naiveNmsKeep(boxes, classes, scores, t));
    }
  });
  it("matches on larger inputs where the window prunes a lot and where one huge box spans everything", () => {
    const rnd = mulberry32(7);
    for (let round = 0; round < 20; round++) {
      const boxes: Box[] = [];
      const classes: number[] = [];
      const scores: number[] = [];
      for (let i = 0; i < 1500; i++) {
        const x1 = rnd() * 2000;
        boxes.push(box(x1, rnd() * 50, x1 + 1 + rnd() * 30, 60 + rnd() * 30));
        classes.push(Math.floor(rnd() * 3));
        scores.push(rnd());
      }
      if (round % 2 === 0) boxes[round] = box(-5, 0, 5000, 100);
      for (const t of [0, 0.3, 0.5, 1]) expect(nmsKeep(boxes, classes, scores, t)).toEqual(naiveNmsKeep(boxes, classes, scores, t));
    }
  });
});

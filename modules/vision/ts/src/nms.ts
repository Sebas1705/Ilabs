import { invalidOptions, isFiniteNumber, isInt } from "./errors.js";

/** A box `{ x1, y1, x2, y2 }`; `x1 < x2` and `y1 < y2` for a well-formed one, but corners are never reordered here. */
export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Detection {
  box: Box;
  /** The model's own class id (never offset). */
  classIndex: number;
  label: string;
  score: number;
}

/** Intersection over union of two boxes taken as given (no validation). */
export function iouRaw(a: Box, b: Box): number {
  const ix1 = Math.max(a.x1, b.x1);
  const iy1 = Math.max(a.y1, b.y1);
  const ix2 = Math.min(a.x2, b.x2);
  const iy2 = Math.min(a.y2, b.y2);
  const iw = ix2 - ix1;
  const ih = iy2 - iy1;
  const inter = iw <= 0 || ih <= 0 ? 0 : iw * ih;
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
  const union = areaA + areaB - inter;
  if (union <= 0) return 0;
  return inter / union;
}

function checkBox(box: unknown, what: string): void {
  if (typeof box !== "object" || box === null) invalidOptions(`${what} must be a box`);
  const o = box as Record<string, unknown>;
  for (const k of ["x1", "y1", "x2", "y2"]) {
    if (!isFiniteNumber(o[k])) invalidOptions(`${what} ${k} must be a finite number`);
  }
}

/** The intersection over union of two boxes (`invalid_options` for a non-finite coordinate). */
export function iou(a: Box, b: Box): number {
  checkBox(a, "box a");
  checkBox(b, "box b");
  return iouRaw(a, b);
}

/** Validates a threshold in `[0, 1]` (`invalid_options`); `what` names it in the message. */
export function checkUnit(value: unknown, what: string): number {
  if (typeof value !== "number" || !(value >= 0 && value <= 1)) invalidOptions(`${what} must be a number from 0 to 1`);
  return value;
}

/** The first index of the non-decreasing `values` that holds a value `>= target` (`values.length` when none). */
function lowerBound(values: number[], target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Class-aware greedy non-maximum suppression over parallel lists; returns the kept positions in ascending order.
 * Per class the candidates go by descending score (equal scores by ascending position); a kept box suppresses the
 * later, not yet suppressed boxes of its class whose IoU is strictly above the threshold.
 *
 * Scores and box coordinates must be finite (`invalid_options` otherwise). Cost: the threshold is in `[0, 1]`, so an IoU
 * strictly above it needs a positive overlap width. Per class the boxes are also kept sorted by `x1` with a running
 * maximum of `x2`, and a kept box only visits the window of that list where an overlap in x is possible. Every visited
 * pair still goes through the unchanged `iouRaw` with the strict `>` rule, so the result is exactly that of the
 * quadratic scan; a worst case where many overlapping boxes all survive stays quadratic.
 */
export function nmsKeep(boxes: Box[], classes: number[], scores: number[], iouThreshold: number): number[] {
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]!;
    if (!Number.isFinite(scores[i]) || !Number.isFinite(b.x1) || !Number.isFinite(b.y1) || !Number.isFinite(b.x2) || !Number.isFinite(b.y2)) {
      invalidOptions("detection score and box coordinates must be finite numbers");
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < boxes.length; i++) {
    const c = classes[i]!;
    const g = groups.get(c);
    if (g === undefined) groups.set(c, [i]);
    else g.push(i);
  }
  const kept: number[] = [];
  for (const positions of groups.values()) {
    const order = positions.sort((p, q) => {
      const sp = scores[p]!;
      const sq = scores[q]!;
      if (sp > sq) return -1;
      if (sp < sq) return 1;
      return p - q;
    });
    const m = order.length;
    // Ranks (indices into `order`) sorted by x1, with the prefix maximum of x2 over that list.
    const byX = new Array<number>(m);
    for (let i = 0; i < m; i++) byX[i] = i;
    byX.sort((a, b) => {
      const d = boxes[order[a]!]!.x1 - boxes[order[b]!]!.x1;
      return d < 0 ? -1 : d > 0 ? 1 : a - b;
    });
    const xs = new Array<number>(m);
    const prefixMaxX2 = new Array<number>(m);
    let running = -Infinity;
    for (let k = 0; k < m; k++) {
      const bx = boxes[order[byX[k]!]!]!;
      xs[k] = bx.x1;
      if (bx.x2 > running) running = bx.x2;
      prefixMaxX2[k] = running;
    }
    const suppressed: boolean[] = new Array<boolean>(m).fill(false);
    for (let i = 0; i < m; i++) {
      if (suppressed[i]) continue;
      const p = order[i]!;
      kept.push(p);
      const bp = boxes[p]!;
      // Before `lo` every x2 is below bp.x1; from `hi` on every x1 is at least bp.x2: no positive overlap there.
      const lo = lowerBound(prefixMaxX2, bp.x1);
      const hi = lowerBound(xs, bp.x2);
      for (let k = lo; k < hi; k++) {
        const j = byX[k]!;
        if (j <= i || suppressed[j]) continue;
        if (iouRaw(bp, boxes[order[j]!]!) > iouThreshold) suppressed[j] = true;
      }
    }
  }
  return kept.sort((a, b) => a - b);
}

/** Class-aware NMS: the survivors keep the input order; every field of a detection is carried through. */
export function nms(detections: Detection[], iouThreshold: number): Detection[] {
  const threshold = checkUnit(iouThreshold, "iouThreshold");
  if (!Array.isArray(detections)) invalidOptions("detections must be a list");
  for (const d of detections) {
    if (typeof d !== "object" || d === null) invalidOptions("detection must be an object");
    if (!isInt(d.classIndex) || d.classIndex < 0 || d.classIndex > 2147483647) invalidOptions("classIndex must be an integer from 0 to 2147483647");
    checkBox(d.box, "detection box");
    if (!isFiniteNumber(d.score)) invalidOptions("detection score must be a finite number");
  }
  const kept = nmsKeep(
    detections.map((d) => d.box),
    detections.map((d) => d.classIndex),
    detections.map((d) => d.score),
    threshold,
  );
  return kept.map((i) => {
    const d = detections[i]!;
    return { ...d, box: { ...d.box } };
  });
}

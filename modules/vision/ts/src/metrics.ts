import { invalidOptions, isFiniteNumber, isInt, isObject } from "./errors.js";
import { checkUnit, iouRaw, type Box } from "./nms.js";

export interface MetricDetection {
  /** An opaque image id. */
  image: string;
  classIndex: number;
  score: number;
  box: Box;
}

export interface MetricTruth {
  image: string;
  classIndex: number;
  box: Box;
}

export interface ClassAp {
  classIndex: number;
  ap: number;
}

/** The fraction of samples whose true class is among the first `k` ranked predictions (0 for no samples). */
export function topKAccuracy(predictions: number[][], truths: number[], k: number): number {
  if (!isInt(k) || k < 1) invalidOptions("k must be an integer of at least 1");
  if (!Array.isArray(predictions) || !Array.isArray(truths)) invalidOptions("predictions and truths must be lists");
  if (predictions.length !== truths.length) invalidOptions("predictions and truths must have the same length");
  let hits = 0;
  for (let i = 0; i < predictions.length; i++) {
    const ranked = predictions[i];
    if (!Array.isArray(ranked)) invalidOptions("every prediction must be a list");
    const limit = Math.min(k, ranked.length);
    for (let j = 0; j < limit; j++) {
      if (ranked[j] === truths[i]) {
        hits = hits + 1;
        break;
      }
    }
  }
  const n = predictions.length;
  return n === 0 ? 0 : hits / n;
}

function checkEntry(entry: unknown, withScore: boolean, what: string): void {
  if (!isObject(entry)) invalidOptions(`${what} must be an object`);
  if (typeof entry["image"] !== "string") invalidOptions(`${what} image must be a string`);
  if (!isInt(entry["classIndex"]) || entry["classIndex"] < 0 || entry["classIndex"] > 2147483647) invalidOptions(`${what} classIndex must be an integer from 0 to 2147483647`);
  if (withScore && !isFiniteNumber(entry["score"])) invalidOptions(`${what} score must be a finite number`);
  const box = entry["box"];
  if (!isObject(box)) invalidOptions(`${what} box must be an object`);
  for (const k of ["x1", "y1", "x2", "y2"]) {
    if (!isFiniteNumber(box[k])) invalidOptions(`${what} box ${k} must be a finite number`);
  }
}

function checkInputs(detections: unknown, truths: unknown, options: unknown): number {
  if (!isObject(options)) invalidOptions("options must be an object");
  const iouThreshold = checkUnit(options["iouThreshold"], "iouThreshold");
  if (!Array.isArray(detections) || !Array.isArray(truths)) invalidOptions("detections and truths must be lists");
  for (const d of detections) checkEntry(d, true, "detection");
  for (const t of truths) checkEntry(t, false, "truth");
  return iouThreshold;
}

/** VOC-style average precision of one class: all-point interpolation over the precision envelope. */
function classAp(detections: Array<{ d: MetricDetection; pos: number }>, truths: MetricTruth[], iouThreshold: number): number {
  const ordered = [...detections].sort((p, q) => {
    if (p.d.score > q.d.score) return -1;
    if (p.d.score < q.d.score) return 1;
    return p.pos - q.pos;
  });
  const byImage = new Map<string, number[]>();
  truths.forEach((t, i) => {
    const list = byImage.get(t.image);
    if (list === undefined) byImage.set(t.image, [i]);
    else list.push(i);
  });
  const taken: boolean[] = truths.map(() => false);
  const m = ordered.length;
  const precision: number[] = [0];
  const recall: number[] = [0];
  let tp = 0;
  let fp = 0;
  for (const { d } of ordered) {
    const candidates = byImage.get(d.image);
    let isTp = false;
    if (candidates !== undefined) {
      let best = candidates[0]!;
      let bestIou = iouRaw(d.box, truths[best]!.box);
      for (let k = 1; k < candidates.length; k++) {
        const value = iouRaw(d.box, truths[candidates[k]!]!.box);
        if (value > bestIou) {
          best = candidates[k]!;
          bestIou = value;
        }
      }
      if (bestIou >= iouThreshold && !taken[best]) {
        taken[best] = true;
        isTp = true;
      }
    }
    if (isTp) tp = tp + 1;
    else fp = fp + 1;
    precision.push(tp / (tp + fp));
    recall.push(tp / truths.length);
  }
  const envelope: number[] = new Array<number>(m + 1).fill(0);
  if (m > 0) envelope[m] = precision[m]!;
  for (let k = m - 1; k >= 1; k--) envelope[k] = Math.max(precision[k]!, envelope[k + 1]!);
  let ap = 0;
  for (let k = 1; k <= m; k++) ap = ap + (recall[k]! - recall[k - 1]!) * envelope[k]!;
  return ap;
}

/** Average precision per class with truths, in ascending class order. */
export function averagePrecision(detections: MetricDetection[], truths: MetricTruth[], options: { iouThreshold: number }): { byClass: ClassAp[] } {
  const iouThreshold = checkInputs(detections, truths, options);
  const truthsByClass = new Map<number, MetricTruth[]>();
  for (const t of truths) {
    const list = truthsByClass.get(t.classIndex);
    if (list === undefined) truthsByClass.set(t.classIndex, [t]);
    else list.push(t);
  }
  const detectionsByClass = new Map<number, Array<{ d: MetricDetection; pos: number }>>();
  detections.forEach((d, pos) => {
    const list = detectionsByClass.get(d.classIndex);
    if (list === undefined) detectionsByClass.set(d.classIndex, [{ d, pos }]);
    else list.push({ d, pos });
  });
  const classes = [...truthsByClass.keys()].sort((a, b) => a - b);
  return {
    byClass: classes.map((classIndex) => ({
      classIndex,
      ap: classAp(detectionsByClass.get(classIndex) ?? [], truthsByClass.get(classIndex)!, iouThreshold),
    })),
  };
}

/** The mean of the per-class average precisions over the classes that have truths (0 when none does). */
export function meanAveragePrecision(detections: MetricDetection[], truths: MetricTruth[], options: { iouThreshold: number }): { map: number; byClass: ClassAp[] } {
  const { byClass } = averagePrecision(detections, truths, options);
  let sum = 0;
  for (const c of byClass) sum = sum + c.ap;
  return { map: byClass.length === 0 ? 0 : sum / byClass.length, byClass };
}

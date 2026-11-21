import { labelOf } from "./classify.js";
import { invalidOptions, invalidOutput, isFiniteNumber, isInt, isObject, present } from "./errors.js";
import { checkSide } from "./image.js";
import { unmapBox, type Geometry } from "./geometry.js";
import { checkUnit, nmsKeep, type Box, type Detection } from "./nms.js";
import { isDetector, parseModelSpec, type DetectorOutput, type ModelSpec } from "./spec.js";
import { shapeSize, type Tensor } from "./tensor.js";

export interface DetectOptions {
  /** Default 0.3, inclusive. */
  scoreThreshold?: number;
  /** Default 0.5. */
  iouThreshold?: number;
  /** Default 100. */
  maxDetections?: number;
  /** Default `true` for `rows`, `false` for `ssd`. */
  nms?: boolean;
}

export interface ResolvedDetectOptions {
  scoreThreshold: number;
  iouThreshold: number;
  maxDetections: number;
  nms: boolean;
}

/** Validates the detection options (`null` is a bad value, `undefined` is absent) and applies the defaults. */
export function resolveDetectOptions(options: unknown, output: DetectorOutput): ResolvedDetectOptions {
  if (options !== undefined && !isObject(options)) invalidOptions("options must be an object");
  const o = options ?? {};
  const scoreThreshold = present(o, "scoreThreshold") ? checkUnit(o["scoreThreshold"], "scoreThreshold") : 0.3;
  const iouThreshold = present(o, "iouThreshold") ? checkUnit(o["iouThreshold"], "iouThreshold") : 0.5;
  let maxDetections = 100;
  if (present(o, "maxDetections")) {
    const v = o["maxDetections"];
    if (!isInt(v) || v < 1) invalidOptions("maxDetections must be an integer of at least 1");
    maxDetections = v;
  }
  let nms = output.format === "rows";
  if (present(o, "nms")) {
    const v = o["nms"];
    if (typeof v !== "boolean") invalidOptions("nms must be a boolean");
    nms = v;
  }
  return { scoreThreshold, iouThreshold, maxDetections, nms };
}

/** A decoded box in model-input pixels with its class and score, before filtering. */
interface Candidate {
  box: Box;
  classId: number;
  score: number;
  row: number;
}

/** A named tensor with consistent shape and data (`invalid_output` otherwise); element values are checked by the decoders. */
function readTensor(outputs: Record<string, unknown>, name: string): Tensor {
  if (!Object.hasOwn(outputs, name) || outputs[name] === undefined) invalidOutput(`missing tensor ${name}`);
  const t = outputs[name];
  if (!isObject(t)) invalidOutput(`tensor ${name} must be an object`);
  const size = shapeSize(t["shape"]);
  if (size === null) invalidOutput(`tensor ${name} has an invalid shape`);
  const data = t["data"];
  if (!Array.isArray(data) || data.length !== size) invalidOutput(`tensor ${name} data does not match its shape`);
  for (const v of data) if (typeof v !== "number") invalidOutput(`tensor ${name} holds a value that is not a number`);
  return { shape: t["shape"] as number[], data: data as number[] };
}

/** The rule every decoder applies to a class id on every row it examines. */
function checkClass(spec: ModelSpec, id: number): void {
  if (!isInt(id) || id < 0 || id > 2147483647) invalidOutput("a class id must be an integer from 0 to 2147483647");
  if (spec.labels !== undefined) {
    const k = id - (spec.labelOffset ?? 0);
    if (k < 0 || k >= spec.labels.length) invalidOutput("a class id lies outside the labels");
  }
}

function checkCandidate(c: Candidate): Candidate {
  if (!isFiniteNumber(c.score) || !isFiniteNumber(c.box.x1) || !isFiniteNumber(c.box.y1) || !isFiniteNumber(c.box.x2) || !isFiniteNumber(c.box.y2)) {
    invalidOutput("a decoded value is not finite");
  }
  return c;
}

/** The `n` of a box tensor: `[1, n, 4]` or `[n, 4]`. */
function boxCount(shape: number[]): number {
  if (shape.length === 3 && shape[0] === 1 && shape[2] === 4) return shape[1]!;
  if (shape.length === 2 && shape[1] === 4) return shape[0]!;
  return invalidOutput("boxes must have shape [1, n, 4] or [n, 4]");
}

/** The `n` of a class or score tensor: `[1, n]` or `[n]`. */
function listCount(shape: number[], name: string): number {
  if (shape.length === 2 && shape[0] === 1) return shape[1]!;
  if (shape.length === 1) return shape[0]!;
  return invalidOutput(`${name} must have shape [1, n] or [n]`);
}

function decodeSsd(outputs: Record<string, unknown>, spec: ModelSpec, output: Extract<DetectorOutput, { format: "ssd" }>): Candidate[] {
  const boxes = readTensor(outputs, "boxes");
  const classes = readTensor(outputs, "classes");
  const scores = readTensor(outputs, "scores");
  const hasCount = Object.hasOwn(outputs, "count") && outputs["count"] !== undefined;
  const count = hasCount ? readTensor(outputs, "count") : null;
  const n = boxCount(boxes.shape);
  if (listCount(classes.shape, "classes") !== n || listCount(scores.shape, "scores") !== n) invalidOutput("boxes, classes and scores disagree on the number of rows");
  let examined = n;
  if (count !== null) {
    if (!(count.shape.length === 0 || (count.shape.length === 1 && count.shape[0] === 1))) invalidOutput("count must have shape [] or [1]");
    const c = count.data[0]!;
    if (!isFiniteNumber(c)) invalidOutput("count must be finite");
    examined = Math.min(Math.max(Math.floor(c), 0), n);
  }
  const yxyx = (output.boxOrder ?? "yxyx") === "yxyx";
  const normalized = (output.coordinates ?? "normalized") === "normalized";
  const inW = spec.input.width;
  const inH = spec.input.height;
  const out: Candidate[] = [];
  for (let i = 0; i < examined; i++) {
    const a = boxes.data[4 * i]!;
    const b = boxes.data[4 * i + 1]!;
    const c = boxes.data[4 * i + 2]!;
    const d = boxes.data[4 * i + 3]!;
    const score = scores.data[i]!;
    const classId = classes.data[i]!;
    if (![a, b, c, d, score, classId].every(isFiniteNumber)) invalidOutput("a row holds a non-finite value");
    checkClass(spec, classId);
    let x1 = yxyx ? b : a;
    let y1 = yxyx ? a : b;
    let x2 = yxyx ? d : c;
    let y2 = yxyx ? c : d;
    if (normalized) {
      x1 = x1 * inW;
      y1 = y1 * inH;
      x2 = x2 * inW;
      y2 = y2 * inH;
    }
    out.push(checkCandidate({ box: { x1, y1, x2, y2 }, classId, score, row: i }));
  }
  return out;
}

function decodeRows(outputs: Record<string, unknown>, spec: ModelSpec, output: Extract<DetectorOutput, { format: "rows" }>): Candidate[] {
  const t = readTensor(outputs, "rows");
  let a: number;
  let b: number;
  if (t.shape.length === 3 && t.shape[0] === 1) {
    a = t.shape[1]!;
    b = t.shape[2]!;
  } else if (t.shape.length === 2) {
    a = t.shape[0]!;
    b = t.shape[1]!;
  } else {
    return invalidOutput("rows must have shape [1, a, b] or [a, b]");
  }
  const transposed = output.transposed ?? false;
  const objectness = output.objectness ?? false;
  const sigmoid = (output.scoreActivation ?? "none") === "sigmoid";
  const xywh = (output.boxFormat ?? "xywh") === "xywh";
  const n = transposed ? b : a;
  const cols = transposed ? a : b;
  const first = objectness ? 5 : 4;
  const classes = cols - first;
  if (classes < 1) invalidOutput("rows has no class column");
  if (!t.data.every(isFiniteNumber)) invalidOutput("rows holds a non-finite value");

  const v = (i: number, j: number): number => (transposed ? t.data[j * b + i]! : t.data[i * b + j]!);
  const logistic = (z: number): number => {
    const q = Math.exp(0 - z);
    const p = 1 + q;
    return 1 / p;
  };
  const out: Candidate[] = [];
  for (let i = 0; i < n; i++) {
    let obj = objectness ? v(i, 4) : 0;
    if (objectness && sigmoid) obj = logistic(obj);
    let best = 0;
    let bestScore = 0;
    for (let k = 0; k < classes; k++) {
      let s = v(i, first + k);
      if (sigmoid) s = logistic(s);
      if (objectness) s = obj * s;
      if (k === 0 || s > bestScore) {
        best = k;
        bestScore = s;
      }
    }
    checkClass(spec, best);
    let x1: number;
    let y1: number;
    let x2: number;
    let y2: number;
    if (xywh) {
      const hw = v(i, 2) / 2;
      const hh = v(i, 3) / 2;
      x1 = v(i, 0) - hw;
      y1 = v(i, 1) - hh;
      x2 = v(i, 0) + hw;
      y2 = v(i, 1) + hh;
    } else {
      x1 = v(i, 0);
      y1 = v(i, 1);
      x2 = v(i, 2);
      y2 = v(i, 3);
    }
    out.push(checkCandidate({ box: { x1, y1, x2, y2 }, classId: best, score: bestScore, row: i }));
  }
  return out;
}

/**
 * Decodes the raw outputs of a detector into detections in SOURCE-image pixels: decode, threshold (inclusive),
 * coordinate swap, optional class-aware NMS, sort by score, cut to `maxDetections`, unmap, drop empty boxes.
 */
export function postprocessDetections(
  outputs: Record<string, Tensor>,
  spec: ModelSpec,
  geometry: Geometry,
  source: { width: number; height: number },
  options?: DetectOptions,
): Detection[] {
  const checked = parseModelSpec(spec);
  if (!isDetector(checked)) invalidOptions("a detector spec is required");
  const opts = resolveDetectOptions(options, checked.output);
  if (!isObject(source)) invalidOptions("source must be an object");
  const srcW = checkSide(source["width"], "source width");
  const srcH = checkSide(source["height"], "source height");
  if (!isObject(outputs)) invalidOutput("outputs must be an object of named tensors");

  const decoded = checked.output.format === "ssd" ? decodeSsd(outputs, checked, checked.output) : decodeRows(outputs, checked, checked.output);

  let list = decoded.filter((c) => c.score >= opts.scoreThreshold);
  list = list.map((c) => {
    let { x1, y1, x2, y2 } = c.box;
    if (x2 < x1) [x1, x2] = [x2, x1];
    if (y2 < y1) [y1, y2] = [y2, y1];
    return { ...c, box: { x1, y1, x2, y2 } };
  });
  if (opts.nms) {
    const keep = nmsKeep(
      list.map((c) => c.box),
      list.map((c) => c.classId),
      list.map((c) => c.score),
      opts.iouThreshold,
    );
    list = keep.map((i) => list[i]!);
  }
  list.sort((p, q) => {
    if (p.score > q.score) return -1;
    if (p.score < q.score) return 1;
    return p.row - q.row;
  });
  const result: Detection[] = [];
  for (const c of list.slice(0, opts.maxDetections)) {
    const box = unmapBox(c.box, geometry, srcW, srcH);
    if (box === null) continue;
    result.push({ box, classIndex: c.classId, label: labelOf(checked, c.classId), score: c.score });
  }
  return result;
}

import { invalidOptions, invalidOutput, isFiniteNumber, isInt, isObject, present } from "./errors.js";
import { checkUnit } from "./nms.js";
import { isClassifier, parseModelSpec, type ModelSpec } from "./spec.js";

export interface ClassEntry {
  /** The position in the model output (the model's own class id). */
  index: number;
  label: string;
  score: number;
}

export interface ClassifyOptions {
  /** Default 5. */
  topK?: number;
  /** Default 0. */
  minScore?: number;
}

/** Validates the classification options (`null` is a bad value, `undefined` is absent) and applies the defaults. */
export function resolveClassifyOptions(options: unknown): { topK: number; minScore: number } {
  if (options !== undefined && !isObject(options)) invalidOptions("options must be an object");
  const o = options ?? {};
  let topK = 5;
  let minScore = 0;
  if (present(o, "topK")) {
    const v = o["topK"];
    if (!isInt(v) || v < 1) invalidOptions("topK must be an integer of at least 1");
    topK = v;
  }
  if (present(o, "minScore")) minScore = checkUnit(o["minScore"], "minScore");
  return { topK, minScore };
}

/** The label of a class id: `labels[id - labelOffset]` when in range, else `#<id>`. */
export function labelOf(spec: ModelSpec, id: number): string {
  const labels = spec.labels;
  if (labels !== undefined) {
    const k = id - (spec.labelOffset ?? 0);
    if (k >= 0 && k < labels.length) return labels[k]!;
  }
  return `#${id}`;
}

/** Turns the output vector of a classifier into the best `topK` entries (softmax for logits). */
export function postprocessClassification(output: number[], spec: ModelSpec, options?: ClassifyOptions): ClassEntry[] {
  const checked = parseModelSpec(spec);
  if (!isClassifier(checked)) invalidOptions("a classifier spec is required");
  const { topK, minScore } = resolveClassifyOptions(options);

  if (!Array.isArray(output) || output.length === 0) invalidOutput("the output must be a non-empty list of numbers");
  const n = output.length;
  for (let i = 0; i < n; i++) {
    if (!isFiniteNumber(output[i])) invalidOutput("every output value must be a finite number");
    if (checked.output.type === "probabilities" && output[i]! < 0) invalidOutput("probabilities must not be negative");
  }

  const scores: number[] = new Array<number>(n);
  if (checked.output.type === "probabilities") {
    for (let i = 0; i < n; i++) scores[i] = output[i]!;
  } else {
    let m = output[0]!;
    for (let i = 1; i < n; i++) if (output[i]! > m) m = output[i]!;
    const e: number[] = new Array<number>(n);
    for (let i = 0; i < n; i++) e[i] = Math.exp(output[i]! - m);
    let s = 0;
    for (let i = 0; i < n; i++) s = s + e[i]!;
    for (let i = 0; i < n; i++) scores[i] = e[i]! / s;
  }

  const order: number[] = [];
  for (let i = 0; i < n; i++) order.push(i);
  order.sort((p, q) => {
    const sp = scores[p]!;
    const sq = scores[q]!;
    if (sp > sq) return -1;
    if (sp < sq) return 1;
    return p - q;
  });

  const entries: ClassEntry[] = [];
  for (const index of order.slice(0, topK)) {
    const score = scores[index]!;
    if (score < minScore) continue;
    entries.push({ index, label: labelOf(checked, index), score });
  }
  return entries;
}

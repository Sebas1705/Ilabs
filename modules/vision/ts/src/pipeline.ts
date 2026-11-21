import { postprocessClassification, resolveClassifyOptions, type ClassEntry, type ClassifyOptions } from "./classify.js";
import { postprocessDetections, resolveDetectOptions, type DetectOptions } from "./detect.js";
import { invalidOptions, invalidOutput, isInt, isObject } from "./errors.js";
import type { Geometry } from "./geometry.js";
import { checkImage, type Image } from "./image.js";
import type { Detection } from "./nms.js";
import { isClassifier, isDetector, parseModelSpec, type ModelSpec } from "./spec.js";
import { shapeSize, toTensor, type Tensor } from "./tensor.js";

/** The model: it receives the input tensor and returns the named output tensors. Its errors propagate unchanged. */
export interface VisionModel {
  run(input: Tensor): Promise<Record<string, Tensor>>;
}

export interface Clock {
  nowMs(): number;
}

export interface Timing {
  preprocessMs: number;
  inferenceMs: number;
  postprocessMs: number;
}

/** A model that ignores its input, records every call and answers with the same named tensors. */
export function scriptedModel(outputs: Record<string, Tensor>): VisionModel & { calls: Tensor[] } {
  const calls: Tensor[] = [];
  return {
    calls,
    async run(input: Tensor): Promise<Record<string, Tensor>> {
      calls.push(input);
      return outputs;
    },
  };
}

const realClock: Clock = {
  nowMs(): number {
    return typeof performance === "object" && typeof performance.now === "function" ? performance.now() : Date.now();
  },
};

function checkModel(model: unknown): VisionModel {
  if (!isObject(model) || typeof model["run"] !== "function") invalidOptions("model must have a run function");
  return model as unknown as VisionModel;
}

function checkClock(options: unknown): Clock {
  const clock = isObject(options) ? options["clock"] : undefined;
  if (clock === undefined) return realClock;
  if (!isObject(clock) || typeof clock["nowMs"] !== "function") invalidOptions("clock must have a nowMs function");
  return clock as unknown as Clock;
}

/** Runs the four-step sequence shared by both tasks; validation of everything has already happened. */
async function run<R>(model: VisionModel, clock: Clock, image: Image, spec: ModelSpec, post: (outputs: Record<string, Tensor>, geometry: Geometry) => R): Promise<{ result: R; timing: Timing; geometry: Geometry }> {
  const t0 = clock.nowMs();
  const { tensor, geometry } = toTensor(image, spec);
  const t1 = clock.nowMs();
  const outputs = await model.run(tensor);
  const t2 = clock.nowMs();
  const result = post(outputs, geometry);
  const t3 = clock.nowMs();
  return { result, timing: { preprocessMs: t1 - t0, inferenceMs: t2 - t1, postprocessMs: t3 - t2 }, geometry };
}

/** Preprocesses an image, runs the classifier once and reads its `output` tensor. */
export async function classify(model: VisionModel, image: Image, spec: ModelSpec, options?: ClassifyOptions & { clock?: Clock }): Promise<{ entries: ClassEntry[]; timing: Timing }> {
  const img = checkImage(image);
  const checked = parseModelSpec(spec);
  if (!isClassifier(checked)) invalidOptions("a classifier spec is required");
  const { topK, minScore } = resolveClassifyOptions(options === undefined ? undefined : stripClock(options));
  const clock = checkClock(options);
  const m = checkModel(model);
  const { result, timing } = await run(m, clock, img, checked, (outputs) => {
    const vector = classifierVector(outputs);
    return postprocessClassification(vector, checked, { topK, minScore });
  });
  return { entries: result, timing };
}

/** Preprocesses an image, runs the detector once and decodes its outputs into source-image boxes. */
export async function detect(
  model: VisionModel,
  image: Image,
  spec: ModelSpec,
  options?: DetectOptions & { clock?: Clock },
): Promise<{ detections: Detection[]; timing: Timing; geometry: Geometry }> {
  const img = checkImage(image);
  const checked = parseModelSpec(spec);
  if (!isDetector(checked)) invalidOptions("a detector spec is required");
  const resolved = resolveDetectOptions(options === undefined ? undefined : stripClock(options), checked.output);
  const clock = checkClock(options);
  const m = checkModel(model);
  const source = { width: img.width, height: img.height };
  const { result, timing, geometry } = await run(m, clock, img, checked, (outputs, g) => postprocessDetections(outputs, checked, g, source, resolved));
  return { detections: result, timing, geometry };
}

/** Everything but the clock, so the option validators see only their own keys. */
function stripClock(options: unknown): unknown {
  if (!isObject(options)) return options;
  const rest: Record<string, unknown> = {};
  for (const k of Object.keys(options)) if (k !== "clock") rest[k] = options[k];
  return rest;
}

/** The classifier output: the tensor `output`, shape `[C]` or `[1, C]`, `C >= 1`; returns its values. */
function classifierVector(outputs: unknown): number[] {
  if (!isObject(outputs) || !Object.hasOwn(outputs, "output")) invalidOutput("missing tensor output");
  const t = outputs["output"];
  if (!isObject(t)) invalidOutput("tensor output must be an object");
  const size = shapeSize(t["shape"]);
  const shape = t["shape"] as number[];
  const data = t["data"];
  if (size === null || !Array.isArray(data) || data.length !== size) invalidOutput("tensor output does not match its shape");
  const classes = shape.length === 1 ? shape[0]! : shape.length === 2 && shape[0] === 1 ? shape[1]! : -1;
  if (!isInt(classes) || classes < 1) invalidOutput("tensor output must have shape [C] or [1, C] with C >= 1");
  return [...(data as number[])];
}

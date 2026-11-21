import {
  VisionError,
  classify,
  detect,
  postprocessClassification,
  postprocessDetections,
  preprocessGeometry,
  type ClassEntry,
  type Detection,
  type Geometry,
  type Image,
  type ModelSpec,
  type Tensor,
  type VisionModel,
} from "@ilabs/vision";
import type { ModelCard, Recording, Task } from "./visionAssets";
import { modelAvailable, modelUrl, ortModel } from "./visionBackends/ort";
import { scriptedFor } from "./visionBackends/scripted";

export type Backend = "recorded" | "ort";

/**
 * What one model call left behind: the input tensor the library built, the raw output tensors under the decoder's
 * names, the geometry and the two timings that belong to the call. Changing a control decodes `outputs` again and
 * never calls the model again.
 */
export interface RawRun {
  task: Task;
  backend: Backend;
  spec: ModelSpec;
  input: Tensor;
  outputs: Record<string, Tensor>;
  geometry: Geometry;
  source: { width: number; height: number };
  preprocessMs: number;
  inferenceMs: number;
  /** How many times the model was called for this run (one). */
  calls: number;
}

export type SectionResult =
  | { kind: "ready"; raw: RawRun; fellBack: boolean }
  | { kind: "no-image" }
  | { kind: "no-card" }
  | { kind: "no-recording" }
  | { kind: "unavailable" };

/** Wraps a model so the run keeps what went in and what came out. */
function recorder(model: VisionModel) {
  const state: { calls: number; input: Tensor | null; outputs: Record<string, Tensor> | null } = { calls: 0, input: null, outputs: null };
  const wrapped: VisionModel = {
    async run(input) {
      state.calls++;
      state.input = input;
      const outputs = await model.run(input);
      state.outputs = outputs;
      return outputs;
    },
  };
  return { state, wrapped };
}

/** Runs the library pipeline once on `model` and keeps the raw material for later decodes. */
export async function runModel(task: Task, backend: Backend, model: VisionModel, image: Image, spec: ModelSpec): Promise<RawRun> {
  const { state, wrapped } = recorder(model);
  const timing = task === "classification" ? (await classify(wrapped, image, spec)).timing : (await detect(wrapped, image, spec)).timing;
  if (state.input === null || state.outputs === null) throw new Error("the model was not called");
  const source = { width: image.width, height: image.height };
  return {
    task,
    backend,
    spec,
    input: state.input,
    outputs: state.outputs,
    geometry: preprocessGeometry(image.width, image.height, spec),
    source,
    preprocessMs: timing.preprocessMs,
    inferenceMs: timing.inferenceMs,
    calls: state.calls,
  };
}

export interface RunArgs {
  task: Task;
  card: ModelCard | undefined;
  recording: Recording | undefined;
  /** The decoded image, or its pending decode: it is awaited only once the backend is known to be usable. */
  image: Image | Promise<Image>;
  /** The backend the person asked for (a picked image has no recording and always asks for the real model). */
  effective: Backend;
  isUser: boolean;
}

/** One section's run: chooses the backend, falls back to the recording when the model file is missing, calls the model once. */
export async function runSection(a: RunArgs): Promise<SectionResult> {
  const { card } = a;
  if (card === undefined) return { kind: "no-card" };
  let backend = a.effective;
  let fellBack = false;
  if (backend === "ort" && !(await modelAvailable(modelUrl(card)))) {
    if (a.isUser) return { kind: "unavailable" };
    backend = "recorded";
    fellBack = true;
  }
  if (backend === "recorded" && a.recording === undefined) return { kind: "no-recording" };
  const model = backend === "ort" ? await ortModel(card) : scriptedFor(card, a.recording!);
  return { kind: "ready", raw: await runModel(a.task, backend, model, await a.image, card.spec), fellBack };
}

/** A library error as the page keeps it: the kind and the library's own reason. */
export interface DecodeError {
  kind: string;
  detail: string;
}

export type Decoded<T> = { ok: true; value: T; ms: number } | { ok: false; error: DecodeError };

const now = (): number => (typeof performance === "object" && typeof performance.now === "function" ? performance.now() : Date.now());

function failure(e: unknown): { ok: false; error: DecodeError } {
  if (e instanceof VisionError) return { ok: false, error: { kind: e.kind, detail: e.message } };
  return { ok: false, error: { kind: "other", detail: e instanceof Error ? e.message : String(e) } };
}

/** A number typed in a field: blank is NaN, so the library (the only validator) rejects it instead of reading it as 0. */
export function fieldNumber(text: string): number {
  return text.trim() === "" ? Number.NaN : Number(text);
}

/** Decodes the raw classifier output again with the library; only this step is timed. */
export function decodeClassification(raw: RawRun, topK: number): Decoded<ClassEntry[]> {
  const t0 = now();
  try {
    const vector = raw.outputs["output"];
    const value = postprocessClassification(vector === undefined ? [] : vector.data, raw.spec, { topK });
    return { ok: true, value, ms: now() - t0 };
  } catch (e) {
    return failure(e);
  }
}

export interface DetectControls {
  scoreThreshold: number;
  iouThreshold: number;
  maxDetections: number;
  nms: boolean;
}

/** Decodes the raw detector output again with the library, boxes mapped back to the original image. */
export function decodeDetections(raw: RawRun, controls: DetectControls): Decoded<Detection[]> {
  const t0 = now();
  try {
    const value = postprocessDetections(raw.outputs, raw.spec, raw.geometry, raw.source, controls);
    return { ok: true, value, ms: now() - t0 };
  } catch (e) {
    return failure(e);
  }
}

/**
 * The model input drawn as bytes for display: the normalization is undone (`v * std + mean`, then `/ scale`) and the
 * channel order is put back to RGB. Display only; the tensor itself comes from the library.
 */
export function tensorToRgb(tensor: Tensor, spec: ModelSpec): Uint8Array {
  const { width, height, layout, channels, dtype } = spec.input;
  const scale = spec.input.scale ?? 1;
  const mean = spec.input.mean ?? [0, 0, 0];
  const std = spec.input.std ?? [1, 1, 1];
  const out = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) {
        const v = tensor.data[layout === "nhwc" ? (y * width + x) * 3 + c : (c * height + y) * width + x]!;
        const byte = dtype === "float" ? (v * std[c]! + mean[c]!) / scale : v;
        out[(y * width + x) * 3 + (channels === "bgr" ? 2 - c : c)] = Math.min(255, Math.max(0, Math.round(byte)));
      }
    }
  }
  return out;
}

/** `87%` style text; `digits` decimals. */
export function formatPercent(score: number, digits: number): string {
  return `${(score * 100).toFixed(digits)}%`;
}

/** The box in ORIGINAL pixel coordinates as `x1,y1,x2,y2`, rounded to integers for display. */
export function formatBox(d: Detection): string {
  const { x1, y1, x2, y2 } = d.box;
  return `${Math.round(x1)},${Math.round(y1)},${Math.round(x2)},${Math.round(y2)}`;
}

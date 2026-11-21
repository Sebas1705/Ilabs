import { MAX_SIDE } from "./image.js";
import { invalidSpec, isFiniteNumber, isInt, isObject, present } from "./errors.js";

export type Layout = "nhwc" | "nchw";
export type ChannelOrder = "rgb" | "bgr";
export type Mode = "stretch" | "centerCrop" | "letterbox";
export type Method = "nearest" | "bilinear";
export type Dtype = "float" | "uint8";

/** The model input: size, layout, channel order, how the image is fitted and how bytes become values. */
export interface InputSpec {
  width: number;
  height: number;
  layout: Layout;
  channels: ChannelOrder;
  mode: Mode;
  resample: Method;
  dtype: Dtype;
  /** Letterbox padding byte (default 114). */
  padValue?: number;
  /** Default 1. */
  scale?: number;
  /** Default `[0, 0, 0]`. */
  mean?: number[];
  /** Default `[1, 1, 1]`. */
  std?: number[];
}

export interface ClassifierOutput {
  type: "logits" | "probabilities";
}

export interface SsdOutput {
  format: "ssd";
  /** Default `"yxyx"`. */
  boxOrder?: "yxyx" | "xyxy";
  /** Default `"normalized"`. */
  coordinates?: "normalized" | "pixels";
}

export interface RowsOutput {
  format: "rows";
  /** Default `"xywh"`. */
  boxFormat?: "xywh" | "xyxy";
  /** Default `false`. */
  transposed?: boolean;
  /** Default `false`. */
  objectness?: boolean;
  /** Default `"none"`. */
  scoreActivation?: "none" | "sigmoid";
}

export type DetectorOutput = SsdOutput | RowsOutput;

/** The "model card": everything the pre- and post-processing need to know about a model. */
export interface ModelSpec {
  input: InputSpec;
  output: ClassifierOutput | DetectorOutput;
  labels?: string[];
  /** Default 0. */
  labelOffset?: number;
}

const INPUT_KEYS = ["width", "height", "layout", "channels", "mode", "resample", "dtype", "padValue", "scale", "mean", "std"];
const REQUIRED_INPUT_KEYS = ["width", "height", "layout", "channels", "mode", "resample", "dtype"];

function isOneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === "string" && allowed.includes(value);
}

/** The keys of an object that are set (an `undefined` value counts as absent). */
function setKeys(o: Record<string, unknown>): string[] {
  return Object.keys(o).filter((k) => o[k] !== undefined);
}

function hasZero(values: number[]): boolean {
  for (let i = 0; i < values.length; i++) if (values[i] === 0) return true;
  return false;
}

function allStrings(values: unknown[]): boolean {
  for (let i = 0; i < values.length; i++) if (typeof values[i] !== "string") return false;
  return true;
}

function checkTriple(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length !== 3) return false;
  for (let i = 0; i < 3; i++) if (!isFiniteNumber(value[i])) return false;
  return true;
}

/**
 * Validates a parsed JSON value (or a hand-built typed spec) and returns a new, typed spec.
 * Throws `VisionError(invalid_spec)` with the message `invalid model spec: <reason>`; the first violated rule of the contract is reported.
 */
export function parseModelSpec(json: unknown): ModelSpec {
  // 1-2: the document and its top-level keys.
  if (!isObject(json)) invalidSpec("spec must be an object");
  for (const k of setKeys(json)) {
    if (k !== "input" && k !== "output" && k !== "labels" && k !== "labelOffset") invalidSpec(`unknown key: ${k}`);
  }
  // 3-4: input and output are present, input is an object.
  if (!present(json, "input")) invalidSpec("missing key: input");
  if (!present(json, "output")) invalidSpec("missing key: output");
  const input = json["input"];
  if (!isObject(input)) invalidSpec("input must be an object");
  // 5-6: input keys.
  for (const k of setKeys(input)) if (!INPUT_KEYS.includes(k)) invalidSpec(`unknown key: input.${k}`);
  for (const k of REQUIRED_INPUT_KEYS) if (!present(input, k)) invalidSpec(`missing key: input.${k}`);
  // 7-12: required values.
  for (const k of ["width", "height"]) {
    const v = input[k];
    if (!isInt(v) || v < 1 || v > MAX_SIDE) invalidSpec(`input.${k} must be an integer from 1 to ${MAX_SIDE}`);
  }
  if (!isOneOf(input["layout"], ["nhwc", "nchw"])) invalidSpec('input.layout must be "nhwc" or "nchw"');
  if (!isOneOf(input["channels"], ["rgb", "bgr"])) invalidSpec('input.channels must be "rgb" or "bgr"');
  if (!isOneOf(input["mode"], ["stretch", "centerCrop", "letterbox"])) invalidSpec('input.mode must be "stretch", "centerCrop" or "letterbox"');
  if (!isOneOf(input["resample"], ["nearest", "bilinear"])) invalidSpec('input.resample must be "nearest" or "bilinear"');
  if (!isOneOf(input["dtype"], ["float", "uint8"])) invalidSpec('input.dtype must be "float" or "uint8"');
  // 13-18: optional values.
  if (present(input, "padValue")) {
    const v = input["padValue"];
    if (!isInt(v) || v < 0 || v > 255) invalidSpec("input.padValue must be an integer from 0 to 255");
  }
  if (present(input, "scale") && !isFiniteNumber(input["scale"])) invalidSpec("input.scale must be a finite number");
  if (present(input, "mean") && !checkTriple(input["mean"])) invalidSpec("input.mean must be an array of 3 finite numbers");
  if (present(input, "std") && !checkTriple(input["std"])) invalidSpec("input.std must be an array of 3 finite numbers");
  if (present(input, "std") && hasZero(input["std"] as number[])) invalidSpec("input.std entries must not be 0");
  if (input["dtype"] === "uint8") {
    for (const k of ["scale", "mean", "std"]) if (present(input, k)) invalidSpec(`input.${k} is not allowed with dtype uint8`);
  }
  // 19-20: the output kind.
  const output = json["output"];
  if (!isObject(output)) invalidSpec("output must be an object");
  const hasType = present(output, "type");
  const hasFormat = present(output, "format");
  if (hasType === hasFormat) invalidSpec('output must have exactly one of "type" and "format"');
  // 21-23: the output's own keys.
  let outputKeys: string[];
  if (hasType) {
    if (!isOneOf(output["type"], ["logits", "probabilities"])) invalidSpec('output.type must be "logits" or "probabilities"');
    outputKeys = ["type"];
  } else {
    if (!isOneOf(output["format"], ["ssd", "rows"])) invalidSpec('output.format must be "ssd" or "rows"');
    outputKeys = output["format"] === "ssd" ? ["format", "boxOrder", "coordinates"] : ["format", "boxFormat", "transposed", "objectness", "scoreActivation"];
  }
  for (const k of setKeys(output)) if (!outputKeys.includes(k)) invalidSpec(`unknown key: output.${k}`);
  // 24-28: detector values.
  if (present(output, "boxOrder") && !isOneOf(output["boxOrder"], ["yxyx", "xyxy"])) invalidSpec('output.boxOrder must be "yxyx" or "xyxy"');
  if (present(output, "coordinates") && !isOneOf(output["coordinates"], ["normalized", "pixels"])) invalidSpec('output.coordinates must be "normalized" or "pixels"');
  if (present(output, "boxFormat") && !isOneOf(output["boxFormat"], ["xywh", "xyxy"])) invalidSpec('output.boxFormat must be "xywh" or "xyxy"');
  for (const k of ["transposed", "objectness"]) {
    if (present(output, k) && typeof output[k] !== "boolean") invalidSpec(`output.${k} must be a boolean`);
  }
  if (present(output, "scoreActivation") && !isOneOf(output["scoreActivation"], ["none", "sigmoid"])) invalidSpec('output.scoreActivation must be "none" or "sigmoid"');
  // 29-30: labels.
  if (present(json, "labels")) {
    const labels = json["labels"];
    if (!Array.isArray(labels) || !allStrings(labels)) invalidSpec("labels must be an array of strings");
  }
  if (present(json, "labelOffset")) {
    const v = json["labelOffset"];
    if (!isInt(v) || v < -1000000 || v > 1000000) invalidSpec("labelOffset must be an integer from -1000000 to 1000000");
  }

  // Copy the validated keys into new values (arrays included), so nothing aliases the caller's document.
  const copy = {} as Record<string, unknown>;
  for (const k of setKeys(input)) copy[k] = Array.isArray(input[k]) ? [...(input[k] as unknown[])] : input[k];
  const out = {} as Record<string, unknown>;
  for (const k of setKeys(output)) out[k] = output[k];
  const spec: Record<string, unknown> = { input: copy, output: out };
  if (present(json, "labels")) spec["labels"] = [...(json["labels"] as string[])];
  if (present(json, "labelOffset")) spec["labelOffset"] = json["labelOffset"];
  return spec as unknown as ModelSpec;
}

/** True when the spec describes a classifier (`output.type`). */
export function isClassifier(spec: ModelSpec): spec is ModelSpec & { output: ClassifierOutput } {
  return "type" in spec.output;
}

/** True when the spec describes a detector (`output.format`). */
export function isDetector(spec: ModelSpec): spec is ModelSpec & { output: DetectorOutput } {
  return "format" in spec.output;
}

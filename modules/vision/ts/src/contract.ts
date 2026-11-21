import { postprocessClassification, type ClassEntry } from "./classify.js";
import { postprocessDetections } from "./detect.js";
import { VisionError } from "./errors.js";
import { preprocessGeometry, unmapBox, type Geometry } from "./geometry.js";
import type { Image } from "./image.js";
import { averagePrecision, meanAveragePrecision, topKAccuracy, type ClassAp } from "./metrics.js";
import { iou, nms, type Box, type Detection } from "./nms.js";
import { classify, detect, scriptedModel, type Clock, type Timing, type VisionModel } from "./pipeline.js";
import { resize } from "./resize.js";
import { parseModelSpec, type ModelSpec } from "./spec.js";
import { toTensor, type Tensor } from "./tensor.js";

/** A parsed `contracts/vision/*.json` file (checked by `runFixture` itself, so it may be malformed). */
export interface Fixture {
  name: string;
  setup: { kind: string } & Record<string, unknown>;
  expect: Record<string, unknown>;
}

/** A `VisionError` reported by the library. */
export interface FixtureError {
  kind: string;
  message: string;
}

/** The actual result of a fixture, per kind. */
export type FixtureOutput =
  | { kind: "resize"; image: Image }
  | { kind: "geometry"; geometry: Geometry; unmapped: Array<Box | null> | null }
  | { kind: "tensor"; tensor: Tensor }
  | { kind: "classify"; entries: ClassEntry[] }
  | { kind: "decode"; detections: Detection[] }
  | { kind: "nms"; detections: Detection[] }
  | { kind: "metrics"; op: string; value?: number; map?: number; byClass?: ClassAp[] }
  | { kind: "pipeline"; task: string; results: ClassEntry[] | Detection[]; timing: Timing; geometry: Geometry | null }
  | { kind: "spec"; spec: ModelSpec };

/** What a pipeline fixture observed: model calls, clock reads (in total and at each model call) and the recorded input. */
export interface PipelineRun {
  modelCalls: number;
  clockReads: number;
  /** The number of clock reads at the moment of each `run` call (the contract requires 2). */
  clockReadsAtRun: number[];
  /** The input tensor of the first (only) model call, or `null` when the model was never called. */
  input: Tensor | null;
  /** The error object the scripted model threw (`{ "error": message }`), or `null`. */
  scriptedError: Error | null;
  /** A non-`VisionError` that escaped `classify` or `detect` (it must be `scriptedError`), or `null`. */
  thrown: unknown;
}

export interface FixtureRun {
  kind: string;
  /** `null` when the library reported an error. */
  output: FixtureOutput | null;
  /** `null` when the run succeeded (or the scripted model threw: see `pipeline.thrown`). */
  error: FixtureError | null;
  /** Present exactly for pipeline fixtures. */
  pipeline: PipelineRun | null;
}

/** A clock that returns the given numbers in order and fails the fixture on a fifth read. */
export function scriptedClock(times: number[]): Clock & { reads: number; overflow: Error | null } {
  const clock = {
    reads: 0,
    overflow: null as Error | null,
    nowMs(): number {
      if (clock.reads >= times.length) {
        clock.overflow = new Error("invalid fixture: clock called more than four times");
        throw clock.overflow;
      }
      const t = times[clock.reads]!;
      clock.reads = clock.reads + 1;
      return t;
    },
  };
  return clock;
}

// ---------------------------------------------------------------------------------------------
// Raw JSON validation: a small schema language. Every failure is `invalid fixture: <reason>`.
// ---------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;

type Schema =
  | { t: "str" | "strNull" | "int" | "num" | "numNull" | "numNF" | "bool" | "any" | "imageData" | "boxOrNull" }
  | { t: "arr"; of: Schema; len?: number }
  | { t: "map"; of: Schema }
  | { t: "obj"; req: Array<[string, Schema]>; opt?: Array<[string, Schema]> };

const NON_FINITE = ["NaN", "Infinity", "-Infinity"];

function invalid(reason: string): never {
  throw new Error(`invalid fixture: ${reason}`);
}

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const wrong = (key: string): never => invalid(`wrong type: ${key}`);

/** Unknown keys first (in the document's key order), then missing required keys (in schema order). */
function checkKeys(o: Obj, req: string[], opt: string[]): void {
  for (const k of Object.keys(o)) if (!req.includes(k) && !opt.includes(k)) invalid(`unknown key: ${k}`);
  for (const k of req) if (!Object.hasOwn(o, k)) invalid(`missing key: ${k}`);
}

function check(s: Schema, v: unknown, key: string): void {
  switch (s.t) {
    case "str":
      if (typeof v !== "string") wrong(key);
      return;
    case "strNull":
      if (typeof v !== "string" && v !== null) wrong(key);
      return;
    case "int":
      if (typeof v !== "number" || !Number.isInteger(v)) wrong(key);
      return;
    case "num":
      if (typeof v !== "number") wrong(key);
      return;
    case "numNull":
      if (typeof v !== "number" && v !== null) wrong(key);
      return;
    case "numNF":
      if (typeof v !== "number" && !(typeof v === "string" && NON_FINITE.includes(v))) wrong(key);
      return;
    case "bool":
      if (typeof v !== "boolean") wrong(key);
      return;
    case "any":
      return;
    case "boxOrNull":
      if (v !== null) check(BOX, v, key);
      return;
    case "imageData":
      if (Array.isArray(v)) {
        for (const b of v) if (typeof b !== "number" || !Number.isInteger(b) || b < 0 || b > 255) wrong(key);
      } else if (isObj(v)) {
        checkKeys(v, ["fill", "length"], []);
        const fill = v["fill"];
        if (typeof fill !== "number" || !Number.isInteger(fill) || fill < 0 || fill > 255) wrong("fill");
        const length = v["length"];
        if (typeof length !== "number" || !Number.isInteger(length) || length < 0 || length > 1073741824) wrong("length");
      } else {
        wrong(key);
      }
      return;
    case "arr":
      if (!Array.isArray(v)) wrong(key);
      if (s.len !== undefined && (v as unknown[]).length !== s.len) wrong(key);
      for (const e of v as unknown[]) check(s.of, e, key);
      return;
    case "map":
      if (!isObj(v)) wrong(key);
      for (const [k, e] of Object.entries(v as Obj)) check(s.of, e, k);
      return;
    case "obj": {
      if (!isObj(v)) wrong(key);
      const o = v as Obj;
      checkKeys(
        o,
        s.req.map(([k]) => k),
        (s.opt ?? []).map(([k]) => k),
      );
      for (const [k, sub] of s.req) check(sub, o[k], k);
      for (const [k, sub] of s.opt ?? []) if (Object.hasOwn(o, k)) check(sub, o[k], k);
      return;
    }
  }
}

const S = (t: "str" | "strNull" | "int" | "num" | "numNull" | "numNF" | "bool" | "any" | "imageData" | "boxOrNull"): Schema => ({ t });
const obj = (req: Array<[string, Schema]>, opt: Array<[string, Schema]> = []): Schema => ({ t: "obj", req, opt });
const arr = (of: Schema, len?: number): Schema => ({ t: "arr", of, ...(len !== undefined ? { len } : {}) });

const BOX: Schema = obj([
  ["x1", S("numNF")],
  ["y1", S("numNF")],
  ["x2", S("numNF")],
  ["y2", S("numNF")],
]);
const TENSOR: Schema = obj([
  ["shape", arr(S("num"))],
  ["data", arr(S("numNF"))],
]);
const IMAGE: Schema = obj([
  ["width", S("numNull")],
  ["height", S("numNull")],
  ["data", S("imageData")],
]);
const DETECTION: Schema = obj([
  ["box", BOX],
  ["classIndex", S("int")],
  ["label", S("str")],
  ["score", S("numNF")],
]);
const ENTRY: Schema = obj([
  ["index", S("int")],
  ["label", S("str")],
  ["score", S("num")],
]);
const METRIC_DETECTION: Schema = obj([
  ["image", S("str")],
  ["classIndex", S("num")],
  ["score", S("numNF")],
  ["box", BOX],
]);
const METRIC_TRUTH: Schema = obj([
  ["image", S("str")],
  ["classIndex", S("num")],
  ["box", BOX],
]);
const BY_CLASS: Schema = obj([
  ["classIndex", S("int")],
  ["ap", S("num")],
]);
const GEOMETRY: Schema = obj([
  ["scaleX", S("num")],
  ["scaleY", S("num")],
  ["offsetX", S("num")],
  ["offsetY", S("num")],
  ["newWidth", S("num")],
  ["newHeight", S("num")],
]);
const TIMING: Schema = obj([
  ["preprocessMs", S("num")],
  ["inferenceMs", S("num")],
  ["postprocessMs", S("num")],
]);
/** Checks an options object of a pipeline or decode fixture: numbers or null, `nms` a boolean or null. */
function checkOptions(v: unknown, allowed: string[], booleans: string[]): void {
  if (!isObj(v)) wrong("options");
  const o = v as Obj;
  checkKeys(o, [], allowed);
  for (const k of allowed) {
    if (!Object.hasOwn(o, k)) continue;
    const value = o[k];
    if (booleans.includes(k)) {
      if (typeof value !== "boolean" && value !== null) wrong(k);
    } else if (typeof value !== "number" && value !== null) {
      wrong(k);
    }
  }
}

const CLASSIFY_OPTION_KEYS = ["topK", "minScore"];
const DETECT_OPTION_KEYS = ["scoreThreshold", "iouThreshold", "maxDetections", "nms"];

/** The required and optional setup keys of a kind (after the `kind` key itself). */
function setupSchema(kind: string, setup: Obj): { req: Array<[string, Schema]>; opt: Array<[string, Schema]> } {
  switch (kind) {
    case "resize":
      return { req: [["image", IMAGE], ["width", S("numNull")], ["height", S("numNull")], ["method", S("strNull")]], opt: [] };
    case "geometry":
      return { req: [["srcWidth", S("numNull")], ["srcHeight", S("numNull")], ["spec", S("any")]], opt: [["boxes", arr(BOX)]] };
    case "tensor":
      return { req: [["image", IMAGE], ["spec", S("any")]], opt: [] };
    case "classify":
      return { req: [["output", arr(S("numNF"))], ["spec", S("any")]], opt: [["options", S("any")]] };
    case "decode":
      return { req: [["outputs", { t: "map", of: TENSOR }], ["spec", S("any")], ["srcWidth", S("numNull")], ["srcHeight", S("numNull")]], opt: [["options", S("any")]] };
    case "nms":
      return { req: [["detections", arr(DETECTION)], ["iouThreshold", S("numNull")]], opt: [] };
    case "metrics":
      return metricsSchema(setup);
    case "pipeline":
      return { req: [["image", IMAGE], ["spec", S("any")], ["task", S("str")], ["scripted", S("any")], ["clock", arr(S("num"), 4)]], opt: [["options", S("any")]] };
    default:
      return { req: [["spec", S("any")]], opt: [] };
  }
}

const METRIC_OPS = ["iou", "topk", "ap", "map"];

function metricsSchema(setup: Obj): { req: Array<[string, Schema]>; opt: Array<[string, Schema]> } {
  const op = setup["op"];
  if (op === "iou") return { req: [["op", S("str")], ["a", BOX], ["b", BOX]], opt: [] };
  if (op === "topk") return { req: [["op", S("str")], ["predictions", arr(arr(S("num")))], ["truths", arr(S("num"))], ["k", S("numNull")]], opt: [] };
  return { req: [["op", S("str")], ["detections", arr(METRIC_DETECTION)], ["truths", arr(METRIC_TRUTH)], ["iouThreshold", S("numNull")]], opt: [] };
}

const KINDS = ["resize", "geometry", "tensor", "classify", "decode", "nms", "metrics", "pipeline", "spec"];

/** Validates the `scripted` object of a pipeline fixture. */
function checkScripted(v: unknown): void {
  if (!isObj(v)) wrong("scripted");
  const o = v as Obj;
  for (const k of Object.keys(o)) {
    if (k !== "outputs" && k !== "error") invalid(`unknown key: ${k}`);
  }
  if (Object.hasOwn(o, "error")) {
    if (Object.hasOwn(o, "outputs")) invalid("unknown key: outputs");
    check(S("str"), o["error"], "error");
    return;
  }
  if (!Object.hasOwn(o, "outputs")) invalid("missing key: outputs");
  check({ t: "map", of: TENSOR }, o["outputs"], "outputs");
}

/** Validates a whole fixture; returns nothing, throws `invalid fixture: <reason>`. */
function checkFixture(fixture: unknown): void {
  if (!isObj(fixture)) wrong("fixture");
  const fx = fixture as Obj;
  checkKeys(fx, ["name", "setup", "expect"], []);
  check(S("str"), fx["name"], "name");
  if (!isObj(fx["setup"])) wrong("setup");
  const setup = fx["setup"] as Obj;
  if (!Object.hasOwn(setup, "kind")) invalid("missing key: kind");
  if (typeof setup["kind"] !== "string") wrong("kind");
  const kind = setup["kind"] as string;
  if (!KINDS.includes(kind)) invalid(`unknown setup kind: ${kind}`);
  if (kind === "metrics") {
    if (!Object.hasOwn(setup, "op")) invalid("missing key: op");
    if (typeof setup["op"] !== "string") wrong("op");
    if (!METRIC_OPS.includes(setup["op"] as string)) invalid(`unknown metrics op: ${setup["op"] as string}`);
  }
  if (kind === "pipeline") {
    if (!Object.hasOwn(setup, "task")) invalid("missing key: task");
    if (setup["task"] !== "classify" && setup["task"] !== "detect") wrong("task");
  }
  const { req, opt } = setupSchema(kind, setup);
  checkKeys(
    setup,
    ["kind", ...req.map(([k]) => k)],
    opt.map(([k]) => k),
  );
  for (const [k, s] of req) {
    if (k === "scripted") checkScripted(setup[k]);
    else check(s, setup[k], k);
  }
  for (const [k, s] of opt) {
    if (!Object.hasOwn(setup, k)) continue;
    if (k === "options") checkOptions(setup[k], kind === "pipeline" && setup["task"] === "classify" ? CLASSIFY_OPTION_KEYS : kind === "classify" ? CLASSIFY_OPTION_KEYS : DETECT_OPTION_KEYS, ["nms"]);
    else check(s, setup[k], k);
  }
  checkExpect(kind, setup, fx["expect"]);
}

/** The keys of a success expectation (and their schemas, in the order they are required). */
function successSchema(kind: string, setup: Obj): Array<[string, Schema]> {
  switch (kind) {
    case "resize":
      return [["image", IMAGE]];
    case "geometry":
      return [["geometry", GEOMETRY], ...(Object.hasOwn(setup, "boxes") ? ([["unmapped", arr(S("boxOrNull"))]] as Array<[string, Schema]>) : [])];
    case "tensor":
      return [["shape", arr(S("num"))], ["data", arr(S("numNF"))]];
    case "classify":
      return [["entries", arr(ENTRY)]];
    case "decode":
    case "nms":
      return [["detections", arr(DETECTION)]];
    case "metrics":
      if (setup["op"] === "iou" || setup["op"] === "topk") return [["value", S("num")]];
      if (setup["op"] === "ap") return [["byClass", arr(BY_CLASS)]];
      return [["map", S("num")], ["byClass", arr(BY_CLASS)]];
    case "pipeline":
      return [
        ["results", arr(setup["task"] === "classify" ? ENTRY : DETECTION)],
        ["timing", TIMING],
        ["modelCalls", S("int")],
        ["clockReads", S("int")],
        ["input", TENSOR],
        ...(setup["task"] === "detect" ? ([["geometry", GEOMETRY]] as Array<[string, Schema]>) : []),
      ];
    default:
      return [["valid", S("bool")]];
  }
}

function checkExpect(kind: string, setup: Obj, expect: unknown): void {
  if (!isObj(expect)) wrong("expect");
  const e = expect as Obj;
  const success = successSchema(kind, setup);
  const successKeys = success.map(([k]) => k).filter((k) => !(kind === "pipeline" && (k === "modelCalls" || k === "clockReads")));
  const pipelineKeys = kind === "pipeline" ? ["modelCalls", "clockReads", "modelError"] : [];
  const allowed = [...successKeys, "error", ...pipelineKeys];
  for (const k of Object.keys(e)) if (!allowed.includes(k)) invalid(`unknown key: ${k}`);

  const only = (keys: string[]): void => {
    for (const k of Object.keys(e)) if (!keys.includes(k)) invalid(`unknown key: ${k}`);
  };
  if (kind === "pipeline" && Object.hasOwn(e, "modelError")) {
    only(["modelError", "modelCalls", "clockReads"]);
    for (const k of ["modelCalls", "clockReads"]) if (!Object.hasOwn(e, k)) invalid(`missing key: ${k}`);
    check(S("str"), e["modelError"], "modelError");
    check(S("int"), e["modelCalls"], "modelCalls");
    check(S("int"), e["clockReads"], "clockReads");
    return;
  }
  if (Object.hasOwn(e, "error")) {
    only(kind === "pipeline" ? ["error", "modelCalls", "clockReads"] : ["error"]);
    if (kind === "pipeline") for (const k of ["modelCalls", "clockReads"]) if (!Object.hasOwn(e, k)) invalid(`missing key: ${k}`);
    check(kind === "spec" ? obj([["kind", S("str")], ["message", S("str")]]) : obj([["kind", S("str")]], [["message", S("str")]]), e["error"], "error");
    if (kind === "pipeline") {
      check(S("int"), e["modelCalls"], "modelCalls");
      check(S("int"), e["clockReads"], "clockReads");
    }
    return;
  }
  if (!successKeys.some((k) => Object.hasOwn(e, k))) invalid("expect has neither the keys of its kind nor error");
  for (const [k] of success) if (!Object.hasOwn(e, k)) invalid(`missing key: ${k}`);
  for (const [k, s] of success) check(s, e[k], k);
}

// ---------------------------------------------------------------------------------------------
// Conversion of validated raw JSON into library arguments
// ---------------------------------------------------------------------------------------------

/** A JSON number, or one of the three non-finite strings, as a double (`null` stays `null`: a bad value for the library). */
function num(v: unknown): number {
  if (v === "NaN") return NaN;
  if (v === "Infinity") return Infinity;
  if (v === "-Infinity") return -Infinity;
  return v as number;
}

function image(v: unknown): Image {
  const o = v as Obj;
  const d = o["data"];
  const data = Array.isArray(d) ? Uint8Array.from(d as number[]) : new Uint8Array((d as Obj)["length"] as number).fill((d as Obj)["fill"] as number);
  return { width: o["width"] as number, height: o["height"] as number, data };
}

function box(v: unknown): Box {
  const o = v as Obj;
  return { x1: num(o["x1"]), y1: num(o["y1"]), x2: num(o["x2"]), y2: num(o["y2"]) };
}

function tensor(v: unknown): Tensor {
  const o = v as Obj;
  return { shape: [...(o["shape"] as number[])], data: (o["data"] as unknown[]).map(num) };
}

function tensors(v: unknown): Record<string, Tensor> {
  return Object.fromEntries(Object.entries(v as Obj).map(([k, t]) => [k, tensor(t)]));
}

function detection(v: unknown): Detection {
  const o = v as Obj;
  return { box: box(o["box"]), classIndex: o["classIndex"] as number, label: o["label"] as string, score: num(o["score"]) };
}

/** Option objects keep their keys, `null` included: the library sees `null` as a bad value. */
function options(setup: Obj): Obj | undefined {
  if (!Object.hasOwn(setup, "options")) return undefined;
  return { ...(setup["options"] as Obj) };
}

function metricDetections(v: unknown): Array<{ image: string; classIndex: number; score: number; box: Box }> {
  return (v as Obj[]).map((d) => ({ image: d["image"] as string, classIndex: d["classIndex"] as number, score: num(d["score"]), box: box(d["box"]) }));
}

function metricTruths(v: unknown): Array<{ image: string; classIndex: number; box: Box }> {
  return (v as Obj[]).map((t) => ({ image: t["image"] as string, classIndex: t["classIndex"] as number, box: box(t["box"]) }));
}

// ---------------------------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------------------------

async function runPipeline(setup: Obj): Promise<{ output: FixtureOutput | null; error: FixtureError | null; pipeline: PipelineRun }> {
  const times = (setup["clock"] as number[]).slice();
  const clock = scriptedClock(times);
  const scripted = setup["scripted"] as Obj;
  let scriptedError: Error | null = null;
  let inner: VisionModel;
  if (Object.hasOwn(scripted, "error")) {
    const failure = new Error(scripted["error"] as string);
    scriptedError = failure;
    inner = {
      async run(): Promise<Record<string, Tensor>> {
        throw failure;
      },
    };
  } else {
    inner = scriptedModel(tensors(scripted["outputs"]));
  }
  const run: PipelineRun = { modelCalls: 0, clockReads: 0, clockReadsAtRun: [], input: null, scriptedError, thrown: null };
  const recording: VisionModel = {
    async run(input: Tensor): Promise<Record<string, Tensor>> {
      run.modelCalls = run.modelCalls + 1;
      run.clockReadsAtRun.push(clock.reads);
      run.input ??= input;
      return inner.run(input);
    },
  };
  const spec = setup["spec"] as ModelSpec;
  const img = image(setup["image"]);
  const opts = { ...(options(setup) ?? {}), clock };
  let output: FixtureOutput | null = null;
  let error: FixtureError | null = null;
  try {
    if (setup["task"] === "classify") {
      const r = await classify(recording, img, spec, opts);
      output = { kind: "pipeline", task: "classify", results: r.entries, timing: r.timing, geometry: null };
    } else {
      const r = await detect(recording, img, spec, opts);
      output = { kind: "pipeline", task: "detect", results: r.detections, timing: r.timing, geometry: r.geometry };
    }
  } catch (e) {
    if (clock.overflow !== null && e === clock.overflow) throw e;
    if (e instanceof VisionError) error = { kind: e.kind, message: e.message };
    else run.thrown = e;
  }
  run.clockReads = clock.reads;
  return { output, error, pipeline: run };
}

function runLibrary(kind: string, setup: Obj): FixtureOutput {
  switch (kind) {
    case "resize":
      return { kind, image: resize(image(setup["image"]), setup["width"] as number, setup["height"] as number, setup["method"] as "nearest") };
    case "geometry": {
      const srcW = setup["srcWidth"] as number;
      const srcH = setup["srcHeight"] as number;
      const geometry = preprocessGeometry(srcW, srcH, setup["spec"] as ModelSpec);
      const boxes = setup["boxes"] as unknown[] | undefined;
      return { kind, geometry, unmapped: boxes === undefined ? null : boxes.map((b) => unmapBox(box(b), geometry, srcW, srcH)) };
    }
    case "tensor":
      return { kind, tensor: toTensor(image(setup["image"]), setup["spec"] as ModelSpec).tensor };
    case "classify":
      return { kind, entries: postprocessClassification((setup["output"] as unknown[]).map(num), setup["spec"] as ModelSpec, options(setup)) };
    case "decode": {
      const spec = setup["spec"] as ModelSpec;
      const srcW = setup["srcWidth"] as number;
      const srcH = setup["srcHeight"] as number;
      const geometry = preprocessGeometry(srcW, srcH, spec);
      return { kind, detections: postprocessDetections(tensors(setup["outputs"]), spec, geometry, { width: srcW, height: srcH }, options(setup)) };
    }
    case "nms":
      return { kind, detections: nms((setup["detections"] as unknown[]).map(detection), setup["iouThreshold"] as number) };
    case "metrics": {
      const op = setup["op"] as string;
      if (op === "iou") return { kind, op, value: iou(box(setup["a"]), box(setup["b"])) };
      if (op === "topk") return { kind, op, value: topKAccuracy(setup["predictions"] as number[][], setup["truths"] as number[], setup["k"] as number) };
      const detections = metricDetections(setup["detections"]);
      const truths = metricTruths(setup["truths"]);
      const opts = { iouThreshold: setup["iouThreshold"] as number };
      if (op === "ap") return { kind, op, byClass: averagePrecision(detections, truths, opts).byClass };
      const r = meanAveragePrecision(detections, truths, opts);
      return { kind, op, map: r.map, byClass: r.byClass };
    }
    default:
      return { kind: "spec", spec: parseModelSpec(setup["spec"]) };
  }
}

/** Runs one fixture against the library. Malformed fixtures fail with `invalid fixture: <reason>` before anything runs. */
export async function runFixture(fixture: Fixture): Promise<FixtureRun> {
  checkFixture(fixture);
  const setup = fixture.setup as Obj;
  const kind = fixture.setup.kind;
  if (kind === "pipeline") {
    const r = await runPipeline(setup);
    return { kind, output: r.output, error: r.error, pipeline: r.pipeline };
  }
  try {
    return { kind, output: runLibrary(kind, setup), error: null, pipeline: null };
  } catch (e) {
    if (e instanceof VisionError) return { kind, output: null, error: { kind: e.kind, message: e.message }, pipeline: null };
    throw e;
  }
}

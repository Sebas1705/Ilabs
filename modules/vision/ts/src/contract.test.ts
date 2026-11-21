import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { runFixture, scriptedClock, type Fixture, type FixtureRun } from "./contract.js";
import { VisionError } from "./errors.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../../contracts/vision");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort();
const raw = new Map(files.map((f) => [f, readFileSync(join(dir, f), "utf8")]));
const fixtures: Fixture[] = files.map((f) => JSON.parse(raw.get(f)!) as Fixture);

const TOLERANCE = 1e-9;
type Json = Record<string, any>;

// ---------------------------------------------------------------------------------------------
// Comparison rules of the contract (README "Comparison and harness")
// ---------------------------------------------------------------------------------------------

/** Exact comparison of an integer, a byte or an index (`-0` equals `0`). */
function same(actual: unknown, expected: unknown, at: string): void {
  expect(typeof actual, `${at}: a number`).toBe("number");
  expect(actual === expected, `${at}: ${String(actual)} vs ${String(expected)}`).toBe(true);
}

/** A double within the absolute tolerance (NaN never passes). */
function near(actual: unknown, expected: unknown, at: string): void {
  expect(typeof actual, `${at}: a number`).toBe("number");
  expect(typeof expected, `${at}: expected a number`).toBe("number");
  const diff = Math.abs((actual as number) - (expected as number));
  expect(actual === expected || (Number.isNaN(actual) && Number.isNaN(expected)) || diff <= TOLERANCE, `${at}: ${String(actual)} vs ${String(expected)}`).toBe(true);
}

function compareImage(actual: any, expected: Json, at: string): void {
  same(actual.width, expected["width"], `${at} width`);
  same(actual.height, expected["height"], `${at} height`);
  expect(actual.data, `${at} data`).toBeInstanceOf(Uint8Array);
  expect(actual.data.length, `${at} data length`).toBe(expected["data"].length);
  for (let i = 0; i < actual.data.length; i++) same(actual.data[i], expected["data"][i], `${at} byte ${i}`);
}

function compareGeometry(actual: any, expected: Json, at: string): void {
  expect(Object.keys(expected).sort(), `${at}: keys`).toEqual(["newHeight", "newWidth", "offsetX", "offsetY", "scaleX", "scaleY"]);
  same(actual.newWidth, expected["newWidth"], `${at} newWidth`);
  same(actual.newHeight, expected["newHeight"], `${at} newHeight`);
  for (const k of ["scaleX", "scaleY", "offsetX", "offsetY"]) near(actual[k], expected[k], `${at} ${k}`);
}

function compareBox(actual: any, expected: Json, at: string): void {
  for (const k of ["x1", "y1", "x2", "y2"]) near(actual[k], expected[k], `${at} ${k}`);
}

function compareTensor(actual: any, expected: Json, at: string): void {
  expect(actual.shape, `${at} shape`).toEqual(expected["shape"]);
  expect(Array.isArray(actual.data), `${at}: data is a list`).toBe(true);
  expect(actual.data.length, `${at} data length`).toBe(expected["data"].length);
  for (let i = 0; i < actual.data.length; i++) near(actual.data[i], expected["data"][i], `${at} value ${i}`);
}

function compareEntries(actual: any[], expected: Json[], at: string): void {
  expect(actual.length, `${at}: number of entries`).toBe(expected.length);
  expected.forEach((e, i) => {
    same(actual[i].index, e["index"], `${at} entry ${i} index`);
    expect(actual[i].label, `${at} entry ${i} label`).toBe(e["label"]);
    near(actual[i].score, e["score"], `${at} entry ${i} score`);
  });
}

function compareDetections(actual: any[], expected: Json[], at: string): void {
  expect(actual.length, `${at}: number of detections`).toBe(expected.length);
  expected.forEach((e, i) => {
    same(actual[i].classIndex, e["classIndex"], `${at} detection ${i} classIndex`);
    expect(actual[i].label, `${at} detection ${i} label`).toBe(e["label"]);
    near(actual[i].score, e["score"], `${at} detection ${i} score`);
    compareBox(actual[i].box, e["box"], `${at} detection ${i} box`);
  });
}

function compareByClass(actual: any[], expected: Json[], at: string): void {
  expect(actual.length, `${at}: number of classes`).toBe(expected.length);
  expected.forEach((e, i) => {
    same(actual[i].classIndex, e["classIndex"], `${at} class ${i}`);
    near(actual[i].ap, e["ap"], `${at} class ${i} ap`);
  });
}

function compareTiming(actual: any, expected: Json, at: string): void {
  expect(Object.keys(expected).sort(), `${at}: keys`).toEqual(["inferenceMs", "postprocessMs", "preprocessMs"]);
  for (const k of ["preprocessMs", "inferenceMs", "postprocessMs"]) near(actual[k], expected[k], `${at} ${k}`);
}

/** Compares a run with the fixture's expectation by the contract's comparison rules; throws on any mismatch. */
export function checkRun(fx: Fixture, run: FixtureRun): void {
  const exp = fx.expect as Json;
  const kind = fx.setup.kind;
  const name = fx.name;
  expect(run.kind, name).toBe(kind);
  const p = run.pipeline;

  if (kind === "pipeline") {
    expect(p, `${name}: a pipeline run reports calls and clock reads`).not.toBeNull();
    expect(Number.isInteger(exp["modelCalls"]), `${name}: pipeline expectations declare modelCalls`).toBe(true);
    expect(Number.isInteger(exp["clockReads"]), `${name}: pipeline expectations declare clockReads`).toBe(true);
    same(p!.modelCalls, exp["modelCalls"], `${name} modelCalls`);
    same(p!.clockReads, exp["clockReads"], `${name} clockReads`);
    expect(p!.clockReadsAtRun, `${name}: the model runs after exactly two clock reads`).toEqual(new Array(p!.modelCalls).fill(2));
  } else {
    expect(p, `${name}: only pipelines report calls`).toBeNull();
  }

  if ("modelError" in exp) {
    expect(run.error, `${name}: a model error is not a VisionError`).toBeNull();
    expect(run.output, `${name}: no result after a model error`).toBeNull();
    expect(p!.thrown, `${name}: the very error the scripted model threw`).toBe(p!.scriptedError);
    expect(p!.thrown).toBeInstanceOf(Error);
    expect(p!.thrown).not.toBeInstanceOf(VisionError);
    expect((p!.thrown as Error).message, `${name}: modelError message`).toBe(exp["modelError"]);
    return;
  }
  expect(p === null || p.thrown === null, `${name}: unexpected error ${String(p?.thrown)}`).toBe(true);

  if ("error" in exp) {
    const ee = exp["error"] as Json;
    expect(run.output, `${name}: expected error ${JSON.stringify(ee)}`).toBeNull();
    expect(run.error, `${name}: expected error ${JSON.stringify(ee)}`).not.toBeNull();
    expect(run.error!.kind, `${name}: error kind`).toBe(ee["kind"]);
    if ("message" in ee) expect(run.error!.message, `${name}: error message`).toBe(ee["message"]);
    return;
  }

  expect(run.error, `${name}: unexpected error ${JSON.stringify(run.error)}`).toBeNull();
  const o = run.output as any;
  expect(o, `${name}: a result`).not.toBeNull();
  expect(o.kind, `${name}: result kind`).toBe(kind);
  switch (kind) {
    case "resize":
      compareImage(o.image, exp["image"], name);
      break;
    case "geometry":
      compareGeometry(o.geometry, exp["geometry"], name);
      expect(Object.hasOwn(exp, "unmapped"), `${name}: unmapped present exactly when computed`).toBe(o.unmapped !== null);
      if (o.unmapped !== null) {
        expect(o.unmapped.length, `${name}: unmapped length`).toBe(exp["unmapped"].length);
        exp["unmapped"].forEach((e: Json | null, i: number) => {
          expect(o.unmapped[i] === null, `${name}: unmapped ${i} null exactly when expected`).toBe(e === null);
          if (e !== null) compareBox(o.unmapped[i], e, `${name} unmapped ${i}`);
        });
      }
      break;
    case "tensor":
      compareTensor(o.tensor, exp, name);
      break;
    case "classify":
      compareEntries(o.entries, exp["entries"], name);
      break;
    case "decode":
    case "nms":
      compareDetections(o.detections, exp["detections"], name);
      break;
    case "metrics":
      if (o.op === "iou" || o.op === "topk") near(o.value, exp["value"], `${name} value`);
      else {
        if (o.op === "map") near(o.map, exp["map"], `${name} map`);
        else expect(Object.hasOwn(exp, "map"), `${name}: only map has a map`).toBe(false);
        compareByClass(o.byClass, exp["byClass"], name);
      }
      break;
    case "pipeline": {
      if (o.task === "classify") compareEntries(o.results, exp["results"], name);
      else compareDetections(o.results, exp["results"], name);
      compareTiming(o.timing, exp["timing"], `${name} timing`);
      compareTensor(p!.input, exp["input"], `${name} input`);
      expect(Object.hasOwn(exp, "geometry"), `${name}: geometry present exactly for detect`).toBe(o.geometry !== null);
      if (o.geometry !== null) compareGeometry(o.geometry, exp["geometry"], `${name} geometry`);
      same(p!.modelCalls, 1, `${name} a success calls the model once`);
      same(p!.clockReads, 4, `${name} a success reads the clock four times`);
      break;
    }
    case "spec":
      expect(exp["valid"], `${name}: valid`).toBe(true);
      break;
    default:
      throw new Error(`unknown kind ${String(kind)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Every fixture
// ---------------------------------------------------------------------------------------------

let runs: Promise<Map<string, FixtureRun>> | undefined;
function allRuns(): Promise<Map<string, FixtureRun>> {
  runs ??= (async () => {
    const m = new Map<string, FixtureRun>();
    for (const fx of fixtures) m.set(fx.name, await runFixture(structuredClone(fx)));
    return m;
  })();
  return runs;
}

describe("vision contract fixtures", () => {
  it("loads all fixtures", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(348);
  });

  it("every file is exactly JSON.stringify(fixture, null, 2) + a newline, named after its fixture", () => {
    for (const f of files) {
      const text = raw.get(f)!;
      expect(text.includes("\r"), `${f}: LF only`).toBe(false);
      const parsed = JSON.parse(text);
      expect(text, `${f}: byte-exact format`).toBe(JSON.stringify(parsed, null, 2) + "\n");
      expect(parsed.name, `${f}: name equals the file name`).toBe(f.slice(0, -".json".length));
      expect(Object.keys(parsed).sort()).toEqual(["expect", "name", "setup"]);
    }
  });

  for (const fx of fixtures) {
    it(fx.name, async () => {
      const run = await runFixture(structuredClone(fx));
      checkRun(fx, run);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Unknown keys are rejected on the raw JSON at every level
// ---------------------------------------------------------------------------------------------

/** Every object of a fixture that has a closed key set: not the content of a `spec` and not a name-to-tensor map. */
function closedObjects(value: unknown, path: string[], out: Array<{ path: string[]; node: Json }>): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => closedObjects(v, [...path, String(i)], out));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const node = value as Json;
  const last = path[path.length - 1];
  const isMap = last === "outputs";
  if (!isMap) out.push({ path, node });
  for (const [k, v] of Object.entries(node)) {
    if (k === "spec" && path.length === 1 && path[0] === "setup") continue;
    closedObjects(v, [...path, k], out);
  }
}

describe("unknown keys", () => {
  it("are rejected at every level of every fixture (exact message)", async () => {
    let checked = 0;
    for (const fx of fixtures) {
      const sites: Array<{ path: string[]; node: Json }> = [];
      closedObjects(fx, [], sites);
      for (let i = 0; i < sites.length; i++) {
        const copy = structuredClone(fx) as Json;
        const copies: Array<{ path: string[]; node: Json }> = [];
        closedObjects(copy, [], copies);
        copies[i]!.node["bogusKey"] = 1;
        let message = "";
        try {
          await runFixture(copy as Fixture);
        } catch (e) {
          message = (e as Error).message;
        }
        expect(message, `${fx.name} at ${sites[i]!.path.join(".")}`).toBe("invalid fixture: unknown key: bogusKey");
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it("a spec's own unknown keys go to parseModelSpec, not the harness", async () => {
    const fx = structuredClone(fixtures.find((f) => f.name === "spec-valid-minimal")!) as Json;
    fx["setup"]["spec"]["bogusKey"] = 1;
    fx["expect"] = { error: { kind: "invalid_spec", message: "invalid model spec: unknown key: bogusKey" } };
    checkRun(fx as Fixture, await runFixture(fx as Fixture));
  });
});

// ---------------------------------------------------------------------------------------------
// The comparators reject wrong data (self-test)
// ---------------------------------------------------------------------------------------------

type Path = Array<string | number>;

/** The path of every non-container value (numbers, strings, booleans, null) of a JSON document. */
function leafPaths(node: unknown, path: Path = [], out: Path[] = []): Path[] {
  if (Array.isArray(node)) node.forEach((v, i) => leafPaths(v, [...path, i], out));
  else if (typeof node === "object" && node !== null) for (const [k, v] of Object.entries(node)) leafPaths(v, [...path, k], out);
  else out.push(path);
  return out;
}

/** The path of every non-empty array of a JSON document. */
function arrayPaths(node: unknown, path: Path = [], out: Path[] = []): Path[] {
  if (Array.isArray(node)) {
    if (node.length > 0) out.push(path);
    node.forEach((v, i) => arrayPaths(v, [...path, i], out));
  } else if (typeof node === "object" && node !== null) {
    for (const [k, v] of Object.entries(node)) arrayPaths(v, [...path, k], out);
  }
  return out;
}

const at = (root: any, path: Path): any => path.reduce((n, k) => n[k], root);

/** At most `max` evenly spread items. */
function sample<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  return Array.from({ length: max }, (_, i) => items[Math.floor((i * (items.length - 1)) / (max - 1))]!);
}

/** True when `checkRun` accepts the run. */
function passes(fx: Fixture, run: FixtureRun): boolean {
  try {
    checkRun(fx, run);
  } catch {
    return false;
  }
  return true;
}

describe("harness self-test: the comparators reject wrong data", () => {
  let all: Map<string, FixtureRun>;
  beforeAll(async () => {
    all = await allRuns();
  });

  it("accepts the real runs", () => {
    for (const fx of fixtures) expect(passes(fx, all.get(fx.name)!), fx.name).toBe(true);
  });

  it("rejects every number moved beyond the tolerance, every string changed, every boolean flipped", () => {
    let mutations = 0;
    for (const fx of fixtures) {
      const run = all.get(fx.name)!;
      for (const path of sample(leafPaths(fx.expect), 60)) {
        const value = at(fx.expect, path);
        const mutated = structuredClone(fx) as Json;
        const holder = at(mutated["expect"], path.slice(0, -1));
        const key = path[path.length - 1]!;
        if (typeof value === "number" && value + 1e-6 !== value) holder[key] = value + 1e-6;
        else if (typeof value === "string") holder[key] = value + "x";
        else if (typeof value === "boolean") holder[key] = !value;
        else continue;
        expect(passes(mutated as Fixture, run), `${fx.name}: ${path.join(".")} mutated`).toBe(false);
        mutations++;
      }
    }
    expect(mutations).toBeGreaterThan(2000);
  });

  it("rejects every list that loses its last element or gets an extra one", () => {
    let mutations = 0;
    for (const fx of fixtures) {
      const run = all.get(fx.name)!;
      for (const path of arrayPaths(fx.expect)) {
        const shorter = structuredClone(fx) as Json;
        at(shorter["expect"], path).pop();
        expect(passes(shorter as Fixture, run), `${fx.name}: ${path.join(".")} shortened`).toBe(false);
        const longer = structuredClone(fx) as Json;
        const list = at(longer["expect"], path);
        list.push(structuredClone(list[0]));
        expect(passes(longer as Fixture, run), `${fx.name}: ${path.join(".")} lengthened`).toBe(false);
        mutations += 2;
      }
    }
    expect(mutations).toBeGreaterThan(250);
  });

  it("rejects an expectation that lost a top-level key", () => {
    let mutations = 0;
    for (const fx of fixtures) {
      for (const key of Object.keys(fx.expect)) {
        const mutated = structuredClone(fx) as Json;
        delete mutated["expect"][key];
        expect(passes(mutated as Fixture, all.get(fx.name)!), `${fx.name}: ${key} removed`).toBe(false);
        mutations++;
      }
    }
    expect(mutations).toBeGreaterThan(400);
  });

  it("the tolerance is 1e-9, absolute; integers are exact", () => {
    const fx = structuredClone(fixtures.find((f) => f.name === "classify-logits-softmax")!) as Json;
    const run = all.get("classify-logits-softmax")!;
    const score = fx["expect"]["entries"][0]["score"];
    fx["expect"]["entries"][0]["score"] = score + 5e-10;
    expect(passes(fx as Fixture, run)).toBe(true);
    fx["expect"]["entries"][0]["score"] = score + 1.5e-9;
    expect(passes(fx as Fixture, run)).toBe(false);
    fx["expect"]["entries"][0]["score"] = score;
    fx["expect"]["entries"][0]["index"] = fx["expect"]["entries"][0]["index"] + 5e-10;
    expect(passes(fx as Fixture, run)).toBe(false);
  });

  it("equal non-finite values compare equal (Infinity with Infinity), NaN only with NaN", () => {
    near(Infinity, Infinity, "inf");
    near(-Infinity, -Infinity, "-inf");
    near(NaN, NaN, "nan");
    expect(() => near(Infinity, -Infinity, "x")).toThrow();
    expect(() => near(Infinity, 1, "x")).toThrow();
    expect(() => near(NaN, 1, "x")).toThrow();
  });

  it("minus zero is accepted wherever zero is, NaN never matches", () => {
    const fx = fixtures.find((f) => f.name === "geometry-centercrop-even")!;
    const run = structuredClone(all.get("geometry-centercrop-even")!) as any;
    run.output.geometry.offsetY = -0;
    expect(passes(fx, run)).toBe(true);
    run.output.geometry.offsetY = NaN;
    expect(passes(fx, run)).toBe(false);
    const run2 = structuredClone(all.get("geometry-centercrop-even")!) as any;
    run2.output.geometry.newWidth = 200.0000001;
    expect(passes(fx, run2)).toBe(false);
  });

  it("an image must match byte for byte and be a byte array", () => {
    const fx = fixtures.find((f) => f.name === "resize-nearest-upscale")!;
    const real = all.get("resize-nearest-upscale")!;
    const plain = structuredClone(real) as any;
    plain.output.image.data = Array.from(plain.output.image.data);
    expect(passes(fx, plain)).toBe(false);
    const flipped = structuredClone(real) as any;
    flipped.output.image.data[5] ^= 1;
    expect(passes(fx, flipped)).toBe(false);
    const resized = structuredClone(real) as any;
    resized.output.image.width += 1;
    expect(passes(fx, resized)).toBe(false);
  });

  it("an unexpected error, a missing error, a wrong kind and a wrong message all fail", () => {
    const withError = fixtures.find((f) => f.name === "spec-invalid-not-object")!;
    const run = all.get("spec-invalid-not-object")!;
    expect(passes(withError, run)).toBe(true);
    const wrongKind = structuredClone(withError) as Json;
    wrongKind["expect"]["error"]["kind"] = "invalid_options";
    expect(passes(wrongKind as Fixture, run)).toBe(false);
    const wrongMessage = structuredClone(withError) as Json;
    wrongMessage["expect"]["error"]["message"] += ".";
    expect(passes(wrongMessage as Fixture, run)).toBe(false);
    const success = fixtures.find((f) => f.name === "resize-nearest-upscale")!;
    expect(passes(success, { kind: "resize", output: null, error: { kind: "invalid_options", message: "x" }, pipeline: null })).toBe(false);
    const expectsError = fixtures.find((f) => f.name === "invalid-topk-zero")!;
    expect(passes(expectsError, all.get("classify-logits-softmax")!)).toBe(false);
    // the message is compared only when the expectation has one
    const noMessage = structuredClone(fixtures.find((f) => f.name === "invalid-topk-zero")!) as Json;
    expect("message" in noMessage["expect"]["error"]).toBe(false);
    const other = structuredClone(all.get("invalid-topk-zero")!);
    other.error = { kind: "invalid_options", message: "another wording" };
    expect(passes(noMessage as Fixture, other)).toBe(true);
  });

  it("a pipeline model error must be the very error object, and the model must run after two reads", () => {
    const fx = fixtures.find((f) => f.name === "pipeline-model-error-propagates")!;
    const run = structuredClone(all.get("pipeline-model-error-propagates")!);
    const real = all.get("pipeline-model-error-propagates")!;
    expect(passes(fx, real)).toBe(true);
    run.pipeline!.thrown = new Error(fx.expect["modelError"] as string);
    run.pipeline!.scriptedError = real.pipeline!.scriptedError;
    expect(passes(fx, run)).toBe(false);
    const wrapped = { ...real, pipeline: { ...real.pipeline!, thrown: new VisionError("invalid_output"), scriptedError: real.pipeline!.scriptedError } };
    expect(passes(fx, wrapped as FixtureRun)).toBe(false);
    const early = { ...real, pipeline: { ...real.pipeline!, clockReadsAtRun: [1] } };
    expect(passes(fx, early)).toBe(false);
    const ok = fixtures.find((f) => f.name === "pipeline-clock-timings")!;
    const okRun = all.get("pipeline-clock-timings")!;
    expect(passes(ok, { ...okRun, pipeline: { ...okRun.pipeline!, clockReads: 3 } })).toBe(false);
    expect(passes(ok, { ...okRun, pipeline: { ...okRun.pipeline!, modelCalls: 2, clockReadsAtRun: [2, 2] } })).toBe(false);
  });

  it("detections must be in order, with the same labels and boxes", () => {
    const fx = fixtures.find((f) => f.name === "decode-ssd-sorted-before-cut")!;
    const real = all.get("decode-ssd-sorted-before-cut")!;
    const run = structuredClone(real) as any;
    run.output.detections.reverse();
    expect(passes(fx, run)).toBe(false);
    const run2 = structuredClone(real) as any;
    run2.output.detections[0].box.x2 += 1e-6;
    expect(passes(fx, run2)).toBe(false);
    const run3 = structuredClone(real) as any;
    run3.output.detections[0].label = "other";
    expect(passes(fx, run3)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Malformed fixtures
// ---------------------------------------------------------------------------------------------

const SPEC = {
  input: { width: 1, height: 1, layout: "nhwc", channels: "rgb", mode: "stretch", resample: "nearest", dtype: "float" },
  output: { type: "logits" },
};
const DET_SPEC = { input: SPEC.input, output: { format: "ssd", boxOrder: "xyxy", coordinates: "pixels" } };
const BOX = { x1: 0, y1: 0, x2: 1, y2: 1 };
const GEO = { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0, newWidth: 1, newHeight: 1 };
const IMG = { width: 1, height: 1, data: [1, 2, 3] };
const DET = { box: BOX, classIndex: 0, label: "#0", score: 0.9 };
const MDET = { image: "a", classIndex: 0, score: 0.9, box: BOX };
const MTRUTH = { image: "a", classIndex: 0, box: BOX };
const SSD_OUT = {
  boxes: { shape: [1, 1, 4], data: [0, 0, 1, 1] },
  classes: { shape: [1, 1], data: [0] },
  scores: { shape: [1, 1], data: [0.9] },
};

/** One valid, runnable fixture per kind (and metrics op, pipeline task). */
const BASES: Record<string, () => any> = {
  resize: () => ({ name: "t", setup: { kind: "resize", image: IMG, width: 1, height: 1, method: "nearest" }, expect: { image: IMG } }),
  geometry: () => ({ name: "t", setup: { kind: "geometry", srcWidth: 2, srcHeight: 2, spec: SPEC, boxes: [BOX] }, expect: { geometry: { ...GEO, scaleX: 0.5, scaleY: 0.5 }, unmapped: [{ x1: 0, y1: 0, x2: 2, y2: 2 }] } }),
  tensor: () => ({ name: "t", setup: { kind: "tensor", image: IMG, spec: SPEC }, expect: { shape: [1, 1, 1, 3], data: [1, 2, 3] } }),
  classify: () => ({ name: "t", setup: { kind: "classify", output: [0.5, 0.25], spec: { input: SPEC.input, output: { type: "probabilities" } }, options: { topK: 1, minScore: 0 } }, expect: { entries: [{ index: 0, label: "#0", score: 0.5 }] } }),
  decode: () => ({ name: "t", setup: { kind: "decode", outputs: SSD_OUT, spec: DET_SPEC, srcWidth: 1, srcHeight: 1, options: { scoreThreshold: 0.1, iouThreshold: 0.5, maxDetections: 5, nms: false } }, expect: { detections: [DET] } }),
  nms: () => ({ name: "t", setup: { kind: "nms", detections: [DET], iouThreshold: 0.5 }, expect: { detections: [DET] } }),
  iou: () => ({ name: "t", setup: { kind: "metrics", op: "iou", a: BOX, b: BOX }, expect: { value: 1 } }),
  topk: () => ({ name: "t", setup: { kind: "metrics", op: "topk", predictions: [[1, 2]], truths: [2], k: 2 }, expect: { value: 1 } }),
  ap: () => ({ name: "t", setup: { kind: "metrics", op: "ap", detections: [MDET], truths: [MTRUTH], iouThreshold: 0.5 }, expect: { byClass: [{ classIndex: 0, ap: 1 }] } }),
  map: () => ({ name: "t", setup: { kind: "metrics", op: "map", detections: [MDET], truths: [MTRUTH], iouThreshold: 0.5 }, expect: { map: 1, byClass: [{ classIndex: 0, ap: 1 }] } }),
  classifyPipeline: () => ({
    name: "t",
    setup: { kind: "pipeline", image: IMG, spec: { input: SPEC.input, output: { type: "probabilities" } }, task: "classify", scripted: { outputs: { output: { shape: [2], data: [0.5, 0.25] } } }, options: { topK: 1, minScore: 0 }, clock: [0, 1, 2, 3] },
    expect: { results: [{ index: 0, label: "#0", score: 0.5 }], timing: { preprocessMs: 1, inferenceMs: 1, postprocessMs: 1 }, modelCalls: 1, clockReads: 4, input: { shape: [1, 1, 1, 3], data: [1, 2, 3] } },
  }),
  detectPipeline: () => ({
    name: "t",
    setup: { kind: "pipeline", image: IMG, spec: DET_SPEC, task: "detect", scripted: { outputs: SSD_OUT }, options: { scoreThreshold: 0.1, iouThreshold: 0.5, maxDetections: 5, nms: false }, clock: [0, 1, 2, 3] },
    expect: { results: [DET], timing: { preprocessMs: 1, inferenceMs: 1, postprocessMs: 1 }, modelCalls: 1, clockReads: 4, input: { shape: [1, 1, 1, 3], data: [1, 2, 3] }, geometry: GEO },
  }),
  modelError: () => ({
    name: "t",
    setup: { kind: "pipeline", image: IMG, spec: SPEC, task: "classify", scripted: { error: "boom" }, clock: [0, 1, 2, 3] },
    expect: { modelError: "boom", modelCalls: 1, clockReads: 2 },
  }),
  pipelineError: () => ({
    name: "t",
    setup: { kind: "pipeline", image: IMG, spec: SPEC, task: "classify", scripted: { outputs: {} }, clock: [0, 1, 2, 3] },
    expect: { error: { kind: "invalid_output" }, modelCalls: 1, clockReads: 3 },
  }),
  spec: () => ({ name: "t", setup: { kind: "spec", spec: SPEC }, expect: { valid: true } }),
  specError: () => ({ name: "t", setup: { kind: "spec", spec: 1 }, expect: { error: { kind: "invalid_spec", message: "invalid model spec: spec must be an object" } } }),
  error: () => ({ name: "t", setup: { kind: "resize", image: IMG, width: 0, height: 1, method: "nearest" }, expect: { error: { kind: "invalid_options" } } }),
};

// Every use gets its own copy: the tests below mutate what they get.
for (const key of Object.keys(BASES)) {
  const make = BASES[key]!;
  BASES[key] = () => structuredClone(make());
}

async function messageOf(fx: unknown): Promise<string> {
  try {
    await runFixture(fx as Fixture);
  } catch (e) {
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(VisionError);
    return (e as Error).message;
  }
  return "no error";
}

/** Applies `mutate` to a fresh base fixture and asserts the exact malformed-fixture message. */
async function malformed(base: string, mutate: (fx: any) => void, reason: string): Promise<void> {
  const fx = BASES[base]!();
  mutate(fx);
  expect(await messageOf(fx), `${base}: ${reason}`).toBe(`invalid fixture: ${reason}`);
}

describe("the base fixtures are valid", () => {
  for (const name of Object.keys(BASES)) {
    it(name, async () => {
      const fx = BASES[name]!() as Fixture;
      checkRun(fx, await runFixture(structuredClone(fx)));
    });
  }
});

describe("malformed fixtures: exact messages", () => {
  it("unknown setup kind, including prototype names", async () => {
    for (const kind of ["bogus", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
      await malformed("resize", (fx) => (fx["setup"]["kind"] = kind), `unknown setup kind: ${kind}`);
    }
  });

  it("unknown keys at every level of the structures", async () => {
    await malformed("resize", (fx) => (fx["bogus"] = 1), "unknown key: bogus");
    await malformed("resize", (fx) => (fx["setup"]["bogus"] = 1), "unknown key: bogus");
    await malformed("resize", (fx) => (fx["setup"]["image"]["bogus"] = 1), "unknown key: bogus");
    await malformed("resize", (fx) => (fx["setup"]["image"]["data"] = { fill: 1, length: 3, bogus: 1 }), "unknown key: bogus");
    await malformed("resize", (fx) => (fx["expect"]["bogus"] = 1), "unknown key: bogus");
    await malformed("tensor", (fx) => (fx["expect"]["bogus"] = 1), "unknown key: bogus");
    await malformed("decode", (fx) => (fx["setup"]["outputs"]["boxes"]["bogus"] = 1), "unknown key: bogus");
    await malformed("decode", (fx) => (fx["setup"]["options"]["bogus"] = 1), "unknown key: bogus");
    await malformed("decode", (fx) => (fx["expect"]["detections"][0]["bogus"] = 1), "unknown key: bogus");
    await malformed("decode", (fx) => (fx["expect"]["detections"][0]["box"]["bogus"] = 1), "unknown key: bogus");
    await malformed("nms", (fx) => (fx["setup"]["detections"][0]["bogus"] = 1), "unknown key: bogus");
    await malformed("classify", (fx) => (fx["expect"]["entries"][0]["bogus"] = 1), "unknown key: bogus");
    await malformed("classify", (fx) => (fx["setup"]["options"]["bogus"] = 1), "unknown key: bogus");
    await malformed("geometry", (fx) => (fx["expect"]["geometry"]["bogus"] = 1), "unknown key: bogus");
    await malformed("geometry", (fx) => (fx["setup"]["boxes"][0]["bogus"] = 1), "unknown key: bogus");
    await malformed("ap", (fx) => (fx["setup"]["detections"][0]["bogus"] = 1), "unknown key: bogus");
    await malformed("ap", (fx) => (fx["setup"]["truths"][0]["bogus"] = 1), "unknown key: bogus");
    await malformed("ap", (fx) => (fx["expect"]["byClass"][0]["bogus"] = 1), "unknown key: bogus");
    await malformed("classifyPipeline", (fx) => (fx["setup"]["scripted"]["bogus"] = 1), "unknown key: bogus");
    await malformed("classifyPipeline", (fx) => (fx["setup"]["options"]["bogus"] = 1), "unknown key: bogus");
    await malformed("classifyPipeline", (fx) => (fx["expect"]["timing"]["bogus"] = 1), "unknown key: bogus");
    await malformed("detectPipeline", (fx) => (fx["expect"]["geometry"]["bogus"] = 1), "unknown key: bogus");
    await malformed("error", (fx) => (fx["expect"]["error"]["bogus"] = 1), "unknown key: bogus");
  });

  it("classifier options are not the options of a detector", async () => {
    await malformed("classifyPipeline", (fx) => (fx["setup"]["options"] = { scoreThreshold: 0.5 }), "unknown key: scoreThreshold");
    await malformed("detectPipeline", (fx) => (fx["setup"]["options"] = { topK: 1 }), "unknown key: topK");
    await malformed("classify", (fx) => (fx["setup"]["options"] = { nms: true }), "unknown key: nms");
    await malformed("decode", (fx) => (fx["setup"]["options"] = { minScore: 0 }), "unknown key: minScore");
  });

  it("missing keys", async () => {
    await malformed("resize", (fx) => delete fx["setup"]["method"], "missing key: method");
    await malformed("resize", (fx) => delete fx["setup"]["image"]["data"], "missing key: data");
    await malformed("resize", (fx) => delete fx["setup"]["image"]["width"], "missing key: width");
    await malformed("resize", (fx) => delete fx["setup"]["kind"], "missing key: kind");
    await malformed("resize", (fx) => delete fx["name"], "missing key: name");
    await malformed("resize", (fx) => delete fx["setup"], "missing key: setup");
    await malformed("resize", (fx) => delete fx["expect"], "missing key: expect");
    await malformed("resize", (fx) => (fx["setup"]["image"]["data"] = { fill: 1 }), "missing key: length");
    await malformed("resize", (fx) => delete fx["expect"]["image"]["height"], "missing key: height");
    await malformed("tensor", (fx) => delete fx["expect"]["shape"], "missing key: shape");
    await malformed("decode", (fx) => delete fx["setup"]["outputs"]["boxes"]["data"], "missing key: data");
    await malformed("decode", (fx) => delete fx["setup"]["spec"], "missing key: spec");
    await malformed("decode", (fx) => delete fx["setup"]["srcWidth"], "missing key: srcWidth");
    await malformed("decode", (fx) => delete fx["expect"]["detections"][0]["label"], "missing key: label");
    await malformed("decode", (fx) => delete fx["expect"]["detections"][0]["box"]["y2"], "missing key: y2");
    await malformed("nms", (fx) => delete fx["setup"]["iouThreshold"], "missing key: iouThreshold");
    await malformed("classify", (fx) => delete fx["expect"]["entries"][0]["score"], "missing key: score");
    await malformed("geometry", (fx) => delete fx["expect"]["unmapped"], "missing key: unmapped");
    await malformed("geometry", (fx) => delete fx["expect"]["geometry"]["scaleY"], "missing key: scaleY");
    await malformed("map", (fx) => delete fx["expect"]["map"], "missing key: map");
    await malformed("map", (fx) => delete fx["setup"]["op"], "missing key: op");
    await malformed("ap", (fx) => delete fx["setup"]["detections"][0]["image"], "missing key: image");
    await malformed("ap", (fx) => delete fx["setup"]["truths"][0]["box"], "missing key: box");
    await malformed("ap", (fx) => delete fx["expect"]["byClass"][0]["ap"], "missing key: ap");
    await malformed("iou", (fx) => delete fx["setup"]["b"], "missing key: b");
    await malformed("topk", (fx) => delete fx["setup"]["k"], "missing key: k");
    await malformed("classifyPipeline", (fx) => delete fx["setup"]["clock"], "missing key: clock");
    await malformed("classifyPipeline", (fx) => delete fx["setup"]["scripted"], "missing key: scripted");
    await malformed("classifyPipeline", (fx) => (fx["setup"]["scripted"] = {}), "missing key: outputs");
    await malformed("classifyPipeline", (fx) => delete fx["setup"]["task"], "missing key: task");
    await malformed("classifyPipeline", (fx) => delete fx["expect"]["clockReads"], "missing key: clockReads");
    await malformed("classifyPipeline", (fx) => delete fx["expect"]["modelCalls"], "missing key: modelCalls");
    await malformed("classifyPipeline", (fx) => delete fx["expect"]["input"], "missing key: input");
    await malformed("classifyPipeline", (fx) => delete fx["expect"]["timing"]["inferenceMs"], "missing key: inferenceMs");
    await malformed("detectPipeline", (fx) => delete fx["expect"]["geometry"], "missing key: geometry");
    await malformed("pipelineError", (fx) => delete fx["expect"]["clockReads"], "missing key: clockReads");
    await malformed("modelError", (fx) => delete fx["expect"]["modelCalls"], "missing key: modelCalls");
    await malformed("specError", (fx) => delete fx["expect"]["error"]["message"], "missing key: message");
    await malformed("error", (fx) => delete fx["expect"]["error"]["kind"], "missing key: kind");
    await malformed("spec", (fx) => delete fx["setup"]["spec"], "missing key: spec");
  });

  it("wrong types", async () => {
    for (const bad of [1, null, true, {}, []]) {
      await malformed("resize", (fx) => (fx["name"] = bad), "wrong type: name");
      await malformed("resize", (fx) => (fx["setup"]["kind"] = bad), "wrong type: kind");
    }
    await malformed("resize", (fx) => (fx["setup"] = 1), "wrong type: setup");
    await malformed("resize", (fx) => (fx["expect"] = []), "wrong type: expect");
    await malformed("resize", (fx) => (fx["setup"]["method"] = 3), "wrong type: method");
    await malformed("resize", (fx) => (fx["setup"]["image"] = "x"), "wrong type: image");
    await malformed("resize", (fx) => (fx["setup"]["width"] = "1"), "wrong type: width");
    await malformed("resize", (fx) => (fx["setup"]["height"] = {}), "wrong type: height");
    await malformed("resize", (fx) => (fx["setup"]["image"]["width"] = "1"), "wrong type: width");
    await malformed("resize", (fx) => (fx["setup"]["image"]["height"] = [1]), "wrong type: height");
    await malformed("resize", (fx) => (fx["setup"]["image"]["data"] = "abc"), "wrong type: data");
    await malformed("resize", (fx) => (fx["setup"]["image"]["data"] = [1, 2, 256]), "wrong type: data");
    await malformed("resize", (fx) => (fx["setup"]["image"]["data"] = [1, 2, -1]), "wrong type: data");
    await malformed("resize", (fx) => (fx["setup"]["image"]["data"] = [1, 2, 1.5]), "wrong type: data");
    await malformed("resize", (fx) => (fx["setup"]["image"]["data"] = [1, 2, "3"]), "wrong type: data");
    await malformed("resize", (fx) => (fx["setup"]["image"]["data"] = [1, 2, null]), "wrong type: data");
    await malformed("resize", (fx) => (fx["setup"]["image"]["data"] = { fill: 1.5, length: 3 }), "wrong type: fill");
    await malformed("resize", (fx) => (fx["setup"]["image"]["data"] = { fill: 256, length: 3 }), "wrong type: fill");
    await malformed("resize", (fx) => (fx["setup"]["image"]["data"] = { fill: 1, length: "3" }), "wrong type: length");
    await malformed("resize", (fx) => (fx["setup"]["image"]["data"] = { fill: 1, length: 2.5 }), "wrong type: length");
    await malformed("resize", (fx) => (fx["setup"]["image"]["data"] = { fill: 1, length: -1 }), "wrong type: length");
    await malformed("tensor", (fx) => (fx["expect"]["shape"] = 4), "wrong type: shape");
    await malformed("tensor", (fx) => (fx["expect"]["data"] = {}), "wrong type: data");
    await malformed("tensor", (fx) => (fx["expect"]["data"] = [1, "x"]), "wrong type: data");
    await malformed("tensor", (fx) => (fx["expect"]["data"] = [1, null]), "wrong type: data");
    await malformed("classify", (fx) => (fx["setup"]["output"] = "x"), "wrong type: output");
    await malformed("classify", (fx) => (fx["setup"]["output"] = [1, "inf"]), "wrong type: output");
    await malformed("classify", (fx) => (fx["setup"]["options"]["topK"] = "1"), "wrong type: topK");
    await malformed("classify", (fx) => (fx["setup"]["options"]["minScore"] = true), "wrong type: minScore");
    await malformed("classify", (fx) => (fx["expect"]["entries"] = {}), "wrong type: entries");
    await malformed("classify", (fx) => (fx["expect"]["entries"][0]["index"] = 0.5), "wrong type: index");
    await malformed("classify", (fx) => (fx["expect"]["entries"][0]["label"] = 1), "wrong type: label");
    await malformed("classify", (fx) => (fx["expect"]["entries"][0]["score"] = "x"), "wrong type: score");
    await malformed("decode", (fx) => (fx["setup"]["options"]["nms"] = "true"), "wrong type: nms");
    await malformed("decode", (fx) => (fx["setup"]["options"]["maxDetections"] = "1"), "wrong type: maxDetections");
    await malformed("decode", (fx) => (fx["setup"]["srcWidth"] = "1"), "wrong type: srcWidth");
    await malformed("decode", (fx) => (fx["expect"]["detections"][0]["classIndex"] = 0.5), "wrong type: classIndex");
    await malformed("decode", (fx) => (fx["expect"]["detections"][0]["score"] = "high"), "wrong type: score");
    await malformed("decode", (fx) => (fx["expect"]["detections"][0]["box"]["x1"] = "left"), "wrong type: x1");
    await malformed("decode", (fx) => (fx["expect"]["detections"] = 1), "wrong type: detections");
    await malformed("decode", (fx) => (fx["setup"]["outputs"]["boxes"]["shape"] = "x"), "wrong type: shape");
    await malformed("decode", (fx) => (fx["setup"]["outputs"]["boxes"] = 1), "wrong type: boxes");
    await malformed("nms", (fx) => (fx["setup"]["detections"] = "x"), "wrong type: detections");
    await malformed("nms", (fx) => (fx["setup"]["iouThreshold"] = "0.5"), "wrong type: iouThreshold");
    await malformed("geometry", (fx) => (fx["setup"]["boxes"] = {}), "wrong type: boxes");
    await malformed("geometry", (fx) => (fx["setup"]["srcHeight"] = "2"), "wrong type: srcHeight");
    await malformed("geometry", (fx) => (fx["expect"]["geometry"]["scaleX"] = null), "wrong type: scaleX");
    await malformed("geometry", (fx) => (fx["expect"]["unmapped"] = 1), "wrong type: unmapped");
    await malformed("iou", (fx) => (fx["setup"]["a"] = 1), "wrong type: a");
    await malformed("iou", (fx) => (fx["expect"]["value"] = "1"), "wrong type: value");
    await malformed("topk", (fx) => (fx["setup"]["predictions"] = "x"), "wrong type: predictions");
    await malformed("topk", (fx) => (fx["setup"]["predictions"] = [1]), "wrong type: predictions");
    await malformed("topk", (fx) => (fx["setup"]["truths"] = 1), "wrong type: truths");
    await malformed("topk", (fx) => (fx["setup"]["k"] = "2"), "wrong type: k");
    await malformed("ap", (fx) => (fx["setup"]["detections"] = 1), "wrong type: detections");
    await malformed("ap", (fx) => (fx["setup"]["truths"] = 1), "wrong type: truths");
    await malformed("ap", (fx) => (fx["setup"]["detections"][0]["image"] = 1), "wrong type: image");
    await malformed("ap", (fx) => (fx["setup"]["detections"][0]["score"] = {}), "wrong type: score");
    await malformed("ap", (fx) => (fx["setup"]["iouThreshold"] = "0.5"), "wrong type: iouThreshold");
    await malformed("ap", (fx) => (fx["expect"]["byClass"] = {}), "wrong type: byClass");
    await malformed("ap", (fx) => (fx["expect"]["byClass"][0]["classIndex"] = 0.5), "wrong type: classIndex");
    await malformed("map", (fx) => (fx["expect"]["map"] = null), "wrong type: map");
    await malformed("classifyPipeline", (fx) => (fx["setup"]["task"] = 1), "wrong type: task");
    await malformed("classifyPipeline", (fx) => (fx["setup"]["clock"] = "x"), "wrong type: clock");
    await malformed("classifyPipeline", (fx) => (fx["setup"]["clock"] = [0, 1, 2]), "wrong type: clock");
    await malformed("classifyPipeline", (fx) => (fx["setup"]["clock"] = [0, 1, 2, 3, 4]), "wrong type: clock");
    await malformed("classifyPipeline", (fx) => (fx["setup"]["clock"] = [0, 1, 2, "3"]), "wrong type: clock");
    await malformed("classifyPipeline", (fx) => (fx["setup"]["scripted"] = 1), "wrong type: scripted");
    await malformed("classifyPipeline", (fx) => (fx["setup"]["scripted"]["outputs"] = []), "wrong type: outputs");
    await malformed("classifyPipeline", (fx) => (fx["setup"]["scripted"]["outputs"]["output"]["data"] = "x"), "wrong type: data");
    await malformed("modelError", (fx) => (fx["setup"]["scripted"]["error"] = 1), "wrong type: error");
    await malformed("modelError", (fx) => (fx["expect"]["modelError"] = 1), "wrong type: modelError");
    await malformed("classifyPipeline", (fx) => (fx["expect"]["modelCalls"] = 1.5), "wrong type: modelCalls");
    await malformed("classifyPipeline", (fx) => (fx["expect"]["clockReads"] = "4"), "wrong type: clockReads");
    await malformed("classifyPipeline", (fx) => (fx["expect"]["timing"] = []), "wrong type: timing");
    await malformed("classifyPipeline", (fx) => (fx["expect"]["input"]["shape"] = 1), "wrong type: shape");
    await malformed("classifyPipeline", (fx) => (fx["expect"]["results"] = 1), "wrong type: results");
    await malformed("classifyPipeline", (fx) => (fx["setup"]["options"]["topK"] = []), "wrong type: topK");
    await malformed("spec", (fx) => (fx["expect"]["valid"] = "yes"), "wrong type: valid");
    await malformed("error", (fx) => (fx["expect"]["error"]["kind"] = 1), "wrong type: kind");
    await malformed("error", (fx) => (fx["expect"]["error"] = "x"), "wrong type: error");
    await malformed("error", (fx) => (fx["expect"]["error"]["message"] = 1), "wrong type: message");
  });

  it("the allowed exceptions: null for sizes and options, non-finite strings for numbers", async () => {
    for (const mutate of [
      (fx: any) => (fx["setup"]["width"] = null),
      (fx: any) => (fx["setup"]["height"] = 2.5),
      (fx: any) => (fx["setup"]["method"] = null),
      (fx: any) => (fx["setup"]["image"]["width"] = null),
    ]) {
      const fx = BASES["resize"]!();
      mutate(fx);
      fx["expect"] = { error: { kind: "invalid_options" } };
      checkRun(fx, await runFixture(structuredClone(fx)));
    }
    const cls = BASES["classify"]!();
    cls["setup"]["output"] = [0.5, "NaN"];
    cls["expect"] = { error: { kind: "invalid_output" } };
    checkRun(cls, await runFixture(cls));
    const dec = BASES["decode"]!();
    dec["setup"]["options"] = { scoreThreshold: null, iouThreshold: null, maxDetections: null, nms: null };
    dec["expect"] = { error: { kind: "invalid_options" } };
    checkRun(dec, await runFixture(dec));
    const nmsFx = BASES["nms"]!();
    nmsFx["setup"]["iouThreshold"] = null;
    nmsFx["expect"] = { error: { kind: "invalid_options" } };
    checkRun(nmsFx, await runFixture(nmsFx));
    const geo = BASES["geometry"]!();
    geo["setup"]["boxes"] = [{ x1: 0, y1: "NaN", x2: "Infinity", y2: "-Infinity" }];
    geo["expect"] = { error: { kind: "invalid_options" } };
    checkRun(geo, await runFixture(geo));
    const ap = BASES["ap"]!();
    ap["setup"]["detections"][0]["score"] = "NaN";
    ap["setup"]["truths"][0]["classIndex"] = 1.5;
    ap["setup"]["iouThreshold"] = null;
    ap["expect"] = { error: { kind: "invalid_options" } };
    checkRun(ap, await runFixture(ap));
    const tk = BASES["topk"]!();
    tk["setup"]["k"] = null;
    tk["expect"] = { error: { kind: "invalid_options" } };
    checkRun(tk, await runFixture(tk));
  });

  it("unknown metrics op", async () => {
    await malformed("iou", (fx) => (fx["setup"]["op"] = "recall"), "unknown metrics op: recall");
    await malformed("iou", (fx) => (fx["setup"]["op"] = "constructor"), "unknown metrics op: constructor");
    await malformed("iou", (fx) => (fx["setup"]["op"] = 5), "wrong type: op");
  });

  it("an expectation with neither the keys of its kind nor error", async () => {
    const neither = "expect has neither the keys of its kind nor error";
    for (const [base, empty] of [
      ["resize", {}],
      ["tensor", {}],
      ["classify", {}],
      ["decode", {}],
      ["nms", {}],
      ["iou", {}],
      ["ap", {}],
      ["geometry", {}],
      ["classifyPipeline", {}],
      ["classifyPipeline", { modelCalls: 1, clockReads: 4 }],
      ["spec", {}],
    ] as Array<[string, Json]>) {
      await malformed(base, (fx) => (fx["expect"] = empty), neither);
    }
  });

  it("expectations of the wrong kind are unknown keys", async () => {
    await malformed("resize", (fx) => (fx["expect"] = { entries: [] }), "unknown key: entries");
    await malformed("iou", (fx) => (fx["expect"] = { byClass: [] }), "unknown key: byClass");
    await malformed("ap", (fx) => (fx["expect"] = { map: 1, byClass: [] }), "unknown key: map");
    await malformed("spec", (fx) => (fx["expect"] = { value: 1 }), "unknown key: value");
    await malformed("geometry", (fx) => delete fx["setup"]["boxes"], "unknown key: unmapped");
    await malformed("classifyPipeline", (fx) => (fx["expect"]["geometry"] = GEO), "unknown key: geometry");
    await malformed("resize", (fx) => (fx["expect"] = { error: { kind: "invalid_options" }, image: IMG }), "unknown key: image");
    await malformed("resize", (fx) => (fx["expect"] = { modelCalls: 1 }), "unknown key: modelCalls");
  });

  it("the scripted clock fails on a fifth read", () => {
    const clock = scriptedClock([1, 2, 3, 4]);
    expect([clock.nowMs(), clock.nowMs(), clock.nowMs(), clock.nowMs()]).toEqual([1, 2, 3, 4]);
    expect(clock.reads).toBe(4);
    expect(() => clock.nowMs()).toThrowError("invalid fixture: clock called more than four times");
    expect(clock.reads).toBe(4);
  });

  it("the harness does not hide a non-vision error thrown outside the pipeline", async () => {
    // a fixture that the library handles by throwing a VisionError is data; anything else is a harness failure
    const fx = BASES["error"]!();
    checkRun(fx, await runFixture(fx));
  });
});

describe("the harness runs the library exactly as the contract describes", () => {
  it("a pipeline fixture records one model call, four clock reads and the input tensor", async () => {
    const run = await runFixture(BASES["classifyPipeline"]!() as Fixture);
    expect(run.pipeline).toMatchObject({ modelCalls: 1, clockReads: 4, clockReadsAtRun: [2], thrown: null });
    expect(run.pipeline!.input).toEqual({ shape: [1, 1, 1, 3], data: [1, 2, 3] });
  });

  it("a validation error leaves zero reads and zero calls; an invalid output three reads", async () => {
    const fx = BASES["classifyPipeline"]!();
    fx["setup"]["options"] = { topK: null };
    const run = await runFixture(fx as Fixture);
    expect(run.error!.kind).toBe("invalid_options");
    expect(run.pipeline).toMatchObject({ modelCalls: 0, clockReads: 0, clockReadsAtRun: [] });
    const bad = await runFixture(BASES["pipelineError"]!() as Fixture);
    expect(bad.pipeline).toMatchObject({ modelCalls: 1, clockReads: 3, clockReadsAtRun: [2] });
  });

  it("the scripted model error is a fresh, non-vision Error with the scripted message", async () => {
    const run = await runFixture(BASES["modelError"]!() as Fixture);
    expect(run.pipeline!.thrown).toBe(run.pipeline!.scriptedError);
    expect((run.pipeline!.thrown as Error).message).toBe("boom");
    expect(run.pipeline!.clockReads).toBe(2);
  });

  it("does not mutate the fixture", async () => {
    for (const name of Object.keys(BASES)) {
      const fx = BASES[name]!();
      const copy = JSON.stringify(fx);
      await runFixture(fx as Fixture);
      expect(JSON.stringify(fx), name).toBe(copy);
    }
  });
});

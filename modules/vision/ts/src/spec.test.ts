import { describe, expect, it } from "vitest";
import { VisionError } from "./errors.js";
import { parseModelSpec } from "./spec.js";

const input = () => ({ width: 2, height: 2, layout: "nhwc", channels: "rgb", mode: "stretch", resample: "nearest", dtype: "float" });
const classifier = () => ({ input: input(), output: { type: "logits" } });

/** The reason of the VisionError(invalid_spec) a spec fails with (the prefix is asserted too). */
function reason(spec: unknown): string {
  try {
    parseModelSpec(spec);
  } catch (e) {
    expect(e).toBeInstanceOf(VisionError);
    expect((e as VisionError).kind).toBe("invalid_spec");
    const message = (e as VisionError).message;
    expect(message.startsWith("invalid model spec: ")).toBe(true);
    return message.slice("invalid model spec: ".length);
  }
  throw new Error("expected the spec to be rejected");
}

const withInput = (patch: Record<string, unknown>) => ({ ...classifier(), input: { ...input(), ...patch } });
const withOutput = (output: unknown) => ({ input: input(), output });

describe("parseModelSpec accepts", () => {
  it("a minimal classifier and returns a copy", () => {
    const json = classifier();
    const spec = parseModelSpec(json);
    expect(spec).toEqual(json);
    expect(spec).not.toBe(json);
    expect(spec.input).not.toBe(json.input);
  });

  it("every optional key", () => {
    const json = {
      input: { ...input(), padValue: 0, scale: -2, mean: [-1, 0, 1], std: [-1, 2, 3] },
      output: { format: "rows", boxFormat: "xyxy", transposed: true, objectness: false, scoreActivation: "sigmoid" },
      labels: [],
      labelOffset: -1000000,
    };
    expect(parseModelSpec(json)).toEqual(json);
    expect(parseModelSpec({ ...json, labelOffset: 1000000 })).toBeTruthy();
  });

  it("224.0 as an integer and does not alias arrays", () => {
    const json = JSON.parse('{"input":{"width":224.0,"height":224,"layout":"nhwc","channels":"rgb","mode":"stretch","resample":"nearest","dtype":"float","mean":[0,0,0]},"output":{"type":"logits"},"labels":["a"]}');
    const spec = parseModelSpec(json);
    json.input.mean[0] = 9;
    json.labels[0] = "z";
    expect(spec.input.mean).toEqual([0, 0, 0]);
    expect(spec.labels).toEqual(["a"]);
  });

  it("an absent key given as undefined (typed hand-built spec)", () => {
    expect(parseModelSpec({ ...classifier(), labels: undefined })).toBeTruthy();
  });
});

describe("parseModelSpec edge cases (clarification 33)", () => {
  it("minus zero is accepted wherever zero is (padValue, labelOffset, scale, mean)", () => {
    const json = { input: { ...input(), padValue: -0, scale: -0, mean: [-0, 0, 0] }, output: { type: "logits" }, labelOffset: -0 };
    expect(parseModelSpec(json)).toBeTruthy();
  });
  it("the JSON literal 1e999 is non-finite and rejected", () => {
    const base = '{"input":{"width":2,"height":2,"layout":"nhwc","channels":"rgb","mode":"stretch","resample":"nearest","dtype":"float",';
    expect(reason(JSON.parse(base + '"scale":1e999},"output":{"type":"logits"}}'))).toBe("input.scale must be a finite number");
    expect(reason(JSON.parse(base + '"std":[1e999,1,1]},"output":{"type":"logits"}}'))).toBe("input.std must be an array of 3 finite numbers");
  });
  it("sparse arrays (holes) in a hand-built spec are rejected", () => {
    expect(reason(withInput({ mean: new Array(3) }))).toBe("input.mean must be an array of 3 finite numbers");
    expect(reason(withInput({ std: new Array(3) }))).toBe("input.std must be an array of 3 finite numbers");
    expect(reason({ ...classifier(), labels: new Array(2) })).toBe("labels must be an array of strings");
  });
});

describe("parseModelSpec rejects, rule by rule", () => {
  it("1 not an object", () => {
    for (const v of [null, 1, "s", [], true]) expect(reason(v)).toBe("spec must be an object");
  });
  it("2 unknown top-level key", () => expect(reason({ ...classifier(), extra: 1 })).toBe("unknown key: extra"));
  it("2 __proto__ is an unknown key", () => {
    expect(reason(JSON.parse('{"__proto__":1,"input":{},"output":{}}'))).toBe("unknown key: __proto__");
  });
  it("3 missing input / output", () => {
    expect(reason({ output: { type: "logits" } })).toBe("missing key: input");
    expect(reason({ input: input() })).toBe("missing key: output");
  });
  it("4 input not an object", () => expect(reason({ input: 3, output: { type: "logits" } })).toBe("input must be an object"));
  it("5 unknown input key", () => expect(reason(withInput({ foo: 1 }))).toBe("unknown key: input.foo"));
  it("6 missing required input keys, in order", () => {
    for (const k of ["width", "height", "layout", "channels", "mode", "resample", "dtype"]) {
      const i = input() as Record<string, unknown>;
      delete i[k];
      expect(reason({ input: i, output: { type: "logits" } })).toBe(`missing key: input.${k}`);
    }
    expect(reason({ input: { width: 1 }, output: { type: "logits" } })).toBe("missing key: input.height");
  });
  it("7 width and height", () => {
    for (const k of ["width", "height"]) {
      for (const v of [0, 16385, 1.5, "2", null, NaN, Infinity]) {
        expect(reason(withInput({ [k]: v }))).toBe(`input.${k} must be an integer from 1 to 16384`);
      }
    }
  });
  it("8-12 enums", () => {
    expect(reason(withInput({ layout: "x" }))).toBe('input.layout must be "nhwc" or "nchw"');
    expect(reason(withInput({ channels: "x" }))).toBe('input.channels must be "rgb" or "bgr"');
    expect(reason(withInput({ mode: null }))).toBe('input.mode must be "stretch", "centerCrop" or "letterbox"');
    expect(reason(withInput({ resample: "cubic" }))).toBe('input.resample must be "nearest" or "bilinear"');
    expect(reason(withInput({ dtype: 1 }))).toBe('input.dtype must be "float" or "uint8"');
  });
  it("13 padValue", () => {
    for (const v of [-1, 256, 1.5, null, "1"]) expect(reason(withInput({ padValue: v }))).toBe("input.padValue must be an integer from 0 to 255");
    expect(parseModelSpec(withInput({ padValue: 255, mode: "stretch" })).input.padValue).toBe(255);
  });
  it("14 scale", () => {
    for (const v of [null, "1", Infinity, NaN]) expect(reason(withInput({ scale: v }))).toBe("input.scale must be a finite number");
    expect(parseModelSpec(withInput({ scale: 0 })).input.scale).toBe(0);
  });
  it("15 mean", () => {
    for (const v of [null, [1, 2], [1, 2, 3, 4], [1, 2, "3"], [1, NaN, 3], "x"]) {
      expect(reason(withInput({ mean: v }))).toBe("input.mean must be an array of 3 finite numbers");
    }
  });
  it("16 std", () => {
    for (const v of [null, [1, 2], [1, 2, null], [Infinity, 1, 1]]) {
      expect(reason(withInput({ std: v }))).toBe("input.std must be an array of 3 finite numbers");
    }
  });
  it("17 std entries must not be 0", () => {
    expect(reason(withInput({ std: [1, 0, 1] }))).toBe("input.std entries must not be 0");
    expect(reason(withInput({ std: [1, -0, 1] }))).toBe("input.std entries must not be 0");
    expect(parseModelSpec(withInput({ std: [-1, 1, 1] }))).toBeTruthy();
  });
  it("18 uint8 forbids scale, mean, std (in that order)", () => {
    expect(reason(withInput({ dtype: "uint8", scale: 1 }))).toBe("input.scale is not allowed with dtype uint8");
    expect(reason(withInput({ dtype: "uint8", mean: [0, 0, 0] }))).toBe("input.mean is not allowed with dtype uint8");
    expect(reason(withInput({ dtype: "uint8", std: [1, 1, 1] }))).toBe("input.std is not allowed with dtype uint8");
    expect(reason(withInput({ dtype: "uint8", std: [1, 1, 1], scale: 2 }))).toBe("input.scale is not allowed with dtype uint8");
  });
  it("19 output not an object", () => {
    for (const v of [1, null, [], "s"]) expect(reason(withOutput(v))).toBe("output must be an object");
  });
  it("20 exactly one of type and format", () => {
    const msg = 'output must have exactly one of "type" and "format"';
    expect(reason(withOutput({}))).toBe(msg);
    expect(reason(withOutput({ type: "logits", format: "ssd" }))).toBe(msg);
  });
  it("21 and 22 type and format values", () => {
    expect(reason(withOutput({ type: "softmax" }))).toBe('output.type must be "logits" or "probabilities"');
    expect(reason(withOutput({ format: "yolo" }))).toBe('output.format must be "ssd" or "rows"');
    expect(reason(withOutput({ format: null }))).toBe('output.format must be "ssd" or "rows"');
  });
  it("23 unknown output keys by kind", () => {
    expect(reason(withOutput({ type: "logits", boxOrder: "yxyx" }))).toBe("unknown key: output.boxOrder");
    expect(reason(withOutput({ format: "ssd", transposed: true }))).toBe("unknown key: output.transposed");
    expect(reason(withOutput({ format: "ssd", boxFormat: "xywh" }))).toBe("unknown key: output.boxFormat");
    expect(reason(withOutput({ format: "rows", coordinates: "pixels" }))).toBe("unknown key: output.coordinates");
    expect(reason(withOutput({ format: "rows", boxOrder: "yxyx" }))).toBe("unknown key: output.boxOrder");
  });
  it("24-28 detector values", () => {
    expect(reason(withOutput({ format: "ssd", boxOrder: "xy" }))).toBe('output.boxOrder must be "yxyx" or "xyxy"');
    expect(reason(withOutput({ format: "ssd", boxOrder: null }))).toBe('output.boxOrder must be "yxyx" or "xyxy"');
    expect(reason(withOutput({ format: "ssd", coordinates: "abs" }))).toBe('output.coordinates must be "normalized" or "pixels"');
    expect(reason(withOutput({ format: "rows", boxFormat: "cwh" }))).toBe('output.boxFormat must be "xywh" or "xyxy"');
    expect(reason(withOutput({ format: "rows", transposed: 1 }))).toBe("output.transposed must be a boolean");
    expect(reason(withOutput({ format: "rows", transposed: null }))).toBe("output.transposed must be a boolean");
    expect(reason(withOutput({ format: "rows", objectness: "yes" }))).toBe("output.objectness must be a boolean");
    expect(reason(withOutput({ format: "rows", scoreActivation: "softmax" }))).toBe('output.scoreActivation must be "none" or "sigmoid"');
  });
  it("29 labels", () => {
    for (const v of [null, "a", [1], [null], {}]) expect(reason({ ...classifier(), labels: v })).toBe("labels must be an array of strings");
  });
  it("30 labelOffset", () => {
    const msg = "labelOffset must be an integer from -1000000 to 1000000";
    for (const v of [null, 1.5, "1", 1000001, -1000001]) expect(reason({ ...classifier(), labelOffset: v })).toBe(msg);
  });
  it("the first violated rule wins", () => {
    expect(reason({ output: {}, extra: 1 })).toBe("unknown key: extra");
    expect(reason(withInput({ width: 0, height: 0, layout: "x" }))).toBe("input.width must be an integer from 1 to 16384");
    expect(reason(withInput({ padValue: 1.5, scale: "x" }))).toBe("input.padValue must be an integer from 0 to 255");
    expect(reason(withInput({ dtype: "bad", padValue: 1.5 }))).toBe('input.dtype must be "float" or "uint8"');
    expect(reason({ ...classifier(), labels: 1, labelOffset: 1.5 })).toBe("labels must be an array of strings");
  });
});

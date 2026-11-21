import { describe, expect, it } from "vitest";
import { VisionError } from "./errors.js";
import type { Image } from "./image.js";
import { classify, detect, scriptedModel, type Clock, type VisionModel } from "./pipeline.js";
import { parseModelSpec } from "./spec.js";
import type { Tensor } from "./tensor.js";

const image: Image = { width: 1, height: 1, data: Uint8Array.from([7, 8, 9]) };
const input = { width: 1, height: 1, layout: "nhwc", channels: "rgb", mode: "stretch", resample: "nearest", dtype: "float" };
const clsSpec = parseModelSpec({ input, output: { type: "probabilities" } });
const detSpec = parseModelSpec({ input, output: { format: "ssd", boxOrder: "xyxy", coordinates: "pixels" }, labels: ["a"] });
const out1: Record<string, Tensor> = { output: { shape: [2], data: [0.25, 0.75] } };
const detOut: Record<string, Tensor> = {
  boxes: { shape: [1, 1, 4], data: [0, 0, 1, 1] },
  classes: { shape: [1, 1], data: [0] },
  scores: { shape: [1, 1], data: [0.9] },
};

function scripted(times: number[]): Clock & { reads: number } {
  const c = {
    reads: 0,
    nowMs() {
      if (c.reads >= times.length) throw new Error("too many clock reads");
      return times[c.reads++]!;
    },
  };
  return c;
}

/** A model that records the clock reads at the time of each call. */
function recording(model: VisionModel, clock: { reads: number }): VisionModel & { atRun: number[] } {
  const r = {
    atRun: [] as number[],
    async run(t: Tensor) {
      r.atRun.push(clock.reads);
      return model.run(t);
    },
  };
  return r;
}

async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a failure");
}

describe("scriptedModel", () => {
  it("ignores the input values, records every call, returns the same map each time", async () => {
    const model = scriptedModel(out1);
    const a: Tensor = { shape: [1], data: [1] };
    const b: Tensor = { shape: [1], data: [2] };
    expect(await model.run(a)).toBe(out1);
    expect(await model.run(b)).toBe(out1);
    expect(model.calls).toEqual([a, b]);
  });
});

describe("classify", () => {
  it("runs once, reads the clock four times in order and reports the differences", async () => {
    const clock = scripted([5, 7, 20, 20.5]);
    const model = recording(scriptedModel(out1), clock);
    const r = await classify(model, image, clsSpec, { clock });
    expect(r.entries).toEqual([
      { index: 1, label: "#1", score: 0.75 },
      { index: 0, label: "#0", score: 0.25 },
    ]);
    expect(r.timing).toEqual({ preprocessMs: 2, inferenceMs: 13, postprocessMs: 0.5 });
    expect(clock.reads).toBe(4);
    expect(model.atRun).toEqual([2]);
  });

  it("the model receives the input tensor of toTensor", async () => {
    const clock = scripted([0, 1, 2, 3]);
    const model = scriptedModel(out1);
    await classify(model, image, clsSpec, { clock });
    expect(model.calls).toEqual([{ shape: [1, 1, 1, 3], data: [7, 8, 9] }]);
  });

  it("timings are plain differences, negative ones included", async () => {
    const r = await classify(scriptedModel(out1), image, clsSpec, { clock: scripted([10, 8, 20, 21]) });
    expect(r.timing.preprocessMs).toBe(-2);
  });

  it("accepts a [1, C] output and passes topK and minScore on", async () => {
    const o = { output: { shape: [1, 3], data: [0.2, 0.5, 0.3] } };
    const r = await classify(scriptedModel(o), image, clsSpec, { topK: 2, minScore: 0.4 });
    expect(r.entries.map((e) => e.index)).toEqual([1]);
  });

  it("validation failures read the clock zero times and never call the model", async () => {
    const clock = scripted([0, 1, 2, 3]);
    const model = scriptedModel(out1);
    const bad: Array<[Image, unknown, Record<string, unknown>]> = [
      [{ width: 1, height: 1, data: new Uint8Array(2) }, clsSpec, {}],
      [image, detSpec, {}],
      [image, { input: {} }, {}],
      [image, clsSpec, { topK: null }],
      [image, clsSpec, { minScore: 2 }],
    ];
    for (const [img, spec, opts] of bad) {
      const e = await failure(classify(model, img, spec as never, { ...opts, clock }));
      expect(e).toBeInstanceOf(VisionError);
    }
    expect(clock.reads).toBe(0);
    expect(model.calls).toHaveLength(0);
    expect(((await failure(classify(model, image, detSpec, { clock }))) as VisionError).kind).toBe("invalid_options");
    expect(((await failure(classify(model, image, { input: {} } as never, { clock }))) as VisionError).kind).toBe("invalid_spec");
  });

  it("a model error propagates unchanged after exactly two clock reads", async () => {
    const boom = new Error("boom");
    const clock = scripted([0, 1, 2, 3]);
    const model: VisionModel = { run: async () => Promise.reject(boom) };
    expect(await failure(classify(model, image, clsSpec, { clock }))).toBe(boom);
    expect(clock.reads).toBe(2);
    const sync: VisionModel = {
      run: () => {
        throw boom;
      },
    };
    const clock2 = scripted([0, 1, 2, 3]);
    expect(await failure(classify(sync, image, clsSpec, { clock: clock2 }))).toBe(boom);
    expect(clock2.reads).toBe(2);
  });

  it("an Error subclass thrown by the clock propagates as well", async () => {
    class Custom extends Error {}
    const e = new Custom("clock");
    const clock: Clock = {
      nowMs() {
        throw e;
      },
    };
    expect(await failure(classify(scriptedModel(out1), image, clsSpec, { clock }))).toBe(e);
  });

  it("malformed outputs are invalid_output after exactly three clock reads", async () => {
    const bads: Array<Record<string, Tensor> | null> = [
      {},
      { output: { shape: [2], data: [1] } },
      { output: { shape: [2, 2], data: [1, 2, 3, 4] } },
      { output: { shape: [0], data: [] } },
      { output: { shape: [2], data: [0.5, NaN] } },
      { output: { shape: [-1], data: [] } },
      { output: { shape: [1, 0], data: [] } },
      null,
    ];
    for (const bad of bads) {
      const clock = scripted([0, 1, 2, 3]);
      const e = await failure(classify(scriptedModel(bad as never), image, clsSpec, { clock }));
      expect((e as VisionError).kind).toBe("invalid_output");
      expect(clock.reads).toBe(3);
    }
  });

  it("works with the real default clock", async () => {
    const r = await classify(scriptedModel(out1), image, clsSpec);
    expect(r.timing.inferenceMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(r.timing.preprocessMs)).toBe(true);
  });

  it("does not mutate the image or the spec", async () => {
    const copy = Array.from(image.data);
    const before = JSON.stringify(clsSpec);
    await classify(scriptedModel(out1), image, clsSpec);
    expect(Array.from(image.data)).toEqual(copy);
    expect(JSON.stringify(clsSpec)).toBe(before);
  });
});

describe("detect", () => {
  it("returns detections, timing and the geometry after four clock reads", async () => {
    const clock = scripted([0, 1, 3, 3.5]);
    const model = recording(scriptedModel(detOut), clock);
    const r = await detect(model, image, detSpec, { clock });
    expect(r.detections).toEqual([{ box: { x1: 0, y1: 0, x2: 1, y2: 1 }, classIndex: 0, label: "a", score: 0.9 }]);
    expect(r.timing).toEqual({ preprocessMs: 1, inferenceMs: 2, postprocessMs: 0.5 });
    expect(r.geometry).toEqual({ scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0, newWidth: 1, newHeight: 1 });
    expect(clock.reads).toBe(4);
    expect(model.atRun).toEqual([2]);
  });

  it("validates every option before the first clock read", async () => {
    for (const opts of [{ scoreThreshold: null }, { iouThreshold: -1 }, { maxDetections: 0 }, { nms: null }, { scoreThreshold: 1.5 }]) {
      const clock = scripted([0, 1, 2, 3]);
      const model = scriptedModel(detOut);
      expect(((await failure(detect(model, image, detSpec, { ...opts, clock } as never))) as VisionError).kind).toBe("invalid_options");
      expect(clock.reads).toBe(0);
      expect(model.calls).toHaveLength(0);
    }
    const clock = scripted([0, 1, 2, 3]);
    expect(((await failure(detect(scriptedModel(detOut), image, clsSpec, { clock }))) as VisionError).kind).toBe("invalid_options");
    expect(clock.reads).toBe(0);
  });

  it("an invalid detector output is invalid_output after three reads; a model error stays raw", async () => {
    const clock = scripted([0, 1, 2, 3]);
    const e = await failure(detect(scriptedModel({ boxes: detOut["boxes"]! }), image, detSpec, { clock }));
    expect((e as VisionError).kind).toBe("invalid_output");
    expect(clock.reads).toBe(3);
    const boom = new TypeError("boom");
    const clock2 = scripted([0, 1, 2, 3]);
    expect(await failure(detect({ run: async () => Promise.reject(boom) }, image, detSpec, { clock: clock2 }))).toBe(boom);
    expect(clock2.reads).toBe(2);
  });

  it("an empty result still costs one model call and four reads", async () => {
    const empty = { boxes: { shape: [1, 0, 4], data: [] }, classes: { shape: [1, 0], data: [] }, scores: { shape: [1, 0], data: [] } };
    const clock = scripted([0, 1, 2, 3]);
    const model = scriptedModel(empty);
    const r = await detect(model, image, detSpec, { clock });
    expect(r.detections).toEqual([]);
    expect(model.calls).toHaveLength(1);
    expect(clock.reads).toBe(4);
  });
});

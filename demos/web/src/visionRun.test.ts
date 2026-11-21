import { postprocessClassification, toTensor, type Image, type ModelSpec } from "@ilabs/vision";
import { vi } from "vitest";
import { recordingKey, visionAssets } from "./visionAssets";
import { modelAvailable, modelUrl, modelsBase, ortModel, resetAvailability, setRuntimeLoader, type OrtRuntime } from "./visionBackends/ort";
import { scriptedFor } from "./visionBackends/scripted";
import { decodeClassification, decodeDetections, fieldNumber, formatBox, formatPercent, runModel, runSection, tensorToRgb } from "./visionRun";

const classCard = visionAssets.cards.classification!;
const detectCard = visionAssets.cards.detection!;
const recording = (sample: string, task: "classification" | "detection") => visionAssets.recordings.get(recordingKey(sample, task))!;

function gradient(width: number, height: number): Image {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7 + 13) % 256;
  return { width, height, data };
}

afterEach(() => {
  setRuntimeLoader(null);
  resetAvailability();
  vi.unstubAllGlobals();
});

describe("tensorToRgb", () => {
  it("undoes the normalization of an identity-sized input to within one level", () => {
    // 224 x 224 into a 224 x 224 centre-crop model: the canvas is the image, so the inverse must give it back.
    const image = gradient(224, 224);
    const { tensor } = toTensor(image, classCard.spec);
    const rgb = tensorToRgb(tensor, classCard.spec);
    expect(rgb).toHaveLength(image.data.length);
    let worst = 0;
    for (let i = 0; i < rgb.length; i++) worst = Math.max(worst, Math.abs(rgb[i]! - image.data[i]!));
    expect(worst).toBeLessThanOrEqual(1);
  });

  it("returns uint8 nhwc input as it is and swaps bgr back to rgb", () => {
    const spec: ModelSpec = {
      input: { width: 2, height: 1, layout: "nhwc", channels: "bgr", mode: "stretch", resample: "nearest", dtype: "uint8" },
      output: { type: "logits" },
    };
    const image: Image = { width: 2, height: 1, data: new Uint8Array([1, 2, 3, 4, 5, 6]) };
    const { tensor } = toTensor(image, spec);
    expect(tensor.data).toEqual([3, 2, 1, 6, 5, 4]);
    expect([...tensorToRgb(tensor, spec)]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("returns the detector input of a stretch model as the stretched image", () => {
    const image = gradient(300, 300);
    const { tensor } = toTensor(image, detectCard.spec);
    expect([...tensorToRgb(tensor, detectCard.spec)]).toEqual([...image.data]);
  });
});

describe("runModel", () => {
  it("calls the model exactly once and keeps the input, the outputs and the geometry", async () => {
    const image = gradient(640, 427);
    const model = scriptedFor(classCard, recording("cat", "classification"));
    const run = vi.spyOn(model, "run");
    const raw = await runModel("classification", "recorded", model, image, classCard.spec);
    expect(run).toHaveBeenCalledTimes(1);
    expect(raw.calls).toBe(1);
    expect(raw.input.shape).toEqual([1, 3, 224, 224]);
    expect(raw.outputs["output"]?.shape).toEqual([1, 1000]);
    expect(raw.geometry.newHeight).toBe(224);
    expect(raw.source).toEqual({ width: 640, height: 427 });
    expect(raw.inferenceMs).toBeGreaterThanOrEqual(0);
  });

  it("decodes the same raw output again with other options and never calls the model", async () => {
    const model = scriptedFor(classCard, recording("cat", "classification"));
    const run = vi.spyOn(model, "run");
    const raw = await runModel("classification", "recorded", model, gradient(640, 427), classCard.spec);
    const three = decodeClassification(raw, 3);
    const one = decodeClassification(raw, 1);
    expect(three.ok && three.value).toHaveLength(3);
    expect(one.ok && one.value).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
    const vector = recording("cat", "classification").outputs["output"]!.data;
    expect(three.ok && three.value).toEqual(postprocessClassification(vector, classCard.spec, { topK: 3 }));
  });

  it("reports an invalid option as the library's own error and never as a run failure", async () => {
    const raw = await runModel("classification", "recorded", scriptedFor(classCard, recording("cat", "classification")), gradient(64, 64), classCard.spec);
    const bad = decodeClassification(raw, Number.NaN);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.kind).toBe("invalid_options");
      expect(bad.error.detail).toContain("topK");
    }
    const det = await runModel("detection", "recorded", scriptedFor(detectCard, recording("cat", "detection")), gradient(640, 427), detectCard.spec);
    const worse = decodeDetections(det, { scoreThreshold: 2, iouThreshold: 0.5, maxDetections: 100, nms: false });
    expect(worse.ok).toBe(false);
    const fine = decodeDetections(det, { scoreThreshold: 0.3, iouThreshold: 0.5, maxDetections: 100, nms: false });
    expect(fine.ok && fine.value.length).toBeGreaterThan(0);
  });
});

describe("runSection", () => {
  const image = gradient(640, 427);
  const base = { task: "classification" as const, card: classCard, recording: recording("cat", "classification"), image, effective: "recorded" as const, isUser: false };

  it("runs the recorded backend", async () => {
    const r = await runSection(base);
    expect(r.kind).toBe("ready");
    if (r.kind === "ready") expect(r.raw.backend).toBe("recorded");
  });

  it("falls back to the recording when the real model is missing, and says so", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    const r = await runSection({ ...base, effective: "ort" });
    expect(r.kind === "ready" && r.fellBack).toBe(true);
    expect(r.kind === "ready" && r.raw.backend).toBe("recorded");
  });

  it("has no results for a picked image when the real model is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    expect((await runSection({ ...base, effective: "ort", isUser: true, recording: undefined })).kind).toBe("unavailable");
  });

  it("reports a missing recording and a missing card", async () => {
    expect((await runSection({ ...base, recording: undefined })).kind).toBe("no-recording");
    expect((await runSection({ ...base, card: undefined })).kind).toBe("no-card");
  });
});

describe("modelAvailable", () => {
  const answer = (status: number, type?: string) => vi.fn(async () => new Response(null, { status, headers: type ? { "content-type": type } : {} }));

  it("is true for a file, false for a 404, for an HTML fallback page and for a network error", async () => {
    expect(await modelAvailable("/a", answer(200, "application/octet-stream"))).toBe(true);
    expect(await modelAvailable("/b", answer(404))).toBe(false);
    expect(await modelAvailable("/c", answer(200, "text/html; charset=utf-8"))).toBe(false);
    expect(await modelAvailable("/d", vi.fn(async () => Promise.reject(new TypeError("offline"))))).toBe(false);
  });

  it("asks once per URL", async () => {
    const f = answer(200, "application/octet-stream");
    await modelAvailable("/once", f);
    await modelAvailable("/once", f);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledWith("/once", { method: "HEAD" });
  });

  it("serves the models from the app base unless configured", () => {
    expect(modelsBase()).toMatch(/\/vision-models\/$/);
    expect(modelUrl(classCard)).toBe(`${modelsBase()}mobilenetv2-12.onnx`);
  });
});

describe("ortModel", () => {
  /** A stand-in runtime: records what it was given and answers like the real ONNX models do. */
  function stubRuntime(answer: Record<string, { dims: number[]; data: number[] }>) {
    const created: string[] = [];
    const fed: { name: string; type: string; dims: number[]; data: ArrayLike<number> }[] = [];
    class FakeTensor {
      constructor(
        readonly type: "float32" | "uint8",
        readonly data: Float32Array | Uint8Array,
        readonly dims: number[],
      ) {}
    }
    const runtime: OrtRuntime = {
      InferenceSession: {
        async create(source) {
          created.push(source);
          return {
            async run(feeds) {
              for (const [name, t] of Object.entries(feeds)) {
                const ft = t as FakeTensor;
                fed.push({ name, type: ft.type, dims: ft.dims, data: ft.data });
              }
              return answer;
            },
          };
        },
      },
      Tensor: FakeTensor as unknown as OrtRuntime["Tensor"],
    };
    return { runtime, created, fed };
  }

  it("feeds a float32 tensor to the classifier and names its output for the library", async () => {
    const logits = Array.from({ length: 1000 }, (_, i) => (i === 281 ? 9 : 0));
    const { runtime, created, fed } = stubRuntime({ output: { dims: [1, 1000], data: logits } });
    const loader = vi.fn(async () => runtime);
    setRuntimeLoader(loader);
    const model = await ortModel(classCard, "/vision-models/mobilenetv2-12.onnx");
    const raw = await runModel("classification", "ort", model, gradient(300, 200), classCard.spec);
    expect(created).toEqual(["/vision-models/mobilenetv2-12.onnx"]);
    expect(fed).toHaveLength(1);
    expect(fed[0]).toMatchObject({ name: "input", type: "float32", dims: [1, 3, 224, 224] });
    expect(fed[0]!.data).toBeInstanceOf(Float32Array);
    const top = decodeClassification(raw, 1);
    expect(top.ok && top.value[0]?.label).toBe("tabby");
    // one runtime load and one session, however often it is asked for
    await ortModel(classCard, "/vision-models/mobilenetv2-12.onnx");
    expect(loader).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
  });

  it("feeds a uint8 tensor to the detector and maps the four output tensors", async () => {
    const { runtime, fed } = stubRuntime({
      detection_boxes: { dims: [1, 1, 4], data: [0.1, 0.2, 0.5, 0.6] },
      detection_classes: { dims: [1, 1], data: [17] },
      detection_scores: { dims: [1, 1], data: [0.9] },
      num_detections: { dims: [1], data: [1] },
      extra: { dims: [1], data: [0] },
    });
    setRuntimeLoader(async () => runtime);
    const model = await ortModel(detectCard, "/m/ssd.onnx");
    const raw = await runModel("detection", "ort", model, gradient(300, 300), detectCard.spec);
    expect(fed[0]).toMatchObject({ name: "inputs", type: "uint8", dims: [1, 300, 300, 3] });
    expect(fed[0]!.data).toBeInstanceOf(Uint8Array);
    expect(Object.keys(raw.outputs).sort()).toEqual(["boxes", "classes", "count", "scores"]);
    const d = decodeDetections(raw, { scoreThreshold: 0.3, iouThreshold: 0.5, maxDetections: 100, nms: false });
    expect(d.ok && d.value).toHaveLength(1);
    expect(d.ok && d.value[0]?.label).toBe("cat");
    expect(d.ok && formatBox(d.value[0]!)).toBe("60,30,180,150");
  });

  it("does not cache a failed session", async () => {
    let attempts = 0;
    setRuntimeLoader(async () => {
      attempts++;
      if (attempts === 1) throw new Error("no wasm");
      return stubRuntime({}).runtime;
    });
    await expect(ortModel(classCard, "/x.onnx")).rejects.toThrow("no wasm");
    await expect(ortModel(classCard, "/x.onnx")).resolves.toBeDefined();
  });
});

describe("formatting", () => {
  it("writes percentages, boxes and typed numbers", () => {
    expect(formatPercent(0.8749, 0)).toBe("87%");
    expect(formatPercent(0.6463, 1)).toBe("64.6%");
    expect(fieldNumber("")).toBeNaN();
    expect(fieldNumber("  ")).toBeNaN();
    expect(fieldNumber("0.05")).toBe(0.05);
    expect(fieldNumber("abc")).toBeNaN();
  });
});

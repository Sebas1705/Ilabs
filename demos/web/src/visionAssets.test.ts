import { parseVisionAssets, recordingKey, visionAssets, decoderOutputs, parseLabels, type RawAssets } from "./visionAssets";
import samplesDoc from "../../vision-assets/samples.json";

const imageModules = import.meta.glob("../../vision-assets/samples/*.png", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
const recordedModules = import.meta.glob("../../vision-assets/recorded/*.json", { eager: true, query: "?raw", import: "default" }) as Record<string, string>;
const labelModules = import.meta.glob("../../vision-assets/labels/*.txt", { eager: true, query: "?raw", import: "default" }) as Record<string, string>;
const samplesRaw = (await import("../../vision-assets/samples.json?raw")).default as string;
const modelsRaw = (await import("../../vision-assets/models.json?raw")).default as string;

const rawAssets = (): RawAssets => ({ samples: samplesRaw, models: modelsRaw, recorded: { ...recordedModules }, labels: { ...labelModules }, images: { ...imageModules } });

describe("visionAssets", () => {
  it("loads every committed sample, card and recording without errors", () => {
    const n = samplesDoc.samples.length;
    expect(n).toBeGreaterThanOrEqual(7);
    expect(visionAssets.errors).toEqual([]);
    expect(visionAssets.samples).toHaveLength(n);
    expect(visionAssets.recordings.size).toBe(n * 2);
    for (const s of visionAssets.samples) {
      expect(visionAssets.recordings.has(recordingKey(s.id, "classification")), s.id).toBe(true);
      expect(visionAssets.recordings.has(recordingKey(s.id, "detection")), s.id).toBe(true);
      expect(s.title.es.length).toBeGreaterThan(0);
      expect(s.title.en.length).toBeGreaterThan(0);
    }
  });

  it("attaches the labels to the cards of the web models", () => {
    expect(visionAssets.cards.classification?.spec.labels).toHaveLength(1000);
    expect(visionAssets.cards.detection?.spec.labels).toHaveLength(90);
    expect(visionAssets.cards.classification?.id).toBe("mobilenet-v2-onnx");
    expect(visionAssets.cards.detection?.id).toBe("ssd-mobilenet-v1-onnx");
  });

  it("maps recorded tensors to the decoder names, and offers the classifier vector as output", () => {
    const { cards, recordings } = visionAssets;
    const cls = decoderOutputs(cards.classification!, recordings.get(recordingKey("cat", "classification"))!.outputs);
    expect(Object.keys(cls).sort()).toEqual(["output", "scores"]);
    const det = decoderOutputs(cards.detection!, recordings.get(recordingKey("cat", "detection"))!.outputs);
    expect(Object.keys(det).sort()).toEqual(["boxes", "classes", "count", "scores"]);
  });

  it("parses labels one per line and ignores the final line break", () => {
    expect(parseLabels("a\r\nb\r\n")).toEqual(["a", "b"]);
    expect(parseLabels("a\nb")).toEqual(["a", "b"]);
    expect(parseLabels("???\n???\n")).toEqual(["???", "???"]);
  });

  it("keeps the valid entries when a file is broken", () => {
    const raw = rawAssets();
    const names = Object.keys(raw.recorded);
    raw.recorded[names[0]!] = "{ not json";
    const lone = names.find((n) => n.includes("dog.classification"))!;
    raw.recorded[lone] = JSON.stringify({ ...JSON.parse(recordedModules[lone]!), model: "some-other-model" });
    const broken = names.find((n) => n.includes("dog.detection"))!;
    const doc = JSON.parse(recordedModules[broken]!);
    doc.outputs.detection_scores.data = [1];
    raw.recorded[broken] = JSON.stringify(doc);
    const result = parseVisionAssets(raw);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
    expect(result.errors.some((e) => e.includes("not valid JSON"))).toBe(true);
    expect(result.errors.some((e) => e.includes("some-other-model"))).toBe(true);
    expect(result.errors.some((e) => e.includes("does not match its shape"))).toBe(true);
    expect(result.samples).toHaveLength(visionAssets.samples.length);
    expect(result.recordings.size).toBe(visionAssets.recordings.size - 3);
    expect(result.cards.classification).toBeDefined();
  });

  it("drops a sample whose image is missing and a card whose labels are missing", () => {
    const raw = rawAssets();
    delete raw.images[Object.keys(raw.images).find((p) => p.endsWith("/cat.png"))!];
    delete raw.labels[Object.keys(raw.labels).find((p) => p.endsWith("coco-90.txt"))!];
    const result = parseVisionAssets(raw);
    expect(result.samples.some((s) => s.id === "cat")).toBe(false);
    expect(result.samples.length).toBe(visionAssets.samples.length - 1);
    expect(result.cards.detection).toBeUndefined();
    expect(result.cards.classification).toBeDefined();
    expect(result.errors.some((e) => e.includes("cat"))).toBe(true);
    expect(result.errors.some((e) => e.includes("labels file"))).toBe(true);
  });

  it("is total on garbage", () => {
    const result = parseVisionAssets({ samples: "[", models: "{}", recorded: { "x/y.json": "1" }, labels: {}, images: {} });
    expect(result.samples).toEqual([]);
    expect(result.cards).toEqual({});
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

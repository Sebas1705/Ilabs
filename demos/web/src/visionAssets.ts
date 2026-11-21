import { parseModelSpec, type ModelSpec, type Tensor } from "@ilabs/vision";
import { isRecord } from "./fixtureLoader";
import modelsRaw from "../../vision-assets/models.json?raw";
import samplesRaw from "../../vision-assets/samples.json?raw";

// The shared assets of the vision demos, read as text and parsed per file so that one broken file costs one
// entry and never the page. Everything is bundled: the page needs no network for the recorded mode.
const imageModules = import.meta.glob("../../vision-assets/samples/*.png", { eager: true, query: "?url", import: "default" });
const recordedModules = import.meta.glob("../../vision-assets/recorded/*.json", { eager: true, query: "?raw", import: "default" });
const labelModules = import.meta.glob("../../vision-assets/labels/*.txt", { eager: true, query: "?raw", import: "default" });

export type Task = "classification" | "detection";

export interface SampleDef {
  id: string;
  title: { es: string; en: string };
  width: number;
  height: number;
  /** URL of the PNG file. */
  url: string;
}

/** The model card of an ONNX model: the spec (labels attached, validated) and the tensor names. */
export interface ModelCard {
  id: string;
  name: string;
  task: Task;
  file: string;
  spec: ModelSpec;
  io: { input: string; outputs: Record<string, string> };
}

/** The raw tensors a model returned for one sample, keyed by the model's own tensor names. */
export interface Recording {
  sample: string;
  task: Task;
  model: string;
  outputs: Record<string, Tensor>;
}

export interface VisionAssets {
  samples: SampleDef[];
  cards: Partial<Record<Task, ModelCard>>;
  recordings: Map<string, Recording>;
  errors: string[];
}

export interface RawAssets {
  samples: string;
  models: string;
  /** File path -> text. */
  recorded: Record<string, string>;
  labels: Record<string, string>;
  /** File path -> URL. */
  images: Record<string, string>;
}

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;
const isTask = (v: unknown): v is Task => v === "classification" || v === "detection";

/** The key of a recording in `VisionAssets.recordings`. */
export const recordingKey = (sample: string, task: Task): string => `${sample}:${task}`;

/** One label per line, in class-id order (CRLF checkouts are fine; the final line break does not add a label). */
export function parseLabels(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function parseJson(text: string, file: string, errors: string[]): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    errors.push(`${file}: not valid JSON`);
    return undefined;
  }
}

function parseSamples(raw: RawAssets, errors: string[]): SampleDef[] {
  const doc = parseJson(raw.samples, "samples.json", errors);
  const list = isRecord(doc) && Array.isArray(doc.samples) ? (doc.samples as unknown[]) : null;
  if (list === null) {
    if (doc !== undefined) errors.push("samples.json: no samples list");
    return [];
  }
  const byName = new Map(Object.entries(raw.images).map(([path, url]) => [baseName(path), url]));
  const out: SampleDef[] = [];
  for (const [i, s] of list.entries()) {
    const id = isRecord(s) && typeof s.id === "string" ? s.id : `#${i}`;
    if (!isRecord(s) || typeof s.id !== "string" || typeof s.file !== "string") {
      errors.push(`samples.json: sample ${id} has no id or file`);
      continue;
    }
    const title = s.title;
    if (!isRecord(title) || typeof title.es !== "string" || typeof title.en !== "string" || !isInt(s.width) || !isInt(s.height)) {
      errors.push(`samples.json: sample ${id} has an invalid title or size`);
      continue;
    }
    const url = byName.get(s.file);
    if (url === undefined) {
      errors.push(`samples.json: sample ${id} has no image file ${s.file}`);
      continue;
    }
    out.push({ id: s.id, title: { es: title.es, en: title.en }, width: s.width, height: s.height, url });
  }
  return out;
}

function parseCards(raw: RawAssets, errors: string[]): Partial<Record<Task, ModelCard>> {
  const doc = parseJson(raw.models, "models.json", errors);
  const list = isRecord(doc) && Array.isArray(doc.models) ? (doc.models as unknown[]) : null;
  if (list === null) {
    if (doc !== undefined) errors.push("models.json: no models list");
    return {};
  }
  const labelsByName = new Map(Object.entries(raw.labels).map(([path, text]) => [baseName(path), text]));
  const cards: Partial<Record<Task, ModelCard>> = {};
  for (const c of list) {
    if (!isRecord(c) || c.runtime !== "onnx") continue;
    const id = typeof c.id === "string" ? c.id : "?";
    try {
      if (!isTask(c.task) || typeof c.file !== "string" || typeof c.name !== "string") throw new Error("missing task, name or file");
      const io = c.io;
      if (!isRecord(io) || typeof io.input !== "string" || !isRecord(io.outputs) || !Object.values(io.outputs).every((v) => typeof v === "string")) {
        throw new Error("invalid io");
      }
      const spec = structuredClone(c.spec) as Record<string, unknown>;
      if (typeof c.labels === "string") {
        const text = labelsByName.get(baseName(c.labels));
        if (text === undefined) throw new Error(`labels file ${c.labels} is missing`);
        spec.labels = parseLabels(text);
      }
      cards[c.task] = {
        id,
        name: c.name,
        task: c.task,
        file: c.file,
        spec: parseModelSpec(spec as unknown as ModelSpec),
        io: { input: io.input, outputs: io.outputs as Record<string, string> },
      };
    } catch (e) {
      errors.push(`models.json: model ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return cards;
}

function parseTensor(v: unknown): Tensor | null {
  if (!isRecord(v) || !Array.isArray(v.shape) || !Array.isArray(v.data)) return null;
  if (!v.shape.every((d) => typeof d === "number" && Number.isInteger(d) && d >= 0) || !v.data.every((x) => typeof x === "number")) return null;
  const size = (v.shape as number[]).reduce((a, b) => a * b, 1);
  return size === v.data.length ? { shape: v.shape as number[], data: v.data as number[] } : null;
}

function parseRecordings(raw: RawAssets, cards: Partial<Record<Task, ModelCard>>, errors: string[]): Map<string, Recording> {
  const out = new Map<string, Recording>();
  for (const [path, text] of Object.entries(raw.recorded)) {
    const file = baseName(path);
    const doc = parseJson(text, file, errors);
    if (doc === undefined) continue;
    if (!isRecord(doc) || typeof doc.sample !== "string" || !isTask(doc.task) || typeof doc.model !== "string" || !isRecord(doc.outputs)) {
      errors.push(`${file}: not a recorded output`);
      continue;
    }
    if (cards[doc.task]?.id !== doc.model) {
      errors.push(`${file}: recorded with ${doc.model}, which is not the card of the ${doc.task} model`);
      continue;
    }
    const outputs: Record<string, Tensor> = {};
    let ok = true;
    for (const [name, value] of Object.entries(doc.outputs)) {
      const tensor = parseTensor(value);
      if (tensor === null) ok = false;
      else outputs[name] = tensor;
    }
    if (!ok) {
      errors.push(`${file}: a tensor does not match its shape`);
      continue;
    }
    out.set(recordingKey(doc.sample, doc.task), { sample: doc.sample, task: doc.task, model: doc.model, outputs });
  }
  return out;
}

/** Pure and total: a file that cannot be read adds one entry to `errors` and the rest is kept. */
export function parseVisionAssets(raw: RawAssets): VisionAssets {
  const errors: string[] = [];
  const samples = parseSamples(raw, errors);
  const cards = parseCards(raw, errors);
  const recordings = parseRecordings(raw, cards, errors);
  return { samples, cards, recordings, errors };
}

/**
 * The tensors of a model under the names the library reads: the card's `io.outputs` maps decoder names (`boxes`,
 * `classes`, `scores`, `count`) to the model's own tensor names. The classification pipeline reads its vector from
 * the tensor named `output`, so the classifier's `scores` tensor is also offered under that name.
 */
export function decoderOutputs(card: ModelCard, byModelName: Record<string, Tensor>): Record<string, Tensor> {
  const out: Record<string, Tensor> = {};
  for (const [decoderName, rawName] of Object.entries(card.io.outputs)) {
    const tensor = byModelName[rawName];
    if (tensor !== undefined) out[decoderName] = tensor;
  }
  if (card.task === "classification" && out["scores"] !== undefined) out["output"] = out["scores"];
  return out;
}

export const visionAssets: VisionAssets = parseVisionAssets({
  samples: samplesRaw,
  models: modelsRaw,
  recorded: recordedModules as Record<string, string>,
  labels: labelModules as Record<string, string>,
  images: imageModules as Record<string, string>,
});

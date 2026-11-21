import type { Tensor, VisionModel } from "@ilabs/vision";
import { decoderOutputs, type ModelCard } from "../visionAssets";

/** The part of ONNX Runtime Web the adapter uses; a test can stand in for it. */
export interface OrtRuntime {
  InferenceSession: {
    create(source: string, options?: Record<string, unknown>): Promise<OrtSession>;
  };
  Tensor: new (type: "float32" | "uint8", data: Float32Array | Uint8Array, dims: number[]) => unknown;
}

export interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, { dims: readonly number[]; data: ArrayLike<number> }>>;
}

export type RuntimeLoader = () => Promise<OrtRuntime>;

const defaultLoader: RuntimeLoader = async () => (await import("./ortRuntime")).default as unknown as OrtRuntime;

let loader: RuntimeLoader = defaultLoader;
let runtime: Promise<OrtRuntime> | null = null;
const sessions = new Map<string, Promise<VisionModel>>();
const availability = new Map<string, Promise<boolean>>();

/** Replaces how the runtime is loaded (tests); `null` restores the real, lazy import. Forgets what was loaded. */
export function setRuntimeLoader(next: RuntimeLoader | null): void {
  loader = next ?? defaultLoader;
  runtime = null;
  sessions.clear();
}

/** Where the model files are served: `VITE_VISION_MODELS_BASE`, else `/vision-models/` under the app base. */
export function modelsBase(): string {
  const configured = import.meta.env.VITE_VISION_MODELS_BASE as string | undefined;
  const base = configured !== undefined && configured !== "" ? configured : `${import.meta.env.BASE_URL}vision-models/`;
  return base.endsWith("/") ? base : `${base}/`;
}

export const modelUrl = (card: ModelCard): string => `${modelsBase()}${card.file}`;

/**
 * True when the model file can be fetched. A host that answers every unknown path with its index page (a single page
 * app fallback) is not a file: an HTML answer counts as missing. Cached per URL.
 */
export function modelAvailable(url: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<boolean> {
  let p = availability.get(url);
  if (p === undefined) {
    p = (async () => {
      try {
        const r = await fetchImpl(url, { method: "HEAD" });
        return r.ok && !(r.headers.get("content-type") ?? "").toLowerCase().includes("text/html");
      } catch {
        return false;
      }
    })();
    availability.set(url, p);
  }
  return p;
}

/** Forgets what `modelAvailable` found (tests). */
export function resetAvailability(): void {
  availability.clear();
}

/** The ONNX model of a card as a `VisionModel`: the session is created once per file, on first use. */
export function ortModel(card: ModelCard, url: string = modelUrl(card)): Promise<VisionModel> {
  let p = sessions.get(url);
  if (p === undefined) {
    p = createModel(card, url);
    sessions.set(url, p);
    p.catch(() => sessions.delete(url));
  }
  return p;
}

async function createModel(card: ModelCard, url: string): Promise<VisionModel> {
  if (runtime === null) {
    const loading = loader();
    runtime = loading;
    // A failed load (offline, blocked) is not remembered: the next run tries again.
    loading.catch(() => {
      if (runtime === loading) runtime = null;
    });
  }
  const ort = await runtime;
  const session = await ort.InferenceSession.create(url, { executionProviders: ["wasm"] });
  const uint8 = card.spec.input.dtype === "uint8";
  return {
    async run(input: Tensor): Promise<Record<string, Tensor>> {
      const data = uint8 ? Uint8Array.from(input.data) : Float32Array.from(input.data);
      const feeds = { [card.io.input]: new ort.Tensor(uint8 ? "uint8" : "float32", data, input.shape) };
      const results = await session.run(feeds);
      const byModelName: Record<string, Tensor> = {};
      for (const [name, t] of Object.entries(results)) byModelName[name] = { shape: Array.from(t.dims), data: Array.from(t.data) };
      return decoderOutputs(card, byModelName);
    },
  };
}

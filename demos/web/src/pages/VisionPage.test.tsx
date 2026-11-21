import {
  parseModelSpec,
  postprocessClassification,
  postprocessDetections,
  preprocessGeometry,
  type Image,
  type ModelSpec,
  type Tensor,
} from "@ilabs/vision";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { vi } from "vitest";
import { App } from "../App";
import { LangContext, type Lang } from "../i18n";
import { visionAssets } from "../visionAssets";
import { resetAvailability, setRuntimeLoader, type OrtRuntime } from "../visionBackends/ort";
import { scriptedFor } from "../visionBackends/scripted";
import { decodeSample } from "../visionImage";
import { VisionPage } from "./VisionPage";
import modelsDoc from "../../../vision-assets/models.json";
import samplesDoc from "../../../vision-assets/samples.json";

vi.mock("../visionImage", async (importOriginal) => ({ ...(await importOriginal<typeof import("../visionImage")>()), decodeSample: vi.fn() }));
vi.mock("../visionBackends/scripted", async (importOriginal) => ({ ...(await importOriginal<typeof import("../visionBackends/scripted")>()), scriptedFor: vi.fn() }));

// The expectations below are built from the committed files and the library only, never from the page's own loader.
const labelFiles = import.meta.glob("../../../vision-assets/labels/*.txt", { eager: true, query: "?raw", import: "default" }) as Record<string, string>;
const recordedFiles = import.meta.glob("../../../vision-assets/recorded/*.json", { eager: true, query: "?raw", import: "default" }) as Record<string, string>;

function labelsOf(file: string): string[] {
  const text = Object.entries(labelFiles).find(([p]) => p.endsWith(`/${file.split("/").pop()}`))![1];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const onnx = modelsDoc.models.filter((m) => m.runtime === "onnx");
const classModel = onnx.find((m) => m.task === "classification")!;
const detectModel = onnx.find((m) => m.task === "detection")!;
const specOf = (m: (typeof onnx)[number]): ModelSpec => parseModelSpec({ ...(m.spec as unknown as ModelSpec), labels: labelsOf(m.labels) });
const classSpec = specOf(classModel);
const detectSpec = specOf(detectModel);
const sampleDoc = (id: string) => samplesDoc.samples.find((s) => s.id === id)!;
const recorded = (id: string, task: string): { outputs: Record<string, Tensor> } => {
  const entry = Object.entries(recordedFiles).find(([p]) => p.endsWith(`/${id}.${task}.json`));
  return JSON.parse(entry![1]);
};

/** What the library gives for the recording of a sample (the contract's own path, not the page's). */
function expected(id: string, opts: { topK?: number; scoreThreshold?: number; iouThreshold?: number; nms?: boolean; maxDetections?: number } = {}) {
  const s = sampleDoc(id);
  const cls = recorded(id, "classification").outputs[classModel.io.outputs.scores]!;
  const det = recorded(id, "detection").outputs;
  const names = detectModel.io.outputs as Record<string, string>;
  const entries = postprocessClassification(cls.data, classSpec, { topK: opts.topK ?? 5 });
  const mapped = {
    boxes: det[names.boxes!]!,
    classes: det[names.classes!]!,
    scores: det[names.scores!]!,
    count: det[names.count!]!,
  };
  const detections = postprocessDetections(mapped, detectSpec, preprocessGeometry(s.width, s.height, detectSpec), { width: s.width, height: s.height }, {
    scoreThreshold: opts.scoreThreshold ?? 0.3,
    iouThreshold: opts.iouThreshold ?? 0.5,
    nms: opts.nms ?? false,
    maxDetections: opts.maxDetections ?? 100,
  });
  return { entries, detections, geometry: { classify: preprocessGeometry(s.width, s.height, classSpec), detect: preprocessGeometry(s.width, s.height, detectSpec) } };
}

function gradient(width: number, height: number): Image {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < data.length; i++) data[i] = (i * 5 + 11) % 256;
  return { width, height, data };
}

let modelCalls: ReturnType<typeof vi.fn>[] = [];

beforeEach(async () => {
  window.location.hash = "";
  modelCalls = [];
  resetAvailability();
  setRuntimeLoader(null);
  vi.mocked(decodeSample).mockImplementation(async (url: string) => {
    const s = visionAssets.samples.find((x) => x.url === url)!;
    return gradient(s.width, s.height);
  });
  const actual = await vi.importActual<typeof import("../visionBackends/scripted")>("../visionBackends/scripted");
  vi.mocked(scriptedFor).mockImplementation((card, recording) => {
    const model = actual.scriptedFor(card, recording);
    const spy = vi.fn(model.run.bind(model));
    model.run = spy;
    modelCalls.push(spy);
    return model;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount(lang: Lang = "en") {
  return render(
    <LangContext.Provider value={lang}>
      <VisionPage />
    </LangContext.Provider>,
  );
}

const settled = () => waitFor(() => expect(screen.getByRole("main")).not.toHaveAttribute("aria-busy", "true"));
const classifyRegion = () => screen.getByRole("region", { name: /^(Classify|Clasificar)$/ });
const detectRegion = () => screen.getByRole("region", { name: /^(Detect|Detectar)$/ });
const classRows = () => within(classifyRegion()).getAllByRole("listitem").map((li) => li.textContent!);
const detectRows = () => within(within(detectRegion()).getByRole("list", { name: /^(Detections|Detecciones)$/ })).getAllByRole("listitem");
const sampleSelect = () => screen.getByLabelText(/^(Image|Imagen)$/) as HTMLSelectElement;
const pct = (v: number, d: number) => `${(v * 100).toFixed(d)}%`;
const box = (b: { x1: number; y1: number; x2: number; y2: number }) => [b.x1, b.y1, b.x2, b.y2].map(Math.round).join(",");

async function pick(id: string) {
  fireEvent.change(sampleSelect(), { target: { value: id } });
  await settled();
}

describe("VisionPage", () => {
  it("is reachable from the nav through the registry", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("link", { name: "Vision" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Vision (image models)" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Vision" })).toHaveAttribute("aria-current", "page");
    expect(window.location.hash).toBe("#/vision");
    expect(document.title).toBe("iLabs · Vision (image models)");
  });

  it("opens on the cat with the recorded backend and shows the recorded top label and probabilities as text", async () => {
    mount();
    await settled();
    const want = expected("cat");
    expect(want.entries[0]!.label).toBe("tabby");
    const rows = classRows();
    expect(rows).toHaveLength(5);
    want.entries.forEach((e, i) => {
      expect(rows[i]).toContain(e.label);
      expect(rows[i]).toContain(pct(e.score, 1));
    });
    expect(screen.getByRole("status")).toHaveTextContent(`Top: tabby ${pct(want.entries[0]!.score, 1)}`);
    expect(screen.getByRole("radio", { name: "Recorded" })).toBeChecked();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the boxes of a detect sample with class and score as text, over the image and in the list", async () => {
    mount();
    await pick("crowd");
    const want = expected("crowd");
    expect(want.detections.length).toBeGreaterThanOrEqual(10);
    expect(within(detectRegion()).getAllByTestId("vision-box")).toHaveLength(want.detections.length);
    const rows = detectRows();
    expect(rows).toHaveLength(want.detections.length);
    want.detections.forEach((d, i) => {
      expect(rows[i]).toHaveTextContent(d.label);
      expect(rows[i]).toHaveTextContent(pct(d.score, 1));
      expect(rows[i]).toHaveTextContent(box(d.box));
    });
    const chips = within(detectRegion()).getAllByTestId("vision-box").map((b) => b.textContent!);
    want.detections.forEach((d, i) => expect(chips[i]).toContain(`${d.label} ${pct(d.score, 0)}`));
    expect(screen.getByRole("status")).toHaveTextContent(`${want.detections.length} detections above 30%`);
    // the canvas has a text alternative that lists the detections
    expect(within(detectRegion()).getByRole("img", { name: /Street crowd|crowd/i })).toHaveAccessibleName(new RegExp(`${want.detections.length} detections: ${want.detections[0]!.label}`));
    // the legend names the classes as text
    expect(within(detectRegion()).getByRole("list", { name: "Classes in the image" })).toHaveTextContent("person");
  });

  it("moving the score threshold removes boxes and never calls the model again", async () => {
    mount();
    await pick("crowd");
    const runs = modelCalls.length;
    expect(runs).toBe(4); // the cat on opening, then the crowd: two sections each
    const callsAfterRun = () => modelCalls.map((c) => c.mock.calls.length);
    expect(callsAfterRun()).toEqual([1, 1, 1, 1]);
    const before = within(detectRegion()).getAllByTestId("vision-box").length;
    fireEvent.change(screen.getByLabelText("Score threshold (0 to 1)"), { target: { value: "0.9" } });
    const want = expected("crowd", { scoreThreshold: 0.9 });
    expect(want.detections.length).toBeLessThan(before);
    await waitFor(() => expect(within(detectRegion()).queryAllByTestId("vision-box")).toHaveLength(want.detections.length));
    expect(detectRows()).toHaveLength(want.detections.length);
    expect(callsAfterRun()).toEqual([1, 1, 1, 1]);
    fireEvent.change(screen.getByLabelText("Score threshold (0 to 1)"), { target: { value: "0.3" } });
    await waitFor(() => expect(within(detectRegion()).queryAllByTestId("vision-box")).toHaveLength(before));
    expect(callsAfterRun()).toEqual([1, 1, 1, 1]);
    expect(modelCalls).toHaveLength(runs);
  });

  it("re-decodes only for IoU, NMS, max detections and top K as well", async () => {
    mount();
    await pick("crowd");
    fireEvent.click(screen.getByRole("checkbox", { name: "Apply NMS" }));
    fireEvent.change(screen.getByLabelText("IoU threshold (0 to 1)"), { target: { value: "0.1" } });
    const nmsWant = expected("crowd", { nms: true, iouThreshold: 0.1 });
    await waitFor(() => expect(detectRows()).toHaveLength(nmsWant.detections.length));
    fireEvent.change(screen.getByLabelText("Max detections (1 to 100)"), { target: { value: "2" } });
    await waitFor(() => expect(detectRows()).toHaveLength(2));
    fireEvent.change(screen.getByLabelText("Top entries (1 to 10)"), { target: { value: "2" } });
    await waitFor(() => expect(classRows()).toHaveLength(2));
    fireEvent.change(screen.getByLabelText("Top entries (1 to 10)"), { target: { value: "10" } });
    await waitFor(() => expect(classRows()).toHaveLength(10));
    expect(modelCalls.map((c) => c.mock.calls.length)).toEqual([1, 1, 1, 1]);
  });

  it("shows the preprocessing geometry of the library as text for both models", async () => {
    mount();
    await pick("giraffe-tall");
    const f = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(4));
    const want = expected("giraffe-tall");
    const lists = screen.getAllByLabelText("Preprocessing geometry");
    expect(lists).toHaveLength(2);
    const [c, d] = [want.geometry.classify, want.geometry.detect];
    expect(lists[0]).toHaveTextContent(`${f(c.scaleX)}, ${f(c.scaleY)}`);
    expect(lists[0]).toHaveTextContent(`${f(c.offsetX)}, ${f(c.offsetY)}`);
    expect(lists[0]).toHaveTextContent(`${c.newWidth} × ${c.newHeight}`);
    expect(lists[0]).toHaveTextContent("centre crop");
    expect(lists[1]).toHaveTextContent(`${f(d.scaleX)}, ${f(d.scaleY)}`);
    expect(lists[1]).toHaveTextContent("stretch");
    const s = sampleDoc("giraffe-tall");
    expect(lists[1]).toHaveTextContent(`${s.width} × ${s.height}`);
    expect(screen.getByRole("img", { name: "The image as the model sees it: 224 by 224 pixels, centre crop" })).toBeInTheDocument();
  });

  it("shows the three timings, recorded mode writing 'recorded' instead of an inference time", async () => {
    mount();
    await settled();
    const timings = within(classifyRegion()).getByRole("region", { name: "Timings" });
    expect(timings).toHaveTextContent(/Preprocess\d+\.\d ms/);
    expect(timings).toHaveTextContent("Inferencerecorded");
    expect(timings).toHaveTextContent(/Postprocess\d+\.\d ms/);
  });

  it("renders every sample without an alert, with entries, a geometry and a status", async () => {
    mount();
    const options = within(sampleSelect()).getAllByRole("option").map((o) => (o as HTMLOptionElement).value);
    expect(options.length).toBe(samplesDoc.samples.length + 1);
    expect(options.length).toBeGreaterThanOrEqual(8);
    expect(options.at(-1)).toBe("user");
    for (const id of options.filter((o) => o !== "user")) {
      await pick(id);
      expect(screen.queryByRole("alert"), id).toBeNull();
      expect(classRows(), id).toHaveLength(5);
      expect(within(detectRegion()).getByLabelText("Preprocessing geometry"), id).toBeInTheDocument();
      expect(screen.getByRole("status").textContent, id).not.toBe("");
    }
  });

  it("live equals the library applied to the recording, for every sample", async () => {
    mount();
    for (const s of samplesDoc.samples) {
      await pick(s.id);
      const want = expected(s.id);
      const rows = classRows();
      want.entries.forEach((e, i) => {
        expect(rows[i], s.id).toContain(e.label);
        expect(rows[i], s.id).toContain(pct(e.score, 1));
      });
      const present = within(detectRegion()).queryAllByRole("listitem");
      if (want.detections.length === 0) {
        expect(within(detectRegion()).queryAllByTestId("vision-box"), s.id).toHaveLength(0);
        expect(detectRegion(), s.id).toHaveTextContent("No detections above the score threshold.");
      } else {
        const rows = detectRows();
        expect(rows, s.id).toHaveLength(want.detections.length);
        want.detections.forEach((d, i) => {
          expect(rows[i], s.id).toHaveTextContent(`${d.label}${pct(d.score, 1)}`);
          expect(rows[i], s.id).toHaveTextContent(box(d.box));
        });
      }
      expect(present.length).toBeGreaterThanOrEqual(0);
    }
  });

  it("calls the model once per section and run, and a new sample is a new run", async () => {
    mount();
    await settled();
    expect(modelCalls.map((c) => c.mock.calls.length)).toEqual([1, 1]);
    await pick("dog");
    expect(modelCalls.map((c) => c.mock.calls.length)).toEqual([1, 1, 1, 1]);
  });

  it("ignores a result that arrives after the person moved on", async () => {
    mount();
    await settled();
    let release!: (i: Image) => void;
    const slow = new Promise<Image>((r) => (release = r));
    const dog = visionAssets.samples.find((s) => s.id === "dog")!;
    const original = vi.mocked(decodeSample).getMockImplementation()!;
    vi.mocked(decodeSample).mockImplementation((url) => (url === dog.url ? slow : original(url)));
    fireEvent.change(sampleSelect(), { target: { value: "dog" } });
    await pick("mountains-wide");
    const mountains = expected("mountains-wide").entries[0]!.label;
    expect(classRows()[0]).toContain(mountains);
    await act(async () => {
      release(gradient(dog.width, dog.height));
      await slow;
    });
    expect(classRows()[0]).toContain(mountains);
    expect(classRows().join()).not.toContain("golden retriever");
    expect(sampleSelect().value).toBe("mountains-wide");
  });

  it("shows an assertive alert when the image cannot be read, and recovers on the next sample", async () => {
    mount();
    await settled();
    vi.mocked(decodeSample).mockRejectedValueOnce(new Error("decode boom"));
    fireEvent.change(sampleSelect(), { target: { value: "dog" } });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not run the model: decode boom");
    expect(screen.getByRole("status")).toHaveTextContent("The run failed.");
    await pick("cat");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the library's reason for an invalid control, keeps the other section and does not run the model", async () => {
    mount();
    await settled();
    fireEvent.change(screen.getByLabelText("Top entries (1 to 10)"), { target: { value: "0" } });
    const field = screen.getByLabelText("Top entries (1 to 10)");
    await waitFor(() => expect(field).toHaveAttribute("aria-invalid", "true"));
    expect(within(classifyRegion()).getByText("These settings are not valid.")).toBeInTheDocument();
    expect(within(classifyRegion()).getByText(/topK/)).toBeInTheDocument();
    expect(field).toHaveAccessibleDescription(/These settings are not valid/);
    expect(screen.getByRole("status")).toHaveTextContent("Check the highlighted settings.");
    expect(detectRows().length).toBeGreaterThanOrEqual(1);
    fireEvent.change(screen.getByLabelText("Score threshold (0 to 1)"), { target: { value: "2" } });
    await waitFor(() => expect(within(detectRegion()).getByText("These settings are not valid.")).toBeInTheDocument());
    expect(modelCalls.map((c) => c.mock.calls.length)).toEqual([1, 1]);
    fireEvent.change(screen.getByLabelText("Top entries (1 to 10)"), { target: { value: "5" } });
    await waitFor(() => expect(classRows()).toHaveLength(5));
  });

  it("links every Detect control to the error block that explains an invalid setting", async () => {
    mount();
    await settled();
    fireEvent.change(screen.getByLabelText("Score threshold (0 to 1)"), { target: { value: "2" } });
    await waitFor(() => expect(within(detectRegion()).getByText("These settings are not valid.")).toBeInTheDocument());
    for (const label of ["Score threshold (0 to 1)", "IoU threshold (0 to 1)", "Max detections (1 to 100)"]) {
      const input = screen.getByLabelText(label);
      expect(input, label).toHaveAttribute("aria-invalid", "true");
      expect(input, label).toHaveAccessibleDescription(/These settings are not valid/);
    }
    expect(screen.getByRole("checkbox", { name: "Apply NMS" })).toHaveAccessibleDescription(/These settings are not valid/);
    expect(document.getElementById("vision-detect-error")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Score threshold (0 to 1)"), { target: { value: "0.3" } });
    await waitFor(() => expect(screen.getByLabelText("Score threshold (0 to 1)")).not.toHaveAttribute("aria-describedby"));
  });

  it("makes exactly one model call per section when the page mounts in StrictMode", async () => {
    render(
      <StrictMode>
        <LangContext.Provider value="en">
          <VisionPage />
        </LangContext.Provider>
      </StrictMode>,
    );
    await settled();
    expect(classRows()).toHaveLength(5);
    expect(modelCalls.map((c) => c.mock.calls.length)).toEqual([1, 1]);
    await pick("dog");
    expect(modelCalls.map((c) => c.mock.calls.length)).toEqual([1, 1, 1, 1]);
  });

  it("renders in Spanish with the Spanish titles and status", async () => {
    mount("es");
    await settled();
    expect(screen.getByRole("heading", { level: 1, name: "Visión (modelos de imagen)" })).toBeInTheDocument();
    expect(within(sampleSelect()).getByRole("option", { name: sampleDoc("cat").title.es })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Clasificar" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Detectar" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/^Primero: tabby/);
    expect(screen.getByRole("radio", { name: "Grabado" })).toBeChecked();
    expect(within(classifyRegion()).getByRole("region", { name: "Tiempos" })).toHaveTextContent("grabado");
  });

  it("has named regions, labels bound to inputs and a polite status", async () => {
    mount();
    await settled();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Image and backend" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Classify" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Detect" })).toBeInTheDocument();
    for (const label of ["Top entries (1 to 10)", "Score threshold (0 to 1)", "IoU threshold (0 to 1)", "Max detections (1 to 100)"]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.getByRole("checkbox", { name: "Apply NMS" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Apply NMS" })).toHaveAccessibleDescription(/SSD models already apply it/);
    expect(screen.getByText(/these models are small and make mistakes/)).toBeInTheDocument();
    for (const bar of document.querySelectorAll(".classbar")) expect(bar).toHaveAttribute("aria-hidden", "true");
  });
});

describe("VisionPage real model", () => {
  const classLogits = Array.from({ length: 1000 }, (_, i) => (i === 207 ? 12 : i === 208 ? 9 : 0)); // golden retriever, Labrador retriever

  /** A stand-in for ONNX Runtime Web that answers like the two models and counts its calls. */
  function stubRuntime(detectionCount = 1) {
    const session = { feeds: [] as { name: string; dims: number[]; type: string }[] };
    class FakeTensor {
      constructor(
        readonly type: string,
        readonly data: ArrayLike<number>,
        readonly dims: number[],
      ) {}
    }
    const runtime: OrtRuntime = {
      InferenceSession: {
        async create(source) {
          const isClassifier = source.endsWith(".onnx") && source.includes("mobilenetv2");
          return {
            async run(feeds): Promise<Record<string, { dims: number[]; data: number[] }>> {
              for (const [name, t] of Object.entries(feeds)) session.feeds.push({ name, dims: (t as FakeTensor).dims, type: (t as FakeTensor).type });
              return isClassifier
                ? { output: { dims: [1, 1000], data: classLogits } }
                : {
                    detection_boxes: { dims: [1, detectionCount + 1, 4], data: [...Array.from({ length: detectionCount }, () => [0.1, 0.1, 0.9, 0.9]).flat(), 0, 0, 0, 0] },
                    detection_classes: { dims: [1, detectionCount + 1], data: [...Array.from({ length: detectionCount }, () => 18), 0] },
                    detection_scores: { dims: [1, detectionCount + 1], data: [...Array.from({ length: detectionCount }, () => 0.88), 0] },
                    num_detections: { dims: [1], data: [detectionCount] },
                  };
            },
          };
        },
      },
      Tensor: FakeTensor as unknown as OrtRuntime["Tensor"],
    };
    return { runtime, session };
  }

  const presentModels = () =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200, headers: { "content-type": "application/octet-stream" } })),
    );
  const missingModels = () => vi.stubGlobal("fetch", vi.fn(async () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } })));

  it("disables the real model with a translated note naming the download script when the files are missing", async () => {
    missingModels();
    mount();
    await settled();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Real model" })).toBeDisabled());
    expect(screen.getByRole("group", { name: "Backend" })).toHaveAccessibleDescription(/node scripts\/vision-models\.mjs --runtime onnx/);
    expect(screen.getByRole("radio", { name: "Recorded" })).toBeChecked();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("works through a stubbed runtime when the files are present, and shows an inference time", async () => {
    presentModels();
    const { runtime, session } = stubRuntime();
    const loader = vi.fn(async () => runtime);
    setRuntimeLoader(loader);
    mount();
    await settled();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Real model" })).toBeEnabled());
    expect(loader).not.toHaveBeenCalled(); // the recorded default never loads the runtime
    fireEvent.click(screen.getByRole("radio", { name: "Real model" }));
    await waitFor(() => expect(classRows()[0]).toContain("golden retriever"));
    expect(loader).toHaveBeenCalledTimes(1);
    const want = postprocessClassification(classLogits, classSpec, { topK: 5 });
    expect(classRows()[0]).toContain(pct(want[0]!.score, 1));
    await waitFor(() => expect(detectRows()).toHaveLength(1));
    expect(detectRows()[0]).toHaveTextContent("dog");
    expect(session.feeds.map((f) => `${f.name}:${f.type}:${f.dims.join("x")}`)).toEqual(["input:float32:1x3x224x224", "inputs:uint8:1x300x300x3"]);
    expect(within(classifyRegion()).getByRole("region", { name: "Timings" })).toHaveTextContent(/Inference\d+\.\d ms/);
    expect(modelCalls).toHaveLength(2); // only the two recorded runs of the opening: the real model used no recording
    // a control change decodes again; the stubbed model is not asked again
    fireEvent.change(screen.getByLabelText("Score threshold (0 to 1)"), { target: { value: "0.95" } });
    await waitFor(() => expect(within(detectRegion()).getByText("No detections above the score threshold.")).toBeInTheDocument());
    expect(session.feeds).toHaveLength(2);
  });

  it("converts a picked file through a canvas, runs the real model on it and caps nothing it need not", async () => {
    presentModels();
    const { runtime, session } = stubRuntime();
    setRuntimeLoader(async () => runtime);
    const drawn: string[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      fillStyle: "",
      fillRect: () => {},
      drawImage: (_b: unknown, _x: number, _y: number, w: number, h: number) => drawn.push(`${w}x${h}`),
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(200), width: w, height: h }),
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      putImageData: () => {},
    } as unknown as CanvasRenderingContext2D);
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 120, height: 80, close: () => {} })));
    mount();
    await settled();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Real model" })).toBeEnabled());
    fireEvent.change(sampleSelect(), { target: { value: "user" } });
    // no file yet: a note, no results, and the real model is the only backend
    expect(screen.getByRole("radio", { name: "Recorded" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Real model" })).toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent("Choose an image file to run the real model on it.");
    expect(screen.queryAllByTestId("vision-box")).toHaveLength(0);
    const file = new File([new Uint8Array([1, 2, 3])], "mine.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Image file"), { target: { files: [file] } });
    await waitFor(() => expect(classRows()[0]).toContain("golden retriever"));
    expect(drawn).toContain("120x80");
    expect(session.feeds).toHaveLength(2);
    await waitFor(() => expect(within(detectRegion()).getByLabelText("Preprocessing geometry")).toHaveTextContent("120 × 80"));
    expect(within(detectRegion()).getByRole("img", { name: /Your image: mine\.png/ })).toBeInTheDocument();
  });

  it("caps the list and the boxes at 100 and counts the rest in a translated note", async () => {
    presentModels();
    const { runtime } = stubRuntime(150);
    setRuntimeLoader(async () => runtime);
    mount();
    await settled();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Real model" })).toBeEnabled());
    fireEvent.click(screen.getByRole("radio", { name: "Real model" }));
    // the default maximum is 100: nothing to cap yet
    await waitFor(() => expect(detectRows()).toHaveLength(100));
    expect(within(detectRegion()).queryByText(/^\+\d+ more$/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Max detections (1 to 100)"), { target: { value: "150" } });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("150 detections above 30%"));
    expect(detectRows()).toHaveLength(100);
    expect(within(detectRegion()).getAllByTestId("vision-box")).toHaveLength(100);
    expect(within(detectRegion()).getByText("+50 more")).toBeInTheDocument();
    expect(within(detectRegion()).getByRole("img", { name: /150 detections/ })).toHaveAccessibleName(/\+130 more/);
  });

  it.each([
    ["en", "Real model unavailable.", /Your image needs the real model, which is unavailable/],
    ["es", "Modelo real no disponible.", /Tu imagen necesita el modelo real, que no está disponible/],
  ] as const)("replaces the results of a picked image with a note when the real model is unavailable (%s)", async (lang, short, note) => {
    missingModels();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      fillStyle: "",
      fillRect: () => {},
      drawImage: () => {},
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255), width: w, height: h }),
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      putImageData: () => {},
    } as unknown as CanvasRenderingContext2D);
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 10, height: 10, close: () => {} })));
    mount(lang);
    await settled();
    fireEvent.change(sampleSelect(), { target: { value: "user" } });
    fireEvent.change(document.getElementById("vision-file")!, { target: { files: [new File([new Uint8Array([1])], "x.png")] } });
    await waitFor(() => expect(within(classifyRegion()).getByText(note)).toBeInTheDocument());
    expect(within(detectRegion()).getByText(/node scripts\/vision-models\.mjs --runtime onnx/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(short);
    expect(screen.getByRole("status").textContent).not.toMatch(/[{}]/);
    expect(within(classifyRegion()).queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows an assertive alert when the real model fails to run", async () => {
    presentModels();
    setRuntimeLoader(async () => {
      throw new Error("wasm blocked");
    });
    mount();
    await settled();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Real model" })).toBeEnabled());
    fireEvent.click(screen.getByRole("radio", { name: "Real model" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not run the model: wasm blocked");
    // going back to the recording recovers
    fireEvent.click(screen.getByRole("radio", { name: "Recorded" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    await waitFor(() => expect(classRows()).toHaveLength(5));
  });
});

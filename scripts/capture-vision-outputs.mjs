#!/usr/bin/env node
// Captures the RAW outputs of the real ONNX models for every demo sample and writes them to
// demos/vision-assets/recorded/<sample>.<task>.json. A dev-time tool: it is run once (and again when the samples
// or the pinned models change), and its results are committed. The model files themselves never are.
//
// The preprocessing is the one the demos use: the PNG is decoded to RGB and goes through `toTensor` of
// `@ilabs/vision` with the `ModelSpec` of the model card in demos/vision-assets/models.json.
//
// Requirements (nothing of this is in the repository lockfile):
//   1. Node 24 or newer (built-in TypeScript type stripping loads modules/vision/ts/src directly).
//   2. The model files:      node scripts/vision-models.mjs --runtime onnx
//   3. onnxruntime-node, installed OUTSIDE the repository (the version used for the committed files is recorded
//      in every output file):
//        mkdir <scratch> && cd <scratch> && npm init -y && npm i onnxruntime-node@1.31.1
//   Run:
//        node --import ./scripts/lib/register-ts.mjs scripts/capture-vision-outputs.mjs --ort <scratch>
//   (`--ort` can be replaced by the environment variable ILABS_ORT_DIR; without either, `onnxruntime-node` is resolved
//   like any module from the repository.) Options: `--sample <id>` limits the run to one sample, `--print-only`
//   re-decodes the committed recorded files and prints the top-3 labels and the detections without running a model.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ASSETS, loadCards, specWithLabels } from "./lib/cards.mjs";
import { decodePng } from "./lib/png.mjs";
import { postprocessClassification, postprocessDetections, preprocessGeometry, toTensor } from "./lib/vision.mjs";

/** The shortest decimal string that reads back as the same float32 (`Math.fround`), as a number. */
export function shortFloat32(x) {
  if (!Number.isFinite(x) || x === 0) return x;
  for (let p = 1; p <= 9; p++) {
    const v = Number(x.toPrecision(p));
    if (Math.fround(v) === x) return v;
  }
  return x;
}

function parseArgs(argv) {
  const o = { ort: process.env.ILABS_ORT_DIR ?? null, sample: null, printOnly: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--ort") o.ort = argv[++i];
    else if (argv[i] === "--sample") o.sample = argv[++i];
    else if (argv[i] === "--print-only") o.printOnly = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return o;
}

function loadOrt(dir) {
  const req = createRequire(dir ? join(resolve(dir), "noop.js") : import.meta.url);
  const ort = req("onnxruntime-node");
  const version = req("onnxruntime-node/package.json").version;
  return { ort, version };
}

function fmtBox(b) {
  return `[${b.x1.toFixed(1)}, ${b.y1.toFixed(1)}, ${b.x2.toFixed(1)}, ${b.y2.toFixed(1)}]`;
}

/** Prints what the demos will show for a recorded file: top-3 labels or the detections (default options). */
export function describeRecorded(recorded, card, sample) {
  const spec = specWithLabels(card);
  if (card.task === "classification") {
    const out = recorded.outputs[card.io.outputs.scores];
    const top = postprocessClassification(out.data, spec, { topK: 3 });
    return `top-3: ${top.map((e) => `${e.label} (${e.index}) ${(e.score * 100).toFixed(1)}%`).join(" | ")}`;
  }
  const named = {};
  for (const [decoder, tensorName] of Object.entries(card.io.outputs)) named[decoder] = recorded.outputs[tensorName];
  const geometry = preprocessGeometry(sample.width, sample.height, spec);
  const dets = postprocessDetections(named, spec, geometry, sample);
  if (dets.length === 0) return "no detection above 0.3";
  return dets.map((d) => `${d.label} ${(d.score * 100).toFixed(0)}% ${fmtBox(d.box)}`).join("\n    ");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cards = loadCards().filter((c) => c.runtime === "onnx");
  const samples = JSON.parse(readFileSync(join(ASSETS, "samples.json"), "utf8")).samples.filter((s) => !opts.sample || s.id === opts.sample);
  if (samples.length === 0) throw new Error("no sample matches");
  const recordedDir = join(ASSETS, "recorded");
  mkdirSync(recordedDir, { recursive: true });
  const ort = opts.printOnly ? null : loadOrt(opts.ort);
  const sessions = new Map();

  for (const sample of samples) {
    const png = readFileSync(join(ASSETS, "samples", sample.file));
    const image = decodePng(png);
    if (image.width !== sample.width || image.height !== sample.height) throw new Error(`${sample.id}: samples.json size does not match the file`);
    console.log(`\n== ${sample.id} (${image.width}x${image.height})`);
    for (const card of cards) {
      const file = join(recordedDir, `${sample.id}.${card.task}.json`);
      let recorded;
      if (opts.printOnly) {
        recorded = JSON.parse(readFileSync(file, "utf8"));
      } else {
        const modelPath = join(ASSETS, "models", card.file);
        if (!existsSync(modelPath)) throw new Error(`${card.file} is missing: run node scripts/vision-models.mjs --runtime onnx`);
        const sha = createHash("sha256").update(readFileSync(modelPath)).digest("hex");
        if (sha !== card.sha256) throw new Error(`${card.file} does not match its pinned checksum`);
        if (!sessions.has(card.id)) sessions.set(card.id, await ort.ort.InferenceSession.create(modelPath));
        const session = sessions.get(card.id);
        const { tensor } = toTensor(image, specWithLabels(card));
        const dtype = card.spec.input.dtype === "uint8" ? "uint8" : "float32";
        const data = dtype === "uint8" ? Uint8Array.from(tensor.data) : Float32Array.from(tensor.data);
        const results = await session.run({ [card.io.input]: new ort.ort.Tensor(dtype, data, tensor.shape) });
        const outputs = {};
        for (const name of session.outputNames) {
          const t = results[name];
          outputs[name] = { shape: [...t.dims], data: Array.from(t.data, (v) => shortFloat32(v)) };
        }
        recorded = {
          sample: sample.id,
          task: card.task,
          model: card.id,
          modelSha256: card.sha256,
          runtime: `onnxruntime-node@${ort.version}`,
          source: { width: image.width, height: image.height },
          inputShape: tensor.shape,
          outputs,
        };
        writeFileSync(file, `${JSON.stringify(recorded)}\n`);
      }
      console.log(`  ${card.task} (${card.id}): ${describeRecorded(recorded, card, image)}`);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(e.stack ?? e.message);
    process.exit(1);
  });
}

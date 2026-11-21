#!/usr/bin/env node
// Downloads the model files of the vision demos into demos/vision-assets/models/ (git-ignored) and verifies them.
//
//   node scripts/vision-models.mjs                 download every model that is missing (resumable)
//   node scripts/vision-models.mjs --runtime onnx  only the web (onnx) or the Android (tflite) models
//   node scripts/vision-models.mjs --id <id>       only one model (ids are in demos/vision-assets/models.json)
//   node scripts/vision-models.mjs --check         list what is present and whether the checksum matches
//   node scripts/vision-models.mjs --hash <id>     download WITHOUT verifying and print size and SHA-256
//                                                  (for maintainers pinning a new model or a new version)
//   node scripts/vision-models.mjs --force         replace a present file whose checksum does not match
//
// A file whose SHA-256 matches models.json is never touched. Paths are relative to the repository root.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = join(ROOT, "demos", "vision-assets");
const MODELS_DIR = join(ASSETS, "models");

/** SHA-256 of a file as lowercase hex, streamed (model files are tens of megabytes). */
export async function sha256File(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/**
 * Compares a file with a pinned checksum.
 * Returns `{ status, actual? }` with status `missing`, `size_mismatch`, `bad_checksum` or `ok`.
 * The cheap size comparison runs first (when `size` is given) so a truncated file is not hashed.
 */
export async function verifyFile(path, { sha256, size }) {
  if (!existsSync(path)) return { status: "missing" };
  if (typeof size === "number" && statSync(path).size !== size) return { status: "size_mismatch" };
  const actual = await sha256File(path);
  return { status: actual === String(sha256).toLowerCase() ? "ok" : "bad_checksum", actual };
}

/** Reads and validates the shape of models.json (the model cards themselves are checked by the unit tests). */
export function loadModels(file = join(ASSETS, "models.json")) {
  const doc = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(doc.models)) throw new Error("models.json must hold a `models` array");
  for (const m of doc.models) {
    for (const k of ["id", "file", "url", "sha256", "size"]) {
      if (m[k] === undefined) throw new Error(`model ${m.id ?? "?"}: missing ${k}`);
    }
    if (!/^[0-9a-f]{64}$/.test(m.sha256)) throw new Error(`model ${m.id}: sha256 must be 64 lowercase hex characters`);
    if (!/^[A-Za-z0-9._-]+$/.test(m.file)) throw new Error(`model ${m.id}: file must be a plain file name`);
  }
  return doc.models;
}

export function parseArgs(argv) {
  const opts = { check: false, force: false, id: null, runtime: null, hash: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") opts.check = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--id" || a === "--runtime" || a === "--hash") {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      opts[a.slice(2)] = v;
    } else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function mb(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * Downloads `url` into `dest + ".part"`, resuming a previous partial download with a Range request, and returns
 * the final byte count. Progress goes to `log`. Does not verify: the caller does.
 */
export async function downloadTo(url, dest, { fetchImpl = fetch, log = () => {}, expectedSize } = {}) {
  const part = `${dest}.part`;
  mkdirSync(dirname(dest), { recursive: true });
  let have = existsSync(part) ? statSync(part).size : 0;
  if (typeof expectedSize === "number" && have > expectedSize) {
    rmSync(part);
    have = 0;
  }
  if (typeof expectedSize === "number" && have === expectedSize) return have;
  const headers = have > 0 ? { Range: `bytes=${have}-` } : {};
  const res = await fetchImpl(url, { headers, redirect: "follow" });
  if (res.status === 416) {
    // The server says the range is past the end: the partial file is already complete (or garbage; the checksum decides).
    return have;
  }
  if (!res.ok || res.body === null) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  let append = false;
  if (have > 0) {
    if (res.status === 206) append = true;
    else {
      log("server ignored the range request, starting over");
      have = 0;
    }
  }
  const total = (() => {
    const len = Number(res.headers.get("content-length"));
    return Number.isFinite(len) && len > 0 ? len + (append ? have : 0) : expectedSize;
  })();
  let written = append ? have : 0;
  let lastLog = 0;
  const out = createWriteStream(part, { flags: append ? "a" : "w" });
  const counter = async function* (source) {
    for await (const chunk of source) {
      written += chunk.length;
      const now = Date.now();
      if (now - lastLog > 500) {
        lastLog = now;
        log(total ? `  ${mb(written)} / ${mb(total)} (${Math.floor((written * 100) / total)}%)` : `  ${mb(written)}`);
      }
      yield chunk;
    }
  };
  await pipeline(Readable.fromWeb(res.body), counter, out);
  return written;
}

/** Ensures one model file is present and verified. Returns `downloaded`, `present` (already matched) or throws. */
export async function ensureModel(model, { dir = MODELS_DIR, force = false, fetchImpl = fetch, log = () => {} } = {}) {
  const dest = join(dir, model.file);
  const pin = { sha256: model.sha256, size: model.size };
  const current = await verifyFile(dest, pin);
  if (current.status === "ok") return "present";
  if (current.status !== "missing" && !force) {
    throw new Error(`${model.file} exists but does not match the pinned checksum (${current.status}); delete it or pass --force`);
  }
  if (current.status !== "missing") rmSync(dest);
  log(`downloading ${model.file} (${mb(model.size)})`);
  await downloadTo(model.url, dest, { fetchImpl, log, expectedSize: model.size });
  const part = `${dest}.part`;
  const checked = await verifyFile(part, pin);
  if (checked.status !== "ok") {
    rmSync(part, { force: true });
    throw new Error(`${model.file}: downloaded file failed verification (${checked.status}${checked.actual ? `, sha256 ${checked.actual}` : ""}); partial file removed, run again`);
  }
  renameSync(part, dest);
  return "downloaded";
}

async function main(argv) {
  const opts = parseArgs(argv);
  const all = loadModels();
  let models = all;
  if (opts.id) models = models.filter((m) => m.id === opts.id);
  if (opts.runtime) models = models.filter((m) => m.runtime === opts.runtime);
  if (opts.hash) {
    const m = all.find((x) => x.id === opts.hash);
    if (!m) throw new Error(`unknown model id: ${opts.hash}`);
    const tmp = join(MODELS_DIR, `${m.file}.hash`);
    rmSync(`${tmp}.part`, { force: true });
    const size = await downloadTo(m.url, tmp, { log: (s) => process.stderr.write(`${s}\n`) });
    renameSync(`${tmp}.part`, tmp);
    console.log(JSON.stringify({ id: m.id, size, sha256: await sha256File(tmp) }));
    rmSync(tmp);
    return 0;
  }
  if (models.length === 0) throw new Error("no model matches the filters");
  let bad = 0;
  for (const m of models) {
    if (opts.check) {
      const r = await verifyFile(join(MODELS_DIR, m.file), { sha256: m.sha256, size: m.size });
      if (r.status !== "ok") bad++;
      console.log(`${r.status === "ok" ? "ok     " : r.status.padEnd(7)} ${m.id.padEnd(28)} ${m.file} (${m.runtime}, ${mb(m.size)})`);
    } else {
      try {
        const r = await ensureModel(m, { force: opts.force, log: (s) => process.stderr.write(`${s}\n`) });
        console.log(`${r === "present" ? "present   " : "downloaded"} ${m.id} (${m.file}, sha256 verified)`);
      } catch (e) {
        bad++;
        console.error(`FAILED ${m.id}: ${e.message}`);
      }
    }
  }
  return bad === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e.message);
      process.exit(2);
    },
  );
}

// Unit tests of the checksum verifier and the downloader of scripts/vision-models.mjs.
// Run: node --test scripts/   (no network: downloads are served by a fake fetch)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { downloadTo, ensureModel, loadModels, parseArgs, sha256File, verifyFile } from "./vision-models.mjs";

const dir = mkdtempSync(join(tmpdir(), "vision-models-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const payload = Buffer.from("the quick brown fox jumps over the lazy dog ".repeat(1000));
const card = { id: "t", file: "t.bin", url: "https://example.invalid/t.bin", sha256: sha(payload), size: payload.length, runtime: "onnx" };

/** A fetch that serves `body`, honouring Range when `ranges` is true; counts its calls. */
function fakeFetch(body, { ranges = true, status = 200 } = {}) {
  const f = async (_url, init = {}) => {
    f.calls++;
    const range = init.headers?.Range;
    let start = 0;
    let code = status;
    if (range && ranges) {
      start = Number(/bytes=(\d+)-/.exec(range)[1]);
      code = start >= body.length ? 416 : 206;
    }
    const slice = body.subarray(start);
    return new Response(code === 416 ? null : slice, { status: code, headers: { "content-length": String(slice.length) } });
  };
  f.calls = 0;
  return f;
}

describe("sha256File", () => {
  it("hashes a local file", async () => {
    const p = join(dir, "abc.txt");
    writeFileSync(p, "abc");
    assert.equal(await sha256File(p), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("hashes the empty file", async () => {
    const p = join(dir, "empty.txt");
    writeFileSync(p, "");
    assert.equal(await sha256File(p), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("verifyFile", () => {
  const p = join(dir, "v.bin");
  writeFileSync(p, payload);
  it("accepts a file that matches (checksum in any letter case)", async () => {
    assert.deepEqual(await verifyFile(p, { sha256: sha(payload), size: payload.length }), { status: "ok", actual: sha(payload) });
    assert.equal((await verifyFile(p, { sha256: sha(payload).toUpperCase() })).status, "ok");
  });
  it("reports a missing file", async () => {
    assert.deepEqual(await verifyFile(join(dir, "nope.bin"), { sha256: sha(payload) }), { status: "missing" });
  });
  it("reports a wrong size before hashing", async () => {
    assert.deepEqual(await verifyFile(p, { sha256: sha(payload), size: payload.length + 1 }), { status: "size_mismatch" });
  });
  it("reports a wrong checksum", async () => {
    const r = await verifyFile(p, { sha256: sha(Buffer.from("other")), size: payload.length });
    assert.equal(r.status, "bad_checksum");
    assert.equal(r.actual, sha(payload));
  });
  it("detects a single flipped byte", async () => {
    const q = join(dir, "flipped.bin");
    const copy = Buffer.from(payload);
    copy[100] ^= 1;
    writeFileSync(q, copy);
    assert.equal((await verifyFile(q, { sha256: sha(payload), size: payload.length })).status, "bad_checksum");
  });
});

describe("ensureModel", () => {
  it("downloads a missing file, verifies it and leaves no partial file", async () => {
    const d = mkdtempSync(join(dir, "dl-"));
    const f = fakeFetch(payload);
    assert.equal(await ensureModel(card, { dir: d, fetchImpl: f }), "downloaded");
    assert.equal(f.calls, 1);
    assert.deepEqual(readFileSync(join(d, card.file)), payload);
    assert.equal(existsSync(join(d, `${card.file}.part`)), false);
  });

  it("never touches a file whose checksum matches", async () => {
    const d = mkdtempSync(join(dir, "keep-"));
    writeFileSync(join(d, card.file), payload);
    const before = statSync(join(d, card.file)).mtimeMs;
    const f = fakeFetch(payload);
    assert.equal(await ensureModel(card, { dir: d, fetchImpl: f }), "present");
    assert.equal(f.calls, 0);
    assert.equal(statSync(join(d, card.file)).mtimeMs, before);
  });

  it("refuses to replace a mismatching file unless forced", async () => {
    const d = mkdtempSync(join(dir, "bad-"));
    writeFileSync(join(d, card.file), "corrupt");
    const f = fakeFetch(payload);
    await assert.rejects(ensureModel(card, { dir: d, fetchImpl: f }), /does not match the pinned checksum/);
    assert.equal(f.calls, 0);
    assert.equal(readFileSync(join(d, card.file), "utf8"), "corrupt");
    assert.equal(await ensureModel(card, { dir: d, fetchImpl: f, force: true }), "downloaded");
    assert.deepEqual(readFileSync(join(d, card.file)), payload);
  });

  it("rejects a download that fails verification and removes the partial file", async () => {
    const d = mkdtempSync(join(dir, "tamper-"));
    const tampered = Buffer.from(payload);
    tampered[5] ^= 1;
    await assert.rejects(ensureModel(card, { dir: d, fetchImpl: fakeFetch(tampered) }), /failed verification/);
    assert.equal(existsSync(join(d, card.file)), false);
    assert.equal(existsSync(join(d, `${card.file}.part`)), false);
  });

  it("resumes a partial download with a Range request", async () => {
    const d = mkdtempSync(join(dir, "resume-"));
    writeFileSync(join(d, `${card.file}.part`), payload.subarray(0, 12345));
    const f = fakeFetch(payload);
    assert.equal(await ensureModel(card, { dir: d, fetchImpl: f }), "downloaded");
    assert.equal(f.calls, 1);
    assert.deepEqual(readFileSync(join(d, card.file)), payload);
  });

  it("starts over when the server ignores the Range request", async () => {
    const d = mkdtempSync(join(dir, "norange-"));
    writeFileSync(join(d, `${card.file}.part`), payload.subarray(0, 777));
    assert.equal(await ensureModel(card, { dir: d, fetchImpl: fakeFetch(payload, { ranges: false }) }), "downloaded");
    assert.deepEqual(readFileSync(join(d, card.file)), payload);
  });

  it("accepts a partial file that is already complete without a request", async () => {
    const d = mkdtempSync(join(dir, "complete-"));
    writeFileSync(join(d, `${card.file}.part`), payload);
    const f = fakeFetch(payload);
    assert.equal(await ensureModel(card, { dir: d, fetchImpl: f }), "downloaded");
    assert.equal(f.calls, 0);
  });

  it("restarts from scratch when the partial file is longer than the model", async () => {
    const d = mkdtempSync(join(dir, "long-"));
    writeFileSync(join(d, `${card.file}.part`), Buffer.concat([payload, Buffer.from("junk")]));
    assert.equal(await ensureModel(card, { dir: d, fetchImpl: fakeFetch(payload) }), "downloaded");
    assert.deepEqual(readFileSync(join(d, card.file)), payload);
  });

  it("fails on an HTTP error", async () => {
    const d = mkdtempSync(join(dir, "http-"));
    const f = async () => new Response("nope", { status: 404 });
    await assert.rejects(ensureModel(card, { dir: d, fetchImpl: f }), /HTTP 404/);
  });
});

describe("downloadTo", () => {
  it("reports progress through the log callback", async () => {
    const d = mkdtempSync(join(dir, "log-"));
    const lines = [];
    await downloadTo("https://example.invalid/x", join(d, "x.bin"), { fetchImpl: fakeFetch(payload), log: (s) => lines.push(s), expectedSize: payload.length });
    assert.ok(lines.length >= 1);
    assert.match(lines[0], /MB/);
  });
});

describe("parseArgs and models.json", () => {
  it("parses the options", () => {
    assert.deepEqual(parseArgs(["--check", "--runtime", "onnx", "--id", "a"]), { check: true, force: false, id: "a", runtime: "onnx", hash: null });
    assert.throws(() => parseArgs(["--bogus"]), /unknown argument/);
    assert.throws(() => parseArgs(["--id"]), /needs a value/);
  });
  it("loads the pinned models", () => {
    const models = loadModels();
    assert.ok(models.length >= 4);
    for (const m of models) assert.match(m.sha256, /^[0-9a-f]{64}$/);
  });
});

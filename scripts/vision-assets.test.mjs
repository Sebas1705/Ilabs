// Checks the committed demo assets: model cards, labels, samples and recorded outputs.
// Run: node --import ./scripts/lib/register-ts.mjs --test scripts/   (see `test:scripts` in package.json)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deflateSync } from "node:zlib";

import { shortFloat32 } from "./capture-vision-outputs.mjs";
import { ASSETS, loadCards, readLabels, specWithLabels } from "./lib/cards.mjs";
import { decodePng } from "./lib/png.mjs";
import { parseModelSpec, postprocessClassification, postprocessDetections, preprocessGeometry, VisionError } from "./lib/vision.mjs";

const cards = loadCards();
const samples = JSON.parse(readFileSync(join(ASSETS, "samples.json"), "utf8")).samples;
const json = (rel) => JSON.parse(readFileSync(join(ASSETS, rel), "utf8"));

describe("model cards", () => {
  it("lists a classifier and a detector for both runtimes", () => {
    const keys = cards.map((c) => `${c.runtime}/${c.task}`).sort();
    assert.deepEqual(keys, ["onnx/classification", "onnx/detection", "tflite/classification", "tflite/detection"]);
    assert.equal(new Set(cards.map((c) => c.id)).size, cards.length);
  });

  for (const card of cards) {
    describe(card.id, () => {
      it("passes parseModelSpec, bare and with its labels", () => {
        assert.doesNotThrow(() => parseModelSpec(card.spec));
        assert.doesNotThrow(() => specWithLabels(card));
      });

      it("has a complete, pinned description", () => {
        assert.match(card.sha256, /^[0-9a-f]{64}$/);
        assert.ok(Number.isInteger(card.size) && card.size > 0);
        assert.match(card.url, /^https:\/\//);
        assert.equal(card.runtime === "onnx" ? card.file.endsWith(".onnx") : card.file.endsWith(".tflite"), true);
        assert.equal(card.platform, card.runtime === "onnx" ? "web" : "android");
        assert.ok(["classification", "detection"].includes(card.task));
        assert.match(card.license.spdx, /^(Apache-2\.0|MIT|BSD-[23]-Clause)$/, "licenses must be Apache-2.0 compatible");
        assert.match(card.license.page, /^https:\/\//);
        assert.match(card.upstream, /^https:\/\//);
        assert.ok(card.license.note.length > 20);
      });

      it("matches its task: output kind, tensor names and label count", () => {
        const spec = specWithLabels(card);
        if (card.task === "classification") {
          assert.ok("type" in spec.output);
          assert.deepEqual(Object.keys(card.io.outputs), ["scores"]);
          assert.equal(spec.labels.length, 1000);
        } else {
          assert.equal(spec.output.format, "ssd");
          assert.deepEqual(Object.keys(card.io.outputs).sort(), ["boxes", "classes", "count", "scores"]);
          assert.equal(spec.labels.length, 90);
        }
        if (card.runtime === "tflite") assert.ok(card.io.outputIndex);
      });

      it("keeps the labels out of the model file reference", () => {
        assert.equal(card.spec.labels, undefined);
        assert.ok(existsSync(join(ASSETS, card.labels)));
      });
    });
  }

  it("rejects a corrupted card (the parser is really in the loop)", () => {
    const bad = structuredClone(cards[0].spec);
    bad.input.layout = "chw";
    assert.throws(() => parseModelSpec(bad), (e) => e instanceof VisionError && e.message.startsWith("invalid model spec:"));
  });

  it("uses the label offsets the class conventions need (COCO ids vs 0-based indices)", () => {
    const byId = Object.fromEntries(cards.map((c) => [c.id, c]));
    const labels = readLabels("labels/coco-90.txt");
    assert.equal(labels[0], "person");
    assert.equal(byId["ssd-mobilenet-v1-onnx"].spec.labelOffset, 1);
    assert.equal(byId["ssd-mobilenet-v1-tflite"].spec.labelOffset, 0);
  });
});

describe("labels", () => {
  it("have the expected sizes and known entries", () => {
    const imagenet = readLabels("labels/imagenet-1k.txt");
    assert.equal(imagenet.length, 1000);
    assert.equal(imagenet[0], "tench");
    assert.equal(imagenet[281], "tabby");
    assert.equal(imagenet[207], "golden retriever");
    assert.equal(imagenet[999], "toilet tissue");
    const coco = readLabels("labels/coco-90.txt");
    assert.equal(coco.length, 90);
    // The ten COCO category ids that are not used (1-based): the "???" placeholders.
    const unused = coco.map((l, i) => (l === "???" ? i + 1 : null)).filter(Boolean);
    assert.deepEqual(unused, [12, 26, 29, 30, 45, 66, 68, 69, 71, 83]);
    assert.equal(coco.filter((l) => l !== "???").length, 80);
  });
});

describe("samples", () => {
  it("has 5 to 8 samples with unique ids", () => {
    assert.ok(samples.length >= 5 && samples.length <= 8);
    assert.equal(new Set(samples.map((s) => s.id)).size, samples.length);
  });

  for (const s of samples) {
    it(`${s.id}: file, size, checksum, license and source are consistent`, () => {
      const path = join(ASSETS, "samples", s.file);
      const bytes = readFileSync(path);
      assert.ok(statSync(path).size <= 300 * 1024, "at most 300 KB");
      assert.equal(createHash("sha256").update(bytes).digest("hex"), s.sha256);
      const img = decodePng(bytes);
      assert.equal(img.width, s.width);
      assert.equal(img.height, s.height);
      assert.ok(s.title.es.length > 0 && s.title.en.length > 0);
      assert.equal(s.license, "CC0-1.0");
      assert.match(s.source.page, /^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
      assert.ok(s.source.author.length > 0);
    });
  }

  it("covers the required situations", () => {
    const ratios = samples.map((s) => s.width / s.height);
    assert.ok(ratios.some((r) => r >= 3), "a wide panorama");
    assert.ok(ratios.some((r) => r <= 0.6), "a tall portrait");
    assert.ok(samples.some((s) => s.id === "fog-rocks"), "a low-contrast image");
  });
});

describe("recorded outputs", () => {
  const recordedOf = (sample, card) => json(`recorded/${sample.id}.${card.task}.json`);
  const onnx = cards.filter((c) => c.runtime === "onnx");

  it("exist for every sample and every ONNX model, and stay small", () => {
    for (const s of samples) {
      for (const card of onnx) {
        const rel = `recorded/${s.id}.${card.task}.json`;
        assert.ok(existsSync(join(ASSETS, rel)), rel);
        assert.ok(statSync(join(ASSETS, rel)).size < 20 * 1024, `${rel} is small`);
      }
    }
  });

  it("name their model, checksum, runtime and source size", () => {
    for (const s of samples) {
      for (const card of onnx) {
        const r = recordedOf(s, card);
        assert.equal(r.sample, s.id);
        assert.equal(r.task, card.task);
        assert.equal(r.model, card.id);
        assert.equal(r.modelSha256, card.sha256);
        assert.match(r.runtime, /^onnxruntime-node@\d+\.\d+\.\d+$/);
        assert.deepEqual(r.source, { width: s.width, height: s.height });
        for (const t of Object.values(r.outputs)) {
          assert.equal(t.data.length, t.shape.reduce((a, b) => a * b, 1));
          assert.ok(t.data.every(Number.isFinite));
        }
      }
    }
  });

  it("decode with the module: the clear single objects are classified and detected right", () => {
    const expect = { cat: ["tabby", "cat"], dog: ["golden retriever", "dog"] };
    for (const [id, [cls, det]] of Object.entries(expect)) {
      const s = samples.find((x) => x.id === id);
      const c = onnx.find((x) => x.task === "classification");
      const d = onnx.find((x) => x.task === "detection");
      const top = postprocessClassification(recordedOf(s, c).outputs[c.io.outputs.scores].data, specWithLabels(c), { topK: 3 });
      assert.equal(top[0].label, cls, `${id} top-1`);
      assert.ok(top[0].score > 0.5);
      const named = Object.fromEntries(Object.entries(d.io.outputs).map(([k, v]) => [k, recordedOf(s, d).outputs[v]]));
      const spec = specWithLabels(d);
      const dets = postprocessDetections(named, spec, preprocessGeometry(s.width, s.height, spec), s);
      assert.equal(dets[0].label, det, `${id} detection`);
      assert.ok(dets[0].score > 0.8);
      const b = dets[0].box;
      assert.ok(b.x1 >= 0 && b.y1 >= 0 && b.x2 <= s.width + 1e-6 && b.y2 <= s.height + 1e-6 && b.x2 > b.x1 && b.y2 > b.y1);
    }
  });

  it("detect people in the crowd and nothing in the empty landscapes", () => {
    const d = onnx.find((x) => x.task === "detection");
    const spec = specWithLabels(d);
    const run = (id) => {
      const s = samples.find((x) => x.id === id);
      const named = Object.fromEntries(Object.entries(d.io.outputs).map(([k, v]) => [k, recordedOf(s, d).outputs[v]]));
      return postprocessDetections(named, spec, preprocessGeometry(s.width, s.height, spec), s);
    };
    assert.ok(run("crowd").filter((x) => x.label === "person").length >= 5);
    assert.equal(run("giraffe-tall")[0].label, "giraffe");
    assert.equal(run("fog-rocks").length, 0);
    assert.equal(run("mountains-wide").length, 0);
  });
});

describe("png decoder", () => {
  it("decodes every committed sample to width * height * 3 bytes", () => {
    for (const s of samples) {
      const img = decodePng(readFileSync(join(ASSETS, "samples", s.file)));
      assert.equal(img.data.length, s.width * s.height * 3);
    }
  });
  /** Builds a PNG (chunk CRCs are not checked by the decoder) from already filtered scanlines. */
  const png = (width, height, depth, color, scanlines, plte) => {
    const chunk = (type, body) => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(body.length, 0);
      head.write(type, 4, "latin1");
      return Buffer.concat([head, body, Buffer.alloc(4)]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = depth;
    ihdr[9] = color;
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      ...(plte ? [chunk("PLTE", Buffer.from(plte))] : []),
      chunk("IDAT", deflateSync(Buffer.from(scanlines))),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  };
  it("undoes the five scanline filters (RGB, 2x5 pixels)", () => {
    // Pixel rows (R,G,B per pixel): the unfiltered content is the same 2 pixels repeated with growing values.
    const rows = [
      [10, 20, 30, 40, 50, 60],
      [11, 22, 33, 44, 55, 66],
      [12, 24, 36, 48, 60, 72],
      [13, 26, 39, 52, 65, 78],
      [14, 28, 42, 56, 70, 84],
    ];
    const bpp = 3;
    const filters = [0, 1, 2, 3, 4];
    const paeth = (a, b, c) => {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    };
    const out = [];
    rows.forEach((row, y) => {
      const f = filters[y];
      out.push(f);
      row.forEach((v, x) => {
        const a = x >= bpp ? row[x - bpp] : 0;
        const b = y > 0 ? rows[y - 1][x] : 0;
        const c = x >= bpp && y > 0 ? rows[y - 1][x - bpp] : 0;
        const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][f];
        out.push((v - pred) & 255);
      });
    });
    const img = decodePng(png(2, 5, 8, 2, out));
    assert.equal(img.width, 2);
    assert.equal(img.height, 5);
    assert.deepEqual([...img.data], rows.flat());
  });
  it("expands a 2-bit palette image and a 1-bit grey image", () => {
    // 4x1 palette image, indices 0,1,2,3 packed as 00 01 10 11.
    const pal = decodePng(png(4, 1, 2, 3, [0, 0b00011011], [255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]));
    assert.deepEqual([...pal.data], [255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]);
    // 8x1 grey image at 1 bit: 10110000.
    const grey = decodePng(png(8, 1, 1, 0, [0, 0b10110000]));
    assert.deepEqual([...grey.data.filter((_, i) => i % 3 === 0)], [255, 0, 255, 255, 0, 0, 0, 0]);
  });
  it("drops the alpha channel of RGBA and keeps the high byte of 16-bit samples", () => {
    const rgba = decodePng(png(1, 1, 8, 6, [0, 1, 2, 3, 128]));
    assert.deepEqual([...rgba.data], [1, 2, 3]);
    const deep = decodePng(png(1, 1, 16, 0, [0, 0xab, 0xcd]));
    assert.deepEqual([...deep.data], [0xab, 0xab, 0xab]);
  });
  it("rejects interlaced images", () => {
    const p = png(1, 1, 8, 0, [0, 7]);
    p[8 + 8 + 12] = 1; // the interlace byte of IHDR
    assert.throws(() => decodePng(p), /interlaced/);
  });
  it("rejects garbage", () => {
    assert.throws(() => decodePng(Buffer.from("not a png at all")), /not a PNG/);
  });
});

describe("shortFloat32", () => {
  it("returns the shortest decimal that reads back as the same float32", () => {
    assert.equal(shortFloat32(Math.fround(0.1)), 0.1);
    assert.equal(shortFloat32(Math.fround(0.029451132)), 0.029451132);
    assert.equal(shortFloat32(0), 0);
    assert.equal(shortFloat32(Math.fround(1 / 3)), 0.33333334);
    for (const v of [0.5, 123456.7, 1e-7, 3.4028235e38]) assert.equal(Math.fround(shortFloat32(Math.fround(v))), Math.fround(v));
  });
});

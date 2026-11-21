import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = dirname(fileURLToPath(import.meta.url));
const library = readdirSync(src).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

/** Contract rules are hand-written arithmetic: no library rounding, no float32, no regular expressions, no Unicode or locale helpers. */
const BANNED = [
  "Math.round",
  "Math.trunc",
  "Math.fround",
  "Math.hypot",
  "Math.pow",
  "Math.sqrt",
  "Float32Array",
  "Float64Array",
  "Int8Array",
  "Int16Array",
  "Int32Array",
  "Uint16Array",
  "Uint32Array",
  "Uint8ClampedArray",
  "BigInt",
  "toFixed",
  "parseFloat",
  "parseInt",
  ".replace(",
  ".replaceAll(",
  ".split(",
  ".trim",
  "toLowerCase",
  "toUpperCase",
  "toLocale",
  ".normalize(",
  "localeCompare",
  "\\p{",
  ".match(",
  ".matchAll(",
  ".search(",
  ".test(",
  ".exec(",
  "RegExp",
  "Intl.",
];

describe("library sources", () => {
  it("has the expected files", () => {
    expect(library.sort()).toEqual(
      ["classify.ts", "contract.ts", "detect.ts", "errors.ts", "geometry.ts", "image.ts", "index.ts", "metrics.ts", "nms.ts", "pipeline.ts", "resize.ts", "spec.ts", "tensor.ts"].sort(),
    );
  });

  for (const file of library) {
    const text = readFileSync(join(src, file), "utf8");
    it(`${file} uses no library rounding, float32, regular expression or Unicode-aware helper`, () => {
      for (const banned of BANNED) expect(text.includes(banned), `${file} contains ${banned}`).toBe(false);
      for (const line of text.split("\n")) {
        const code = line.trimStart();
        if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) continue;
        // A regex literal: a slash right after an opening bracket, comma, colon, equals or return that is not a comment.
        expect(/[(=,:]\s*\/[^/*]/.test(code), `${file} has a regex literal: ${line}`).toBe(false);
        expect(/\breturn\s+\/[^/*]/.test(code), `${file} returns a regex literal: ${line}`).toBe(false);
      }
    });
    it(`${file} uses no Node API and no globals outside the language`, () => {
      expect(text.includes("node:"), file).toBe(false);
      expect(text.includes("process."), file).toBe(false);
      expect(text.includes("require("), file).toBe(false);
    });
  }

  it("Uint8Array is the only typed array and appears only for image bytes", () => {
    for (const file of library) {
      const text = readFileSync(join(src, file), "utf8");
      const uses = text.split("Uint8Array").length - 1;
      if (uses > 0) expect(["image.ts", "resize.ts", "tensor.ts", "contract.ts"], file).toContain(file);
    }
  });

  it("the library has no runtime dependency", () => {
    const pkg = JSON.parse(readFileSync(join(src, "../package.json"), "utf8")) as Record<string, unknown>;
    expect(pkg["dependencies"]).toBeUndefined();
  });
});

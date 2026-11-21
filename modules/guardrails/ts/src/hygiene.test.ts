import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = dirname(fileURLToPath(import.meta.url));
const library = readdirSync(src).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

/** Contract rules are hand-written scans: no regular expressions and no locale or Unicode aware helpers. */
const BANNED = [
  ".replace(",
  ".replaceAll(",
  ".split(",
  ".trim",
  "toLowerCase",
  "toUpperCase",
  "toLocale",
  "normalize",
  "localeCompare",
  "\\p{",
  ".match(",
  ".matchAll(",
  ".search(",
  ".test(",
  ".exec(",
  "RegExp",
  "Intl.",
  "BigInt",
];

describe("library sources", () => {
  it("has the expected files", () => {
    expect(library.length).toBeGreaterThanOrEqual(12);
  });

  for (const file of library) {
    const text = readFileSync(join(src, file), "utf8");
    it(`${file} uses no regular expression or Unicode-aware helper`, () => {
      for (const banned of BANNED) expect(text.includes(banned), `${file} contains ${banned}`).toBe(false);
      // A regex literal: a slash right after an opening bracket, comma, colon, equals or return that is not a comment.
      for (const line of text.split("\n")) {
        const code = line.trimStart();
        if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) continue;
        expect(/[(=,:]\s*\/[^/*]/.test(code), `${file} has a regex literal: ${line}`).toBe(false);
      }
    });
    if (file !== "contract.ts") {
      it(`${file} uses no Node API`, () => {
        expect(text.includes("node:"), file).toBe(false);
      });
    }
  }

  it("contract.ts (the harness) is browser-safe: no Node imports", () => {
    const text = readFileSync(join(src, "contract.ts"), "utf8");
    expect(text.includes("node:")).toBe(false);
    expect(text.includes("process.")).toBe(false);
  });
});

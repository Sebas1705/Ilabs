import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tokenize, tokenizeSpans } from "./tokenize.js";

const cp = (n: number): string => String.fromCodePoint(n);

describe("tokenize", () => {
  it("folds ASCII upper case and splits on ASCII punctuation", () => {
    expect(tokenize("Hello, WORLD! it's snake_case/path-v1.x")).toEqual(["hello", "world", "it", "s", "snake", "case", "path", "v1", "x"]);
  });

  it("keeps ASCII digits as word code points", () => {
    expect(tokenize("Room 101 opens at 9am v2")).toEqual(["room", "101", "opens", "at", "9am", "v2"]);
  });

  it("treats every ASCII code point other than [0-9A-Za-z] as a separator", () => {
    for (let c = 0; c < 0x80; c++) {
      const isWord = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
      const expected = isWord ? [`a${cp(c >= 0x41 && c <= 0x5a ? c + 0x20 : c)}b`] : ["a", "b"];
      expect(tokenize(`a${cp(c)}b`), `U+${c.toString(16)}`).toEqual(expected);
    }
  });

  it("folds the whole Latin-1 table, upper and lower case", () => {
    const table: Array<[number, string]> = [];
    const groups: Array<[number[], string]> = [
      [[0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xe0, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5], "a"],
      [[0xc6, 0xe6], "ae"],
      [[0xc7, 0xe7], "c"],
      [[0xc8, 0xc9, 0xca, 0xcb, 0xe8, 0xe9, 0xea, 0xeb], "e"],
      [[0xcc, 0xcd, 0xce, 0xcf, 0xec, 0xed, 0xee, 0xef], "i"],
      [[0xd0, 0xf0], "d"],
      [[0xd1, 0xf1], "n"],
      [[0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd8, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf8], "o"],
      [[0xd9, 0xda, 0xdb, 0xdc, 0xf9, 0xfa, 0xfb, 0xfc], "u"],
      [[0xdd, 0xfd, 0xff], "y"],
      [[0xde, 0xfe], "th"],
      [[0xdf], "ss"],
    ];
    for (const [cps, rep] of groups) for (const c of cps) table.push([c, rep]);
    expect(table).toHaveLength(62);
    for (const [c, rep] of table) expect(tokenize(`x${cp(c)}y`), `U+${c.toString(16)}`).toEqual([`x${rep}y`]);
    // Every code point of U+00C0..U+00FF is in the table except the two separators.
    const covered = new Set(table.map(([c]) => c));
    for (let c = 0xc0; c <= 0xff; c++) {
      if (c === 0xd7 || c === 0xf7) expect(tokenize(`x${cp(c)}y`)).toEqual(["x", "y"]);
      else expect(covered.has(c), `U+${c.toString(16)}`).toBe(true);
    }
  });

  it("separates on the pinned ranges beyond ASCII and nowhere else", () => {
    const separators = [0xa0, 0xa1, 0xaa, 0xb5, 0xb9, 0xba, 0xbc, 0xbf, 0xd7, 0xf7, 0x2000, 0x200b, 0x2014, 0x201c, 0x2026, 0x206f];
    for (const c of separators) expect(tokenize(`a${cp(c)}b`), `U+${c.toString(16)}`).toEqual(["a", "b"]);
    const words = [0x80, 0x9f, 0x100, 0x141, 0x178, 0x1fff, 0x2070, 0x3000, 0xff0c, 0x1f600];
    for (const c of words) expect(tokenize(`a${cp(c)}b`), `U+${c.toString(16)}`).toEqual([`a${cp(c)}b`]);
  });

  it("does not use Unicode case folding or normalization", () => {
    expect(tokenize("Łodź ŒUVRE Ÿ Σοφία")).toEqual(["Łodź", "Œuvre", "Ÿ", "Σοφία"]);
    expect(tokenize("café café")).toEqual(["café", "cafe"]);
    expect(tokenize("İ")).toEqual(["İ"]);
  });

  it("splits Spanish inverted marks and folds accents", () => {
    expect(tokenize("¿Qué hora es? ¡Ya!")).toEqual(["que", "hora", "es", "ya"]);
    expect(tokenize("Canción ÁRBOL pingüino Ñandú")).toEqual(["cancion", "arbol", "pinguino", "nandu"]);
  });

  it("keeps lone surrogates as one word code point each", () => {
    expect(tokenize("a\ud800b \udc00 x\ud83d \ude00\ud83d")).toEqual(["a\ud800b", "\udc00", "x\ud83d", "\ude00\ud83d"]);
    expect(tokenize("😀x")).toEqual(["😀x"]);
  });

  it("returns no tokens for an empty or separator-only text", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize(" ,.-¿¡«»— ")).toEqual([]);
  });
});

describe("tokenizeSpans", () => {
  it("returns the folded token with the code-point span of the SOURCE run", () => {
    expect(tokenizeSpans("Hello, WORLD")).toEqual([
      { token: "hello", start: 0, end: 5 },
      { token: "world", start: 7, end: 12 },
    ]);
  });

  it("measures end - start on the source run when folding lengthens a code point", () => {
    expect(tokenizeSpans("Straße")).toEqual([{ token: "strasse", start: 0, end: 6 }]);
    expect(tokenizeSpans("ß x")).toEqual([
      { token: "ss", start: 0, end: 1 },
      { token: "x", start: 2, end: 3 },
    ]);
    expect(tokenizeSpans("Æ Þ")).toEqual([
      { token: "ae", start: 0, end: 1 },
      { token: "th", start: 2, end: 3 },
    ]);
  });

  it("keeps offsets right after a lengthening fold", () => {
    expect(tokenizeSpans("ßß, ab")).toEqual([
      { token: "ssss", start: 0, end: 2 },
      { token: "ab", start: 4, end: 6 },
    ]);
    expect(tokenizeSpans("Æ-b ß-c")).toEqual([
      { token: "ae", start: 0, end: 1 },
      { token: "b", start: 2, end: 3 },
      { token: "ss", start: 4, end: 5 },
      { token: "c", start: 6, end: 7 },
    ]);
  });

  it("counts an astral code point as one", () => {
    expect(tokenizeSpans("😀 ab")).toEqual([
      { token: "😀", start: 0, end: 1 },
      { token: "ab", start: 2, end: 4 },
    ]);
    expect(tokenizeSpans("😀x y")).toEqual([
      { token: "😀x", start: 0, end: 2 },
      { token: "y", start: 3, end: 4 },
    ]);
  });

  it("counts every lone surrogate as one code point and glues it to its neighbours", () => {
    expect(tokenizeSpans("a\ud800b \udc00 x\ud83d \ude00\ud83d")).toEqual([
      { token: "a\ud800b", start: 0, end: 3 },
      { token: "\udc00", start: 4, end: 5 },
      { token: "x\ud83d", start: 6, end: 8 },
      { token: "\ude00\ud83d", start: 9, end: 11 },
    ]);
  });

  it("returns no spans for an empty or separator-only text", () => {
    expect(tokenizeSpans("")).toEqual([]);
    expect(tokenizeSpans(" ,.-¿¡«»— ")).toEqual([]);
  });

  it("projects to tokenize on every rag tokens-* fixture, and the spans stay inside the text", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../../contracts/rag");
    const files = readdirSync(dir).filter((f) => f.startsWith("tokens-") && f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(14);
    for (const f of files) {
      const fx = JSON.parse(readFileSync(join(dir, f), "utf8")) as { setup: { text: string }; expect: { tokens: string[] } };
      const spans = tokenizeSpans(fx.setup.text);
      expect(spans.map((s) => s.token), f).toEqual(fx.expect.tokens);
      expect(tokenize(fx.setup.text), f).toEqual(fx.expect.tokens);
      const length = [...fx.setup.text].length;
      let last = 0;
      for (const s of spans) {
        expect(s.start, f).toBeGreaterThanOrEqual(last);
        expect(s.end, f).toBeGreaterThan(s.start);
        expect(s.end, f).toBeLessThanOrEqual(length);
        last = s.end;
      }
    }
  });
});

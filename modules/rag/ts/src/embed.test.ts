import { describe, expect, it } from "vitest";
import { encodeUtf8, fnv1a32, hashEmbed, hashEmbedder } from "./embed.js";
import { RagError } from "./errors.js";

const bytes = (s: string): number[] => encodeUtf8(s);

const expectInvalid = (f: () => unknown): void => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(RagError);
    expect((e as RagError).kind).toBe("invalid_options");
    return;
  }
  throw new Error("expected RagError(invalid_options)");
};

const nonZero = (v: number[]): Array<[number, number]> =>
  v.flatMap((x, i) => (x === 0 ? [] : [[i, x] as [number, number]]));

describe("hand-written UTF-8 encoder", () => {
  it("encodes 1 to 4 bytes at every boundary", () => {
    expect(bytes("a")).toEqual([0x61]);
    expect(bytes("\u007f")).toEqual([0x7f]);
    expect(bytes("\u0080")).toEqual([0xc2, 0x80]);
    expect(bytes("ñ")).toEqual([0xc3, 0xb1]);
    expect(bytes("߿")).toEqual([0xdf, 0xbf]);
    expect(bytes("ࠀ")).toEqual([0xe0, 0xa0, 0x80]);
    expect(bytes("日")).toEqual([0xe6, 0x97, 0xa5]);
    expect(bytes("￿")).toEqual([0xef, 0xbf, 0xbf]);
    expect(bytes("\u{10000}")).toEqual([0xf0, 0x90, 0x80, 0x80]);
    expect(bytes("😀")).toEqual([0xf0, 0x9f, 0x98, 0x80]);
    expect(bytes("\u{10ffff}")).toEqual([0xf4, 0x8f, 0xbf, 0xbf]);
  });

  it("encodes every lone surrogate as U+FFFD", () => {
    expect(bytes("\ud800")).toEqual([0xef, 0xbf, 0xbd]);
    expect(bytes("\udfff")).toEqual([0xef, 0xbf, 0xbd]);
    expect(bytes("\ude00\ud83d")).toEqual([0xef, 0xbf, 0xbd, 0xef, 0xbf, 0xbd]);
    expect(bytes("x\ud83d")).toEqual([0x78, 0xef, 0xbf, 0xbd]);
  });

  it("matches TextEncoder on well-formed and ill-formed text", () => {
    const samples = ["", "hola", "canción", "日本語", "a😀b", "\ud800", "a\udc00b", "\ude00\ud83d", "\u{10ffff}"];
    for (const s of samples) expect(bytes(s), JSON.stringify(s)).toEqual([...new TextEncoder().encode(s)]);
  });
});

describe("FNV-1a 32-bit", () => {
  it("gives the contract check values as unsigned integers", () => {
    expect(fnv1a32([])).toBe(0x811c9dc5);
    expect(fnv1a32(bytes("a"))).toBe(0xe40c292c);
    expect(fnv1a32(bytes("foobar"))).toBe(0xbf9cf968);
    expect(fnv1a32(bytes("<a>"))).toBe(0x8c9cd1f0);
  });
});

describe("hashEmbed", () => {
  it("defaults to 256 dimensions", () => {
    expect(hashEmbed("hola")).toHaveLength(256);
    expect(hashEmbed("hola", 3)).toHaveLength(3);
  });

  it("gives a one-code-point token exactly one window", () => {
    // "<a>" hashes to 0x8C9CD1F0: bucket 240, bit 31 set.
    expect(nonZero(hashEmbed("a"))).toEqual([[240, -1]]);
  });

  it("adds every window and normalizes", () => {
    const v = nonZero(hashEmbed("ab"));
    expect(v.map(([i]) => i)).toEqual([28, 228]);
    for (const [, x] of v) expect(x).toBeCloseTo(Math.SQRT1_2, 15);
    const sum = hashEmbed("canción de prueba").reduce((s, x) => s + x * x, 0);
    expect(sum).toBeCloseTo(1, 12);
  });

  it("embeds folded tokens", () => {
    expect(hashEmbed("HÓLA, Mundo")).toEqual(hashEmbed("hola mundo"));
  });

  it("embeds a text without tokens to the zero vector", () => {
    expect(nonZero(hashEmbed(""))).toEqual([]);
    expect(nonZero(hashEmbed("¿? — …"))).toEqual([]);
  });

  it("validates dim itself", () => {
    expectInvalid(() => hashEmbed("a", 0));
    expectInvalid(() => hashEmbed("a", -1));
    expectInvalid(() => hashEmbed("a", 2.5));
    expectInvalid(() => hashEmbed("a", Number.NaN));
    expectInvalid(() => hashEmbed("a", Number.POSITIVE_INFINITY));
    expectInvalid(() => hashEmbed("a", null as unknown as number));
    expectInvalid(() => hashEmbedder(null as unknown as number));
  });
});

describe("hashEmbedder", () => {
  it("throws on a bad dim at construction, before any embed call", () => {
    expectInvalid(() => hashEmbedder(0));
    expectInvalid(() => hashEmbedder(2.5));
  });

  it("embeds each text like hashEmbed, in order", async () => {
    const e = hashEmbedder(16);
    const texts = ["hola", "", "mundo"];
    expect(await e.embed(texts)).toEqual(texts.map((t) => hashEmbed(t, 16)));
    expect(texts).toEqual(["hola", "", "mundo"]);
    expect(await hashEmbedder().embed(["x"])).toEqual([hashEmbed("x", 256)]);
  });
});

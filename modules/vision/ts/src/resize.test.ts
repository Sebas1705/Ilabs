import { describe, expect, it } from "vitest";
import { VisionError } from "./errors.js";
import type { Image } from "./image.js";
import { resize } from "./resize.js";

const img = (width: number, height: number, bytes: number[]): Image => ({ width, height, data: Uint8Array.from(bytes) });
/** A one-channel-looking image: every pixel has the same value in the three channels. */
const gray = (width: number, height: number, values: number[]): Image => img(width, height, values.flatMap((v) => [v, v, v]));
const reds = (image: Image): number[] => Array.from({ length: image.width * image.height }, (_, i) => image.data[i * 3]!);

function kindOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(VisionError);
    return (e as VisionError).kind;
  }
  return "no error";
}

describe("resize validation (invalid_options)", () => {
  const ok = gray(1, 1, [5]);
  it("target sizes", () => {
    for (const v of [0, -1, 16385, 1.5, null, NaN, "2", Infinity]) {
      expect(kindOf(() => resize(ok, v as number, 1, "nearest"))).toBe("invalid_options");
      expect(kindOf(() => resize(ok, 1, v as number, "nearest"))).toBe("invalid_options");
    }
  });
  it("method", () => {
    for (const m of [null, undefined, "cubic", "Nearest", 1]) expect(kindOf(() => resize(ok, 1, 1, m as "nearest"))).toBe("invalid_options");
  });
  it("image sizes, data length and data type", () => {
    for (const bad of [
      { width: 0, height: 1, data: new Uint8Array(0) },
      { width: 16385, height: 1, data: new Uint8Array(16385 * 3) },
      { width: 1, height: 16385, data: new Uint8Array(16385 * 3) },
      { width: 1.5, height: 1, data: new Uint8Array(3) },
      { width: null, height: 1, data: new Uint8Array(3) },
      { width: 1, height: 1, data: new Uint8Array(2) },
      { width: 1, height: 1, data: new Uint8Array(4) },
      { width: 1, height: 1, data: [1, 2, 3] },
      null,
      undefined,
    ]) {
      expect(kindOf(() => resize(bad as unknown as Image, 1, 1, "nearest"))).toBe("invalid_options");
    }
  });
  it("accepts exactly 16384 pixels per side", () => {
    const wide = { width: 16384, height: 1, data: new Uint8Array(16384 * 3).fill(9) };
    const out = resize(wide, 1, 1, "bilinear");
    expect(Array.from(out.data)).toEqual([9, 9, 9]);
    expect(resize(img(1, 1, [1, 2, 3]), 16384, 1, "nearest").data.length).toBe(16384 * 3);
  });
});

describe("resize nearest", () => {
  it("upscale 2x1 to 4x1 takes floor(sx + 0.5) with half-pixel centres", () => {
    expect(reds(resize(gray(2, 1, [10, 20]), 4, 1, "nearest"))).toEqual([10, 10, 20, 20]);
  });
  it("an exact half between two source pixels takes the larger index", () => {
    expect(reds(resize(gray(4, 1, [1, 2, 3, 4]), 2, 1, "nearest"))).toEqual([2, 4]);
  });
  it("copies the three bytes of one source pixel and keeps the row-major layout", () => {
    const src = img(2, 2, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(Array.from(resize(src, 2, 2, "nearest").data)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(Array.from(resize(src, 1, 1, "nearest").data)).toEqual([10, 11, 12]);
  });
});

describe("resize bilinear", () => {
  it("upscale 2x1 to 4x1 with clamped borders", () => {
    expect(reds(resize(gray(2, 1, [0, 100]), 4, 1, "bilinear"))).toEqual([0, 25, 75, 100]);
  });
  it("2x2 to 1x1 averages the four pixels per channel without mixing channels", () => {
    const src = img(2, 2, [10, 0, 255, 20, 0, 255, 12, 0, 0, 18, 4, 0]);
    expect(Array.from(resize(src, 1, 1, "bilinear").data)).toEqual([15, 1, 128]);
  });
  it("rounds half up, never to even: 0.5 -> 1, 1.5 -> 2", () => {
    expect(reds(resize(gray(2, 1, [0, 2]), 4, 1, "bilinear"))).toEqual([0, 1, 2, 2]);
  });
  it("same size returns the same bytes as a new image", () => {
    const src = img(3, 1, [1, 2, 3, 40, 50, 60, 255, 0, 9]);
    const out = resize(src, 3, 1, "bilinear");
    expect(out).not.toBe(src);
    expect(out.data).not.toBe(src.data);
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });
  it("a 1x1 source fills any target", () => {
    expect(Array.from(resize(img(1, 1, [7, 8, 9]), 2, 2, "bilinear").data)).toEqual([7, 8, 9, 7, 8, 9, 7, 8, 9, 7, 8, 9]);
  });
  it("the doubles of the contract, not exact math: weights 1 - f and f, term order a+b+c+d", () => {
    // 3x1 -> 7x1 at x = 1: sx = 3 * 1.5 / 7 - 0.5 = 0.142857..., values 137 and 0 give 137 * (1 - fx), see the fixtures
    const out = resize(gray(3, 1, [137, 0, 0]), 7, 1, "bilinear");
    expect(out.data[1 * 3]).toBe(Math.floor(137 * (1 - (((1 + 0.5) * 3) / 7 - 0.5)) + 0.5));
  });
  it("fx comes from the UNCLAMPED floor on the x axis too (the fixture resize-bilinear-clamped-fx-tie pins y)", () => {
    // expected bytes from a literal transcription of the contract's formulas; fx taken from the clamped x0 gives 72, 151 and 28 in places
    const src = img(1, 3, [29, 198, 158, 203, 12, 76, 124, 34, 225]);
    const expected = [73, 152, 138, 73, 152, 138, 73, 152, 137, 73, 152, 138, 73, 152, 138, 73, 152, 138, 144, 29, 188, 144, 29, 188, 144, 29, 188, 144, 29, 188, 144, 29, 188, 144, 29, 188];
    expect(Array.from(resize(src, 6, 2, "bilinear").data)).toEqual(expected);
  });

  it("does not mutate its input", () => {
    const src = img(2, 2, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const copy = Array.from(src.data);
    resize(src, 5, 3, "bilinear");
    expect(Array.from(src.data)).toEqual(copy);
    expect(src.width).toBe(2);
  });
});

describe("resize performance", () => {
  it("a 4096x4096 image resizes in a few seconds (linear cost)", () => {
    const side = 4096;
    const data = new Uint8Array(side * side * 3);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31) & 255;
    const start = Date.now();
    const down = resize({ width: side, height: side, data }, 1024, 1024, "bilinear");
    const same = resize({ width: side, height: side, data }, side, side, "bilinear");
    const elapsed = Date.now() - start;
    expect(down.data.length).toBe(1024 * 1024 * 3);
    expect(same.data[12345]).toBe(data[12345]);
    expect(elapsed).toBeLessThan(8000);
  });
});

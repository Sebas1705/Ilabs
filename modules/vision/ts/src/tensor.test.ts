import { describe, expect, it } from "vitest";
import { VisionError } from "./errors.js";
import type { Image } from "./image.js";
import { parseModelSpec } from "./spec.js";
import { toTensor } from "./tensor.js";

const img = (width: number, height: number, bytes: number[]): Image => ({ width, height, data: Uint8Array.from(bytes) });
const spec = (input: Record<string, unknown>, output: unknown = { type: "logits" }) =>
  parseModelSpec({ input: { width: 1, height: 1, layout: "nhwc", channels: "rgb", mode: "stretch", resample: "nearest", dtype: "float", ...input }, output });

describe("toTensor layouts and channels", () => {
  const src = img(2, 1, [1, 2, 3, 4, 5, 6]);

  it("nhwc interleaves the channels, shape [1,h,w,3]", () => {
    const { tensor } = toTensor(src, spec({ width: 2 }));
    expect(tensor).toEqual({ shape: [1, 1, 2, 3], data: [1, 2, 3, 4, 5, 6] });
  });

  it("nchw puts one plane after the other, shape [1,3,h,w]", () => {
    const { tensor } = toTensor(src, spec({ width: 2, layout: "nchw" }));
    expect(tensor).toEqual({ shape: [1, 3, 1, 2], data: [1, 4, 2, 5, 3, 6] });
  });

  it("bgr swaps first and third before normalization; mean/std follow the OUTPUT order", () => {
    const { tensor } = toTensor(img(1, 1, [10, 20, 30]), spec({ channels: "bgr", mean: [1, 2, 3], std: [2, 4, 8] }));
    expect(tensor.data).toEqual([(30 - 1) / 2, (20 - 2) / 4, (10 - 3) / 8]);
  });

  it("uint8 keeps the bytes, the swap and the layout", () => {
    const { tensor } = toTensor(src, spec({ width: 2, layout: "nchw", channels: "bgr", dtype: "uint8" }));
    expect(tensor).toEqual({ shape: [1, 3, 1, 2], data: [3, 6, 2, 5, 1, 4] });
  });

  it("the normalization is (v * scale - mean) / std, in this order", () => {
    const { tensor } = toTensor(img(1, 1, [100, 100, 100]), spec({ scale: 0.1, mean: [1, 2, 3], std: [2, 4, 5] }));
    expect(tensor.data).toEqual([(100 * 0.1 - 1) / 2, (100 * 0.1 - 2) / 4, (100 * 0.1 - 3) / 5]);
  });

  it("a negative std and a zero scale are valid", () => {
    const { tensor } = toTensor(img(1, 1, [100, 100, 100]), spec({ scale: 0, std: [-1, -1, -1] }));
    expect(tensor.data.map((v) => v + 0)).toEqual([0, 0, 0]);
  });

  it("rounds the resized byte before normalizing", () => {
    // 2x1 -> 4x1 bilinear gives 0, 1 (0.5 rounded up), 2, 2: the scaled values come from the bytes
    const { tensor } = toTensor(img(2, 1, [0, 0, 0, 2, 2, 2]), spec({ width: 4, resample: "bilinear", scale: 0.1 }));
    expect(tensor.data.slice(3, 6)).toEqual([1 * 0.1, 1 * 0.1, 1 * 0.1]);
  });
});

describe("toTensor modes", () => {
  it("letterbox: default pad 114, the odd extra pixel on the right, pad normalized", () => {
    const { tensor, geometry } = toTensor(img(1, 2, [1, 2, 3, 4, 5, 6]), spec({ width: 4, height: 2, mode: "letterbox", scale: 0.5, mean: [1, 2, 3], std: [1, 2, 4] }));
    expect(geometry).toMatchObject({ newWidth: 1, newHeight: 2, offsetX: 1, offsetY: 0 });
    const pad = [(114 * 0.5 - 1) / 1, (114 * 0.5 - 2) / 2, (114 * 0.5 - 3) / 4];
    const a = [(1 * 0.5 - 1) / 1, (2 * 0.5 - 2) / 2, (3 * 0.5 - 3) / 4];
    const b = [(4 * 0.5 - 1) / 1, (5 * 0.5 - 2) / 2, (6 * 0.5 - 3) / 4];
    expect(tensor.shape).toEqual([1, 2, 4, 3]);
    expect(tensor.data).toEqual([...pad, ...a, ...pad, ...pad, ...pad, ...b, ...pad, ...pad]);
  });

  it("letterbox: an explicit padValue stays a raw byte with uint8, swap applies", () => {
    const { tensor } = toTensor(img(1, 1, [1, 2, 3]), spec({ width: 3, height: 1, mode: "letterbox", padValue: 7, dtype: "uint8", channels: "bgr" }));
    expect(tensor.data).toEqual([7, 7, 7, 3, 2, 1, 7, 7, 7]);
  });

  it("padValue is accepted and ignored by the other modes", () => {
    const { tensor } = toTensor(img(1, 1, [1, 2, 3]), spec({ padValue: 9 }));
    expect(tensor.data).toEqual([1, 2, 3]);
  });

  it("centerCrop cuts the window out of the whole image resized", () => {
    // 4x1 -> 2x1 (height ratio 1 so scale = 1, scaledW = 4): window columns 1..2
    const { tensor, geometry } = toTensor(img(4, 1, [10, 10, 10, 20, 20, 20, 30, 30, 30, 40, 40, 40]), spec({ width: 2, mode: "centerCrop" }));
    expect(geometry).toMatchObject({ newWidth: 4, offsetX: -1 });
    expect(tensor.data).toEqual([20, 20, 20, 30, 30, 30]);
  });

  it("centerCrop is not a crop of the source then a resize", () => {
    // 3x1 -> 2x1 with bilinear: scale 1 -> window is columns 0..1 (cropX = 0), unlike a stretch
    const { tensor } = toTensor(img(3, 1, [0, 0, 0, 100, 100, 100, 200, 200, 200]), spec({ width: 2, mode: "centerCrop", resample: "bilinear" }));
    expect(tensor.data).toEqual([0, 0, 0, 100, 100, 100]);
  });

  it("a centre crop whose scaled image exceeds 16384 is computed without materializing it", () => {
    const side = 16384;
    const src: Image = { width: 1, height: side, data: new Uint8Array(side * 3).fill(5) };
    const { tensor, geometry } = toTensor(src, spec({ width: side, height: 2, mode: "centerCrop", dtype: "uint8" }));
    expect(geometry.newHeight).toBe(side * side);
    expect(geometry.offsetY).toBe(-Math.floor((side * side - 2) / 2));
    expect(tensor.shape).toEqual([1, 2, side, 3]);
    expect(tensor.data.length).toBe(2 * side * 3);
    expect(tensor.data[0]).toBe(5);
  });
});

describe("toTensor validation and purity", () => {
  it("rejects a bad image with invalid_options and a bad spec with invalid_spec", () => {
    const bad = { width: 1, height: 1, data: new Uint8Array(2) };
    expect(() => toTensor(bad, spec({}))).toThrowError(VisionError);
    try {
      toTensor(bad, spec({}));
    } catch (e) {
      expect((e as VisionError).kind).toBe("invalid_options");
    }
    try {
      toTensor(img(1, 1, [1, 2, 3]), { input: {} } as never);
    } catch (e) {
      expect((e as VisionError).kind).toBe("invalid_spec");
    }
  });

  it("does not mutate the image or the spec and returns new data", () => {
    const src = img(2, 1, [1, 2, 3, 4, 5, 6]);
    const s = spec({ width: 2, mean: [1, 1, 1] });
    const before = JSON.stringify(s);
    const a = toTensor(src, s);
    a.tensor.data[0] = 99;
    expect(Array.from(src.data)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(JSON.stringify(s)).toBe(before);
    expect(toTensor(src, s).tensor.data[0]).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { VisionError } from "./errors.js";
import { preprocessGeometry, unmapBox } from "./geometry.js";
import { parseModelSpec } from "./spec.js";

const spec = (width: number, height: number, mode: string, extra: Record<string, unknown> = {}) =>
  parseModelSpec({ input: { width, height, layout: "nhwc", channels: "rgb", mode, resample: "nearest", dtype: "float" }, output: { type: "logits" }, ...extra });

function kindOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(VisionError);
    return (e as VisionError).kind;
  }
  return "no error";
}

describe("preprocessGeometry", () => {
  it("stretch scales each axis on its own, no offset", () => {
    expect(preprocessGeometry(640, 480, spec(224, 224, "stretch"))).toEqual({
      scaleX: 224 / 640,
      scaleY: 224 / 480,
      offsetX: 0,
      offsetY: 0,
      newWidth: 224,
      newHeight: 224,
    });
  });

  it("centerCrop: scale = max ratio, crop halves, offset = 0 - crop", () => {
    const g = preprocessGeometry(400, 200, spec(100, 100, "centerCrop"));
    expect(g).toEqual({ scaleX: 0.5, scaleY: 0.5, offsetX: -50, offsetY: 0, newWidth: 200, newHeight: 100 });
    expect(Object.is(g.offsetY, 0)).toBe(true);
  });

  it("centerCrop: an odd difference crops the smaller half on the left", () => {
    const g = preprocessGeometry(8, 4, spec(5, 5, "centerCrop"));
    expect(g).toMatchObject({ newWidth: 10, newHeight: 5, offsetX: -2, offsetY: 0, scaleX: 1.25, scaleY: 1.25 });
  });

  it("centerCrop: rounds half up on the scale double and keeps the actual ratios", () => {
    const g = preprocessGeometry(6, 4, spec(5, 5, "centerCrop"));
    expect(g).toMatchObject({ newWidth: 8, newHeight: 5, scaleX: 8 / 6, scaleY: 1.25, offsetX: -1, offsetY: 0 });
  });

  it("letterbox: a 3x1 source into 8x6 pads the smaller half first", () => {
    const g = preprocessGeometry(3, 1, spec(8, 6, "letterbox"));
    expect(g).toEqual({ scaleX: 8 / 3, scaleY: 3, offsetX: 0, offsetY: 1, newWidth: 8, newHeight: 3 });
  });

  it("letterbox: the content is at least one pixel", () => {
    const g = preprocessGeometry(1000, 1, spec(4, 4, "letterbox"));
    expect(g).toMatchObject({ newWidth: 4, newHeight: 1, scaleX: 4 / 1000, scaleY: 1, offsetX: 0, offsetY: 1 });
  });

  it("letterbox: rounds half up (2x1 into 5x9: newH = 3)", () => {
    const g = preprocessGeometry(2, 1, spec(5, 9, "letterbox"));
    expect(g).toMatchObject({ newWidth: 5, newHeight: 3, offsetX: 0, offsetY: 3 });
  });

  it("geometry rounds on the scale double (7, not 8)", () => {
    // 11 * (15 / 22) is 7.499999999999999 in doubles, but 11 * 15 / 22 is 7.5
    const g = preprocessGeometry(22, 11, spec(15, 15, "letterbox"));
    expect(g.newHeight).toBe(Math.floor(11 * (15 / 22) + 0.5));
    expect(g.newHeight).toBe(7);
  });

  it("validates the source size (invalid_options) before the spec", () => {
    for (const v of [0, 16385, 1.5, null, "3", NaN]) {
      expect(kindOf(() => preprocessGeometry(v as number, 1, spec(2, 2, "stretch")))).toBe("invalid_options");
      expect(kindOf(() => preprocessGeometry(1, v as number, spec(2, 2, "stretch")))).toBe("invalid_options");
    }
    expect(preprocessGeometry(16384, 16384, spec(16384, 16384, "stretch")).scaleX).toBe(1);
  });

  it("validates a hand-built spec at runtime (invalid_spec)", () => {
    expect(kindOf(() => preprocessGeometry(2, 2, { input: { width: 0 } } as never))).toBe("invalid_spec");
    expect(kindOf(() => preprocessGeometry(2, 2, null as never))).toBe("invalid_spec");
  });

  it("accepts classifier and detector specs", () => {
    const det = parseModelSpec({ input: spec(4, 4, "stretch").input, output: { format: "ssd" } });
    expect(preprocessGeometry(8, 8, det).scaleX).toBe(0.5);
  });

  it("does not mutate the spec", () => {
    const s = spec(4, 4, "letterbox");
    const copy = JSON.stringify(s);
    preprocessGeometry(8, 2, s);
    expect(JSON.stringify(s)).toBe(copy);
  });
});

describe("unmapBox", () => {
  const letterbox = preprocessGeometry(3, 1, spec(8, 6, "letterbox"));

  it("subtracts the offset, then divides by the actual scale", () => {
    const box = unmapBox({ x1: 0, y1: 2, x2: 8, y2: 3 }, letterbox, 3, 1)!;
    expect(box.x1).toBe(0);
    expect(box.x2).toBe(3);
    expect(box.y1).toBe((2 - 1) / 3);
    expect(box.y2).toBe((3 - 1) / 3);
  });

  it("drops a box that lies in the padding", () => {
    expect(unmapBox({ x1: 0, y1: 0, x2: 8, y2: 1 }, letterbox, 3, 1)).toBeNull();
  });

  it("clamps to the source", () => {
    const g = preprocessGeometry(100, 100, spec(100, 100, "stretch"));
    expect(unmapBox({ x1: -5, y1: -5, x2: 500, y2: 500 }, g, 100, 100)).toEqual({ x1: 0, y1: 0, x2: 100, y2: 100 });
  });

  it("drops a box with no area and a swapped box, never reorders", () => {
    const g = preprocessGeometry(100, 100, spec(100, 100, "stretch"));
    expect(unmapBox({ x1: 10, y1: 10, x2: 10, y2: 20 }, g, 100, 100)).toBeNull();
    expect(unmapBox({ x1: 10, y1: 10, x2: 20, y2: 10 }, g, 100, 100)).toBeNull();
    expect(unmapBox({ x1: 30, y1: 10, x2: 20, y2: 20 }, g, 100, 100)).toBeNull();
    expect(unmapBox({ x1: 120, y1: 10, x2: 150, y2: 20 }, g, 100, 100)).toBeNull();
  });

  it("validates the source size and finite coordinates (invalid_options)", () => {
    const g = preprocessGeometry(100, 100, spec(100, 100, "stretch"));
    const box = { x1: 1, y1: 1, x2: 2, y2: 2 };
    for (const v of [0, 16385, 1.5, null]) {
      expect(kindOf(() => unmapBox(box, g, v as number, 10))).toBe("invalid_options");
      expect(kindOf(() => unmapBox(box, g, 10, v as number))).toBe("invalid_options");
    }
    for (const k of ["x1", "y1", "x2", "y2"] as const) {
      for (const v of [NaN, Infinity, -Infinity, "1", null]) {
        expect(kindOf(() => unmapBox({ ...box, [k]: v as number }, g, 10, 10))).toBe("invalid_options");
      }
    }
  });

  it("does not mutate the box or the geometry", () => {
    const g = { ...letterbox };
    const box = { x1: 0, y1: 2, x2: 8, y2: 3 };
    unmapBox(box, g, 3, 1);
    expect(box).toEqual({ x1: 0, y1: 2, x2: 8, y2: 3 });
    expect(g).toEqual(letterbox);
  });
});

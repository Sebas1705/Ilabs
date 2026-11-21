import { vi } from "vitest";
import { MAX_PICKED_SIDE, decodeFile, drawRgb, fitWithin, rgbaToRgb } from "./visionImage";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fitWithin", () => {
  it("keeps a small image and scales a large one by its longest side", () => {
    expect(fitWithin(640, 480, 4096)).toEqual({ width: 640, height: 480 });
    expect(fitWithin(8192, 4096, 4096)).toEqual({ width: 4096, height: 2048 });
    expect(fitWithin(1000, 8000, 4096)).toEqual({ width: 512, height: 4096 });
  });

  it("never returns a side below 1", () => {
    expect(fitWithin(100000, 1, 4096)).toEqual({ width: 4096, height: 1 });
  });
});

describe("rgbaToRgb", () => {
  it("composites on white", () => {
    // opaque red, transparent black, half transparent black
    const rgba = [255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 128];
    expect([...rgbaToRgb(rgba, 3, 1)]).toEqual([255, 0, 0, 255, 255, 255, 127, 127, 127]);
  });
});

/** A fake 2D context that records what is drawn and answers getImageData with the given RGBA bytes. */
function fakeContext(rgba: (w: number, h: number) => Uint8ClampedArray) {
  const calls: string[] = [];
  const ctx = {
    fillStyle: "",
    fillRect: () => calls.push("fillRect"),
    drawImage: (_b: unknown, _x: number, _y: number, w: number, h: number) => calls.push(`drawImage ${w}x${h}`),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: rgba(w, h), width: w, height: h }),
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: (d: { width: number; height: number; data: Uint8ClampedArray }) => calls.push(`put ${d.width}x${d.height} ${[...d.data.slice(0, 4)].join(",")}`),
  };
  return { ctx, calls };
}

describe("decodeFile", () => {
  it("draws on white through a canvas and returns RGB bytes", async () => {
    const { ctx, calls } = fakeContext((w, h) => {
      const out = new Uint8ClampedArray(w * h * 4);
      out.set([10, 20, 30, 255], 0); // opaque
      out.set([0, 0, 0, 0], 4); // fully transparent: white
      return out;
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 2, height: 1, close })));
    const image = await decodeFile(new File([new Uint8Array([1])], "a.png", { type: "image/png" }));
    expect(image.width).toBe(2);
    expect(image.height).toBe(1);
    expect([...image.data]).toEqual([10, 20, 30, 255, 255, 255]);
    expect(calls).toEqual(["fillRect", "drawImage 2x1"]);
    expect(close).toHaveBeenCalled();
  });

  it("caps the longest side at 4096 pixels", async () => {
    const { ctx, calls } = fakeContext((w, h) => new Uint8ClampedArray(w * h * 4).fill(255));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 8192, height: 4096, close: () => {} })));
    const image = await decodeFile(new File([new Uint8Array([1])], "big.png"));
    expect(MAX_PICKED_SIDE).toBe(4096);
    expect([image.width, image.height]).toEqual([4096, 2048]);
    expect(image.data.length).toBe(4096 * 2048 * 3);
    expect(calls).toContain("drawImage 4096x2048");
  });

  it("rejects what the browser cannot decode", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => Promise.reject(new Error("bad image"))));
    await expect(decodeFile(new File([new Uint8Array([1])], "x.txt"))).rejects.toThrow("bad image");
  });
});

describe("drawRgb", () => {
  it("puts opaque pixels on the canvas and does nothing without a context", () => {
    const { ctx, calls } = fakeContext(() => new Uint8ClampedArray(0));
    const canvas = document.createElement("canvas");
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    drawRgb(canvas, 1, 1, [1, 2, 3]);
    expect(calls).toEqual(["put 1x1 1,2,3,255"]);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    expect(() => drawRgb(canvas, 1, 1, [1, 2, 3])).not.toThrow();
    expect(() => drawRgb(null, 1, 1, [1, 2, 3])).not.toThrow();
  });
});

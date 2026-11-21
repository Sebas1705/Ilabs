import type { Image } from "@ilabs/vision";

/** The longest side of a picked image after decoding; larger images are scaled down (platform resampling, not the contract's). */
export const MAX_PICKED_SIDE = 4096;

/** Dimensions that fit `max` on the longest side, keeping the aspect ratio; never below 1 px and never larger than the source. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height };
  const k = max / longest;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** RGBA to RGB, compositing each pixel on white: `c * a + 255 * (1 - a)`, rounded. */
export function rgbaToRgb(rgba: ArrayLike<number>, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const a = rgba[i * 4 + 3]! / 255;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(rgba[i * 4 + c]! * a + 255 * (1 - a));
  }
  return out;
}

/** A bitmap drawn on a canvas of the given size and read back as RGB (alpha composited on white). */
function bitmapToImage(bitmap: ImageBitmap, width: number, height: number): Image {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("canvas unavailable");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  const rgba = ctx.getImageData(0, 0, width, height).data;
  return { width, height, data: rgbaToRgb(rgba, width, height) };
}

/** Decodes an image blob to RGB bytes, capping the longest side at `MAX_PICKED_SIDE`. */
export async function decodeBlob(blob: Blob): Promise<Image> {
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none" });
  try {
    const size = fitWithin(bitmap.width, bitmap.height, MAX_PICKED_SIDE);
    return bitmapToImage(bitmap, size.width, size.height);
  } finally {
    bitmap.close?.();
  }
}

/** The file a person picked (any format the browser can decode). */
export function decodeFile(file: File): Promise<Image> {
  return decodeBlob(file);
}

const sampleCache = new Map<string, Promise<Image>>();

/** A bundled sample PNG, decoded once. A failure is not cached. */
export function decodeSample(url: string): Promise<Image> {
  let p = sampleCache.get(url);
  if (p === undefined) {
    p = fetch(url).then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return decodeBlob(await r.blob());
    });
    sampleCache.set(url, p);
    p.catch(() => sampleCache.delete(url));
  }
  return p;
}

/** Draws RGB bytes on a canvas of the same size; does nothing when there is no 2D context (for example in a test DOM). */
export function drawRgb(canvas: HTMLCanvasElement | null, width: number, height: number, rgb: ArrayLike<number>): void {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const data = ctx.createImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    data.data[i * 4] = rgb[i * 3]!;
    data.data[i * 4 + 1] = rgb[i * 3 + 1]!;
    data.data[i * 4 + 2] = rgb[i * 3 + 2]!;
    data.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
}

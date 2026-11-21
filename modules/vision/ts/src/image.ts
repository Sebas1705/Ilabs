import { invalidOptions, isInt } from "./errors.js";

/** An 8-bit RGB image: `data` holds `width * height * 3` bytes, row-major, interleaved, top row first. */
export interface Image {
  width: number;
  height: number;
  data: Uint8Array;
}

/** The largest side of an image, a resize target or a model input, in pixels. */
export const MAX_SIDE = 16384;

/** Validates one side length: an integer from 1 to 16384 (`invalid_options`). */
export function checkSide(value: unknown, what: string): number {
  if (!isInt(value) || value < 1 || value > MAX_SIDE) invalidOptions(`${what} must be an integer from 1 to ${MAX_SIDE}`);
  return value;
}

/** Validates an image in the order of the contract: sizes, then the data length, then the bytes (a `Uint8Array` is always bytes). */
export function checkImage(image: unknown): Image {
  if (typeof image !== "object" || image === null) invalidOptions("image must be an object");
  const o = image as Record<string, unknown>;
  const width = checkSide(o["width"], "image width");
  const height = checkSide(o["height"], "image height");
  const data = o["data"];
  if (!(data instanceof Uint8Array) || data.length !== width * height * 3) {
    invalidOptions("image data must be a Uint8Array of width * height * 3 bytes");
  }
  return { width, height, data };
}

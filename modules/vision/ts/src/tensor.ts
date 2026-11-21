import { geometryOf, type Geometry } from "./geometry.js";
import { checkImage, type Image } from "./image.js";
import { resizeWindow } from "./resize.js";
import { parseModelSpec, type ModelSpec } from "./spec.js";

/** A model tensor: `data` is a flat list of numbers (byte values for `uint8`), row-major over `shape`. */
export interface Tensor {
  shape: number[];
  data: number[];
}

/** Builds the model-input canvas, `dstW x dstH x 3` bytes in RGB order, for the mode of the spec. */
function canvasOf(image: Image, spec: ModelSpec, geometry: Geometry): Uint8Array {
  const dstW = spec.input.width;
  const dstH = spec.input.height;
  const method = spec.input.resample;
  if (spec.input.mode === "stretch") return resizeWindow(image, dstW, dstH, method, 0, 0, dstW, dstH);
  if (spec.input.mode === "centerCrop") {
    const cropX = 0 - geometry.offsetX;
    const cropY = 0 - geometry.offsetY;
    return resizeWindow(image, geometry.newWidth, geometry.newHeight, method, cropX, cropY, dstW, dstH);
  }
  const resized = resizeWindow(image, geometry.newWidth, geometry.newHeight, method, 0, 0, geometry.newWidth, geometry.newHeight);
  const canvas = new Uint8Array(dstW * dstH * 3).fill(spec.input.padValue ?? 114);
  const padX = geometry.offsetX;
  const padY = geometry.offsetY;
  const rowBytes = geometry.newWidth * 3;
  for (let y = 0; y < geometry.newHeight; y++) {
    canvas.set(resized.subarray(y * rowBytes, (y + 1) * rowBytes), ((y + padY) * dstW + padX) * 3);
  }
  return canvas;
}

/** Converts an image into the input tensor of a model, together with the geometry needed to map boxes back. */
export function toTensor(image: Image, spec: ModelSpec): { tensor: Tensor; geometry: Geometry } {
  const img = checkImage(image);
  const checked = parseModelSpec(spec);
  const geometry = geometryOf(img.width, img.height, checked);
  const dstW = checked.input.width;
  const dstH = checked.input.height;
  const canvas = canvasOf(img, checked, geometry);
  const swap = checked.input.channels === "bgr";
  const isFloat = checked.input.dtype === "float";
  const scale = checked.input.scale ?? 1;
  const mean = checked.input.mean ?? [0, 0, 0];
  const std = checked.input.std ?? [1, 1, 1];
  const nhwc = checked.input.layout === "nhwc";

  const data: number[] = new Array<number>(dstW * dstH * 3);
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const base = (y * dstW + x) * 3;
      for (let c = 0; c < 3; c++) {
        const v = canvas[base + (swap ? 2 - c : c)]!;
        let value = v;
        if (isFloat) {
          const t1 = v * scale;
          const t2 = t1 - mean[c]!;
          value = t2 / std[c]!;
        }
        data[nhwc ? base + c : (c * dstH + y) * dstW + x] = value;
      }
    }
  }
  const shape = nhwc ? [1, dstH, dstW, 3] : [1, 3, dstH, dstW];
  return { tensor: { shape, data }, geometry };
}

/** The number of elements a shape holds (the empty product is 1); `null` when a dimension is not an integer from 0 up. */
export function shapeSize(shape: unknown): number | null {
  if (!Array.isArray(shape)) return null;
  let size = 1;
  for (const d of shape) {
    if (typeof d !== "number" || !Number.isInteger(d) || d < 0) return null;
    size = size * d;
  }
  return size;
}

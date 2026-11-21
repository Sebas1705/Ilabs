import { invalidOptions, isFiniteNumber } from "./errors.js";
import { checkSide } from "./image.js";
import type { Box } from "./nms.js";
import { parseModelSpec, type ModelSpec } from "./spec.js";

/** How the source image was mapped into the model input: a model-input coordinate `u` maps back to `(u - offset) / scale`. */
export interface Geometry {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
  /** Size of the resized content (the whole scaled image for a centre crop). */
  newWidth: number;
  newHeight: number;
}

/** `floor(v + 0.5)`, the only rounding of the module. */
function roundHalfUp(v: number): number {
  return Math.floor(v + 0.5);
}

/** The integer division of two non-negative integers. */
function intdiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/** Geometry of a spec already validated; the sizes are valid integers. */
export function geometryOf(srcW: number, srcH: number, spec: ModelSpec): Geometry {
  const dstW = spec.input.width;
  const dstH = spec.input.height;
  const mode = spec.input.mode;
  if (mode === "stretch") {
    return { scaleX: dstW / srcW, scaleY: dstH / srcH, offsetX: 0, offsetY: 0, newWidth: dstW, newHeight: dstH };
  }
  const rx = dstW / srcW;
  const ry = dstH / srcH;
  if (mode === "centerCrop") {
    const scale = Math.max(rx, ry);
    const scaledW = Math.max(dstW, roundHalfUp(srcW * scale));
    const scaledH = Math.max(dstH, roundHalfUp(srcH * scale));
    const cropX = intdiv(scaledW - dstW, 2);
    const cropY = intdiv(scaledH - dstH, 2);
    return { scaleX: scaledW / srcW, scaleY: scaledH / srcH, offsetX: 0 - cropX, offsetY: 0 - cropY, newWidth: scaledW, newHeight: scaledH };
  }
  const scale = Math.min(rx, ry);
  const newW = Math.max(1, roundHalfUp(srcW * scale));
  const newH = Math.max(1, roundHalfUp(srcH * scale));
  const padX = intdiv(dstW - newW, 2);
  const padY = intdiv(dstH - newH, 2);
  return { scaleX: newW / srcW, scaleY: newH / srcH, offsetX: padX, offsetY: padY, newWidth: newW, newHeight: newH };
}

/** Computes the geometry of a `srcWidth x srcHeight` image for a classifier or detector spec. */
export function preprocessGeometry(srcWidth: number, srcHeight: number, spec: ModelSpec): Geometry {
  const srcW = checkSide(srcWidth, "source width");
  const srcH = checkSide(srcHeight, "source height");
  return geometryOf(srcW, srcH, parseModelSpec(spec));
}

/**
 * Maps a box from model-input pixels back to the source image, clamped to it.
 * Returns `null` when the clamped box has no area (it lay in the padding or outside the source).
 */
export function unmapBox(box: Box, geometry: Geometry, srcWidth: number, srcHeight: number): Box | null {
  const srcW = checkSide(srcWidth, "source width");
  const srcH = checkSide(srcHeight, "source height");
  if (typeof box !== "object" || box === null) invalidOptions("box must be an object");
  for (const k of ["x1", "y1", "x2", "y2"] as const) {
    if (!isFiniteNumber(box[k])) invalidOptions(`box ${k} must be a finite number`);
  }
  if (typeof geometry !== "object" || geometry === null) invalidOptions("geometry must be an object");
  const ux1 = (box.x1 - geometry.offsetX) / geometry.scaleX;
  const uy1 = (box.y1 - geometry.offsetY) / geometry.scaleY;
  const ux2 = (box.x2 - geometry.offsetX) / geometry.scaleX;
  const uy2 = (box.y2 - geometry.offsetY) / geometry.scaleY;
  const x1 = Math.min(Math.max(ux1, 0), srcW);
  const y1 = Math.min(Math.max(uy1, 0), srcH);
  const x2 = Math.min(Math.max(ux2, 0), srcW);
  const y2 = Math.min(Math.max(uy2, 0), srcH);
  if (x2 - x1 <= 0 || y2 - y1 <= 0) return null;
  return { x1, y1, x2, y2 };
}

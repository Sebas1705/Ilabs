import { invalidOptions } from "./errors.js";
import { checkImage, checkSide, type Image } from "./image.js";

/**
 * The bytes of a window of the image `src` resized to `dstW x dstH`: the window starts at the resized pixel
 * `(offX, offY)` and is `outW x outH` pixels. Nothing larger than the window is allocated (a centre crop resizes
 * to a size that can exceed 16384 per side). Every double operation is written in the order of the contract.
 */
export function resizeWindow(src: Image, dstW: number, dstH: number, method: "nearest" | "bilinear", offX: number, offY: number, outW: number, outH: number): Uint8Array {
  const srcW = src.width;
  const srcH = src.height;
  const s = src.data;
  const out = new Uint8Array(outW * outH * 3);

  // Per-axis tables: the source position of each destination column and row.
  const xo0: number[] = [];
  const xo1: number[] = [];
  const wx0: number[] = [];
  const wx1: number[] = [];
  for (let x = 0; x < outW; x++) {
    const tx = x + offX + 0.5;
    const ux = tx * srcW;
    const vx = ux / dstW;
    const sx = vx - 0.5;
    if (method === "nearest") {
      let ix = Math.floor(sx + 0.5);
      if (ix < 0) ix = 0;
      else if (ix > srcW - 1) ix = srcW - 1;
      xo0.push(ix * 3);
    } else {
      const x0 = Math.floor(sx);
      const fx = sx - x0;
      const x1 = x0 + 1;
      xo0.push(Math.min(Math.max(x0, 0), srcW - 1) * 3);
      xo1.push(Math.min(Math.max(x1, 0), srcW - 1) * 3);
      wx0.push(1 - fx);
      wx1.push(fx);
    }
  }
  const yo0: number[] = [];
  const yo1: number[] = [];
  const wy0: number[] = [];
  const wy1: number[] = [];
  for (let y = 0; y < outH; y++) {
    const ty = y + offY + 0.5;
    const uy = ty * srcH;
    const vy = uy / dstH;
    const sy = vy - 0.5;
    if (method === "nearest") {
      let iy = Math.floor(sy + 0.5);
      if (iy < 0) iy = 0;
      else if (iy > srcH - 1) iy = srcH - 1;
      yo0.push(iy * srcW * 3);
    } else {
      const y0 = Math.floor(sy);
      const fy = sy - y0;
      const y1 = y0 + 1;
      yo0.push(Math.min(Math.max(y0, 0), srcH - 1) * srcW * 3);
      yo1.push(Math.min(Math.max(y1, 0), srcH - 1) * srcW * 3);
      wy0.push(1 - fy);
      wy1.push(fy);
    }
  }

  let p = 0;
  if (method === "nearest") {
    for (let y = 0; y < outH; y++) {
      const row = yo0[y]!;
      for (let x = 0; x < outW; x++) {
        const o = row + xo0[x]!;
        out[p++] = s[o]!;
        out[p++] = s[o + 1]!;
        out[p++] = s[o + 2]!;
      }
    }
    return out;
  }
  for (let y = 0; y < outH; y++) {
    const r0 = yo0[y]!;
    const r1 = yo1[y]!;
    const w0y = wy0[y]!;
    const w1y = wy1[y]!;
    for (let x = 0; x < outW; x++) {
      const o00 = r0 + xo0[x]!;
      const o10 = r0 + xo1[x]!;
      const o01 = r1 + xo0[x]!;
      const o11 = r1 + xo1[x]!;
      const w0x = wx0[x]!;
      const w1x = wx1[x]!;
      for (let c = 0; c < 3; c++) {
        let a = s[o00 + c]! * w0x;
        a = a * w0y;
        let b = s[o10 + c]! * w1x;
        b = b * w0y;
        let cc = s[o01 + c]! * w0x;
        cc = cc * w1y;
        let d = s[o11 + c]! * w1x;
        d = d * w1y;
        const v = a + b + cc + d;
        let r = Math.floor(v + 0.5);
        if (r < 0) r = 0;
        else if (r > 255) r = 255;
        out[p++] = r;
      }
    }
  }
  return out;
}

/** Resizes an image to `width x height` with the half-pixel-centre convention; returns a new image. */
export function resize(image: Image, width: number, height: number, method: "nearest" | "bilinear"): Image {
  const src = checkImage(image);
  const dstW = checkSide(width, "resize width");
  const dstH = checkSide(height, "resize height");
  if (method !== "nearest" && method !== "bilinear") invalidOptions('resize method must be "nearest" or "bilinear"');
  return { width: dstW, height: dstH, data: resizeWindow(src, dstW, dstH, method, 0, 0, dstW, dstH) };
}

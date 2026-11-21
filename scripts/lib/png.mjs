// Minimal PNG decoder for the demo samples (dev-time tooling): non-interlaced images of any colour type and bit
// depth up to 16, returned as 8-bit RGB (`Image` of @ilabs/vision). Alpha is dropped, 16-bit samples keep their high byte.
import { inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decodes a PNG file (a Buffer) into `{ width, height, data }` with `data` a `Uint8Array` of RGB bytes. */
export function decodePng(file) {
  if (file.length < 8 || !file.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG file");
  let pos = 8;
  let header = null;
  let palette = null;
  const idat = [];
  while (pos + 8 <= file.length) {
    const length = file.readUInt32BE(pos);
    const type = file.toString("latin1", pos + 4, pos + 8);
    const body = file.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length;
    if (type === "IHDR") {
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], color: body[9], interlace: body[12] };
    } else if (type === "PLTE") palette = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
  }
  if (header === null) throw new Error("PNG without IHDR");
  const { width, height, depth, color, interlace } = header;
  if (interlace !== 0) throw new Error("interlaced PNG is not supported");
  const channels = CHANNELS[color];
  if (channels === undefined) throw new Error(`unsupported PNG colour type ${color}`);
  if (color === 3 && palette === null) throw new Error("palette PNG without PLTE");
  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== (stride + 1) * height) throw new Error("PNG data length does not match its header");

  // Undo the scanline filters.
  const lines = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? lines[dst + x - bpp] : 0;
      const b = y > 0 ? lines[dst - stride + x] : 0;
      const c = x >= bpp && y > 0 ? lines[dst - stride + x - bpp] : 0;
      const v = raw[src + x];
      let out;
      if (filter === 0) out = v;
      else if (filter === 1) out = v + a;
      else if (filter === 2) out = v + b;
      else if (filter === 3) out = v + ((a + b) >> 1);
      else if (filter === 4) out = v + paeth(a, b, c);
      else throw new Error(`unknown PNG filter ${filter}`);
      lines[dst + x] = out & 255;
    }
  }

  // Read one sample (0 .. 2^depth - 1) of a row.
  const maxValue = (1 << Math.min(depth, 8)) - 1;
  const sample = (y, index) => {
    const row = y * stride;
    if (depth === 8) return lines[row + index];
    if (depth === 16) return lines[row + index * 2];
    const perByte = 8 / depth;
    const byte = lines[row + Math.floor(index / perByte)];
    const shift = 8 - depth * ((index % perByte) + 1);
    return (byte >> shift) & maxValue;
  };
  const to8 = (v) => (depth >= 8 ? v : Math.round((v * 255) / maxValue));

  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r;
      let g;
      let b;
      if (color === 3) {
        const i = sample(y, x);
        r = palette[i * 3];
        g = palette[i * 3 + 1];
        b = palette[i * 3 + 2];
      } else if (color === 0 || color === 4) {
        r = g = b = to8(sample(y, x * channels));
      } else {
        r = to8(sample(y, x * channels));
        g = to8(sample(y, x * channels + 1));
        b = to8(sample(y, x * channels + 2));
      }
      const o = (y * width + x) * 3;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
    }
  }
  return { width, height, data };
}

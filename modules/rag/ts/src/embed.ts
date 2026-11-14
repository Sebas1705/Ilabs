import { invalidOptions, isIntAtLeast } from "./errors.js";
import { tokenizeDetailed } from "./tokenize.js";
import type { Embedder } from "./types.js";

/** Appends the UTF-8 bytes of one code point, written by hand; a lone surrogate encodes as U+FFFD (`EF BF BD`). */
export function pushUtf8(cp: number, out: number[]): void {
  const c = cp >= 0xd800 && cp <= 0xdfff ? 0xfffd : cp;
  if (c < 0x80) {
    out.push(c);
  } else if (c < 0x800) {
    out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
  } else if (c < 0x10000) {
    out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  } else {
    out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
}

/** UTF-8 bytes of a string, code point by code point (lone surrogates as U+FFFD). */
export function encodeUtf8(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) pushUtf8(ch.codePointAt(0)!, out);
  return out;
}

/** FNV-1a 32-bit over bytes; returns an unsigned 32-bit integer. */
export function fnv1a32(bytes: readonly number[]): number {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function checkDim(dim: number): void {
  if (!isIntAtLeast(dim, 1)) invalidOptions("dim must be an integer >= 1");
}

function embedValidated(text: string, dim: number): number[] {
  const v = new Array<number>(dim).fill(0);
  const bytes: number[] = [];
  for (const token of tokenizeDetailed(text)) {
    const w = [0x3c, ...token.codePoints, 0x3e];
    for (let i = 0; i + 2 < w.length; i++) {
      bytes.length = 0;
      pushUtf8(w[i]!, bytes);
      pushUtf8(w[i + 1]!, bytes);
      pushUtf8(w[i + 2]!, bytes);
      const h = fnv1a32(bytes);
      const bucket = h % dim;
      v[bucket] = v[bucket]! + (h >= 0x80000000 ? -1 : 1);
    }
  }
  let s = 0;
  for (let i = 0; i < dim; i++) s += v[i]! * v[i]!;
  if (s === 0) return v;
  const norm = Math.sqrt(s);
  for (let i = 0; i < dim; i++) v[i] = v[i]! / norm;
  return v;
}

/** The built-in character-trigram hashing embedder for one text (L2-normalized; no tokens gives the zero vector). */
export function hashEmbed(text: string, dim = 256): number[] {
  checkDim(dim);
  return embedValidated(text, dim);
}

/** An `Embedder` over `hashEmbed`; `dim` is validated here, at construction. */
export function hashEmbedder(dim = 256): Embedder {
  checkDim(dim);
  return {
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => embedValidated(t, dim));
    },
  };
}

import { invalidOptions } from "./errors.js";

/** Code points of `text`: a valid surrogate pair is one, every other UTF-16 unit (lone surrogates) is one on its own. */
export function toCodePoints(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) out.push(ch.codePointAt(0)!);
  return out;
}

/** The text of the code points `[start, end)`. */
export function fromCodePoints(cps: readonly number[], start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i++) out += String.fromCodePoint(cps[i]!);
  return out;
}

export const isDigit = (cp: number): boolean => cp >= 0x30 && cp <= 0x39;
export const isUpper = (cp: number): boolean => cp >= 0x41 && cp <= 0x5a;
export const isLower = (cp: number): boolean => cp >= 0x61 && cp <= 0x7a;
export const isLetter = (cp: number): boolean => isUpper(cp) || isLower(cp);
export const isAlnum = (cp: number): boolean => isDigit(cp) || isLetter(cp);

/** True for a non-null, non-array object. */
export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Runtime check of a `text` argument: anything but a string is `invalid_options`. */
export function requireText(text: unknown, what = "text"): string {
  if (typeof text !== "string") invalidOptions(`${what} must be a string`);
  return text;
}

/** Number of code points of `text`. */
export function codePointLength(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

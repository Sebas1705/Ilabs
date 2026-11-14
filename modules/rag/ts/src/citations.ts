import type { Citations, Source } from "./types.js";

const isAsciiDigit = (ch: string | undefined): boolean => ch !== undefined && ch.length === 1 && ch >= "0" && ch <= "9";

/**
 * Markers `[n]`: `[`, 1 to 9 ASCII digits (first not `0`), `]`. A marker is tried at every `[` and scanning always
 * continues at the next code point. Values in first-appearance order, deduplicated; `cited` are the values equal to
 * some source's `n`, `unknown` the others.
 */
export function extractCitations(answer: string, sources: Source[]): Citations {
  const cps: string[] = [];
  for (const ch of answer) cps.push(ch);
  const values: number[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < cps.length; i++) {
    if (cps[i] !== "[") continue;
    let j = i + 1;
    while (isAsciiDigit(cps[j])) j++;
    const digits = j - (i + 1);
    if (digits < 1 || digits > 9 || cps[i + 1] === "0" || cps[j] !== "]") continue;
    let n = 0;
    for (let k = i + 1; k < j; k++) n = n * 10 + (cps[k]!.charCodeAt(0) - 0x30);
    if (!seen.has(n)) {
      seen.add(n);
      values.push(n);
    }
  }
  const known = new Set(sources.map((s) => s.n));
  return { cited: values.filter((n) => known.has(n)), unknown: values.filter((n) => !known.has(n)) };
}

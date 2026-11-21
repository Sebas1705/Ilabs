/**
 * Slicing and splitting by code-point offsets. The library counts a valid surrogate pair as one code point and
 * every other UTF-16 unit, a lone surrogate included, as one on its own: the string iterator does exactly that.
 * Only rendering uses these helpers; every offset comes from the library. Callers that slice or split many times
 * convert the text once (`Array.from(text)`) and pass the array, so each call is linear in its own output.
 */

type Text = string | readonly string[];
const codePointsOf = (text: Text): readonly string[] => (typeof text === "string" ? Array.from(text) : text);

/** The text of the code points `[start, end)`; offsets outside the text are clamped. */
export function sliceCodePoints(text: Text, start: number, end: number): string {
  return codePointsOf(text).slice(Math.max(0, start), Math.max(0, end)).join("");
}

export interface Segment {
  text: string;
  /** Indexes of the spans that cover the whole segment, in the order they were given. */
  marks: number[];
}

/**
 * Splits `text` at every span boundary, so that each segment is covered by the same spans from start to end.
 * Spans may overlap; empty spans are ignored and spans outside the text are clamped. Joining the segments gives
 * `text` back. One sort and one sweep: O((n + spans) log spans) for ordinary, mostly disjoint spans.
 */
export function segmentText(text: Text, spans: readonly { start: number; end: number }[]): Segment[] {
  const cps = codePointsOf(text);
  const n = cps.length;
  const clamped = spans.map((s) => ({ start: Math.min(n, Math.max(0, s.start)), end: Math.min(n, Math.max(0, s.end)) }));
  const order: number[] = [];
  const cuts = new Set<number>([0, n]);
  clamped.forEach((s, i) => {
    if (s.end > s.start) {
      order.push(i);
      cuts.add(s.start);
      cuts.add(s.end);
    }
  });
  order.sort((a, b) => clamped[a]!.start - clamped[b]!.start || a - b);
  const bounds = [...cuts].sort((a, b) => a - b);
  const out: Segment[] = [];
  let active: number[] = [];
  let next = 0;
  for (let i = 0; i + 1 < bounds.length; i++) {
    const a = bounds[i]!;
    const b = bounds[i + 1]!;
    while (next < order.length && clamped[order[next]!]!.start <= a) active.push(order[next++]!);
    active = active.filter((m) => clamped[m]!.end >= b);
    out.push({ text: cps.slice(a, b).join(""), marks: active.length > 1 ? [...active].sort((x, y) => x - y) : [...active] });
  }
  return out;
}

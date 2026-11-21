import { METRIC_KINDS, type Span } from "@ilabs/guardrails";

export type SpanMark = "correct" | "miss" | "extra";
export interface MarkedSpan extends Span {
  mark: SpanMark;
}

const kindOrder = (kind: string): number => {
  const i = METRIC_KINDS.indexOf(kind);
  return i < 0 ? METRIC_KINDS.length : i;
};
const markOrder: Record<SpanMark, number> = { correct: 0, miss: 1, extra: 2 };

const keyOf = (s: Span): string => JSON.stringify([s.kind, s.start, s.end]);

/**
 * Marks each distinct span as correct (expected and found), missed (expected only) or extra (found only), with the
 * same equality as the library's `detectionMetrics`: kind, start and end must all match and duplicates count once.
 * Ordered by start, then end, then the library's metric-kind order, then correct, missed, extra. This is display only: the figures come from the library.
 */
export function markSpans(expected: readonly Span[], found: readonly Span[]): MarkedSpan[] {
  const expectedKeys = new Set(expected.map(keyOf));
  const foundKeys = new Set(found.map(keyOf));
  const seen = new Set<string>();
  const out: MarkedSpan[] = [];
  for (const s of [...expected, ...found]) {
    const key = keyOf(s);
    if (seen.has(key)) continue;
    seen.add(key);
    const mark: SpanMark = expectedKeys.has(key) && foundKeys.has(key) ? "correct" : expectedKeys.has(key) ? "miss" : "extra";
    out.push({ kind: s.kind, start: s.start, end: s.end, mark });
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end || kindOrder(a.kind) - kindOrder(b.kind) || markOrder[a.mark] - markOrder[b.mark]);
}

import { tokenizeSpans } from "@ilabs/rag";
import { INJECTION_TABLE, type DelimiterEntry, type TokenEntry } from "./injection-table.js";
import { requireText, toCodePoints } from "./scan.js";
import type { InjectionResult, InjectionSignal } from "./types.js";

export { INJECTION_TABLE } from "./injection-table.js";

interface PreparedToken {
  entry: TokenEntry;
  anchors: ReadonlySet<string>[];
}
interface PreparedDelimiter {
  entry: DelimiterEntry;
  literal: number[];
}

/** The table with anchors as sets and literals as code points, in table order. */
const PREPARED: ReadonlyArray<PreparedToken | PreparedDelimiter> = INJECTION_TABLE.map((entry) =>
  "anchors" in entry
    ? { entry, anchors: entry.anchors.map((alternatives) => new Set(alternatives)) }
    : { entry, literal: toCodePoints(entry.literal) },
);

const LF = 0x0a;
const CR = 0x0d;

function matchToken(p: PreparedToken, tokens: ReadonlyArray<{ token: string; start: number; end: number }>): InjectionSignal | null {
  const { entry, anchors } = p;
  const [first, ...rest] = anchors;
  for (let i0 = 0; i0 < tokens.length; i0++) {
    if (!first!.has(tokens[i0]!.token)) continue;
    let prev = i0;
    let ok = true;
    for (const anchor of rest) {
      let found = -1;
      const limit = Math.min(prev + 1 + entry.maxGap, tokens.length - 1);
      for (let t = prev + 1; t <= limit; t++) {
        if (anchor.has(tokens[t]!.token)) {
          found = t;
          break;
        }
      }
      if (found < 0) {
        ok = false;
        break;
      }
      prev = found;
    }
    if (ok) return { id: entry.id, category: entry.category, start: tokens[i0]!.start, end: tokens[prev]!.end };
  }
  return null;
}

function matchDelimiter(p: PreparedDelimiter, c: readonly number[]): InjectionSignal | null {
  const { entry, literal } = p;
  for (let i = 0; i + literal.length <= c.length; i++) {
    let ok = true;
    for (let k = 0; k < literal.length; k++) {
      if (c[i + k] !== literal[k]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (entry.lineStart && !(i === 0 || c[i - 1] === LF || c[i - 1] === CR)) continue;
    return { id: entry.id, category: entry.category, start: i, end: i + literal.length };
  }
  return null;
}

/** Lexical prompt-injection signals: the integer score (sum of matching weights, capped at 100) and the signals in table order. */
export function detectInjection(text: string): InjectionResult {
  requireText(text);
  const tokens = tokenizeSpans(text);
  const c = toCodePoints(text);
  const signals: InjectionSignal[] = [];
  let score = 0;
  for (const p of PREPARED) {
    const s = "anchors" in p ? matchToken(p, tokens) : matchDelimiter(p, c);
    if (s === null) continue;
    signals.push(s);
    score += p.entry.weight;
  }
  return { score: Math.min(100, score), signals };
}

import { invalidOptions } from "./errors.js";
import { isObject } from "./scan.js";
import type { KindMetrics, Metrics, Span } from "./types.js";

/** The ten metric kinds in their pinned order: the six PII kinds, then the four injection categories. */
export const METRIC_KINDS: readonly string[] = Object.freeze([
  "email",
  "phone",
  "iban",
  "card",
  "spanish_id",
  "secret",
  "override",
  "role_hijack",
  "prompt_leak",
  "delimiter",
]);

const KIND_SET: ReadonlySet<string> = new Set(METRIC_KINDS);

/** The distinct `kind|start|end` keys of a span list, grouped by kind (`invalid_options` for any other kind). */
function toSets(spans: unknown, what: string): Map<string, Set<string>> {
  if (!Array.isArray(spans)) invalidOptions(`${what} must be an array of spans`);
  const byKind = new Map<string, Set<string>>();
  for (const s of spans) {
    if (!isObject(s)) invalidOptions(`${what} must contain span objects`);
    const kind = s["kind"];
    if (typeof kind !== "string" || !KIND_SET.has(kind)) invalidOptions(`${what} has an unknown metric kind`);
    let set = byKind.get(kind);
    if (set === undefined) {
      set = new Set();
      byKind.set(kind, set);
    }
    set.add(`${String(s["start"])}|${String(s["end"])}`);
  }
  return byKind;
}

const ratios = (correct: number, expected: number, found: number) => ({
  precision: found === 0 ? 1 : correct / found,
  recall: expected === 0 ? 1 : correct / expected,
  f1: expected + found === 0 ? 1 : (2 * correct) / (expected + found),
});

/** Precision, recall and f1 of `found` against `expected` over sets of `(kind, start, end)` (one division per value). */
export function detectionMetrics(expected: Span[], found: Span[]): Metrics {
  const e = toSets(expected, "expected");
  const f = toSets(found, "found");
  let nE = 0;
  let nF = 0;
  let correct = 0;
  const byKind: KindMetrics[] = [];
  for (const kind of METRIC_KINDS) {
    const ek = e.get(kind);
    const fk = f.get(kind);
    if (ek === undefined && fk === undefined) continue;
    const ne = ek?.size ?? 0;
    const nf = fk?.size ?? 0;
    let c = 0;
    if (fk !== undefined && ek !== undefined) for (const key of fk) if (ek.has(key)) c++;
    nE += ne;
    nF += nf;
    correct += c;
    byKind.push({ kind, ...ratios(c, ne, nf), expected: ne, found: nf, correct: c });
  }
  return { ...ratios(correct, nE, nF), byKind };
}

import { invalidOptions } from "./errors.js";
import { PII_KINDS } from "./pii.js";
import { fromCodePoints, isDigit, isObject, requireText, toCodePoints } from "./scan.js";
import type { Mapping, PiiFinding, PiiKind } from "./types.js";

/** Placeholder names as `[kind, NAME]` pairs in kind order: a finding becomes `<NAME_n>`. */
export const PLACEHOLDER_NAMES: readonly (readonly [PiiKind, string])[] = Object.freeze([
  Object.freeze(["email", "EMAIL"] as const),
  Object.freeze(["phone", "PHONE"] as const),
  Object.freeze(["iban", "IBAN"] as const),
  Object.freeze(["card", "CARD"] as const),
  Object.freeze(["spanish_id", "SPANISH_ID"] as const),
  Object.freeze(["secret", "SECRET"] as const),
]);

const NAMES = new Map<string, string>(PLACEHOLDER_NAMES);

/** The `n` of a placeholder that is exactly `<NAME_n>` (decimal, `1 <= n`, at most 9 digits, no leading zeros); `-1` for any other shape. */
export function placeholderNumber(placeholder: string, name: string): number {
  const prefix = `<${name}_`;
  if (!placeholder.startsWith(prefix) || !placeholder.endsWith(">")) return -1;
  const digits = placeholder.slice(prefix.length, placeholder.length - 1);
  // More than 9 digits is out of scope (32-bit numbering): such a shape is ignored like a foreign one.
  if (digits.length === 0 || digits.length > 9 || digits.charCodeAt(0) === 0x30) return -1;
  for (let i = 0; i < digits.length; i++) if (!isDigit(digits.charCodeAt(i))) return -1;
  return Number(digits);
}

/** Validates a mapping argument (an array of `[placeholder, original]` string pairs) and returns a fresh copy. */
export function parseMapping(v: unknown, what = "mapping"): Mapping {
  if (!Array.isArray(v)) invalidOptions(`${what} must be an array of [placeholder, original] pairs`);
  return v.map((entry): [string, string] => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string") {
      invalidOptions(`${what} entries must be [placeholder, original] string pairs`);
    }
    return [entry[0], entry[1]];
  });
}

const KIND_SET: ReadonlySet<string> = new Set(PII_KINDS);

/** Validates findings for `redact`: ordered by start, not overlapping, inside the text, `text` equal to the slice. */
function checkFindings(cps: readonly number[], findings: unknown): PiiFinding[] {
  if (!Array.isArray(findings)) invalidOptions("findings must be an array");
  let last = 0;
  return findings.map((f, i): PiiFinding => {
    if (!isObject(f)) invalidOptions(`finding ${i} must be an object`);
    const { kind, start, end, text } = f;
    if (typeof kind !== "string" || !KIND_SET.has(kind)) invalidOptions(`finding ${i} has an unknown kind`);
    if (typeof start !== "number" || typeof end !== "number" || !Number.isInteger(start) || !Number.isInteger(end)) {
      invalidOptions(`finding ${i} needs integer start and end`);
    }
    if (typeof text !== "string") invalidOptions(`finding ${i} needs a text`);
    if (start < 0 || end < start || end > cps.length) invalidOptions(`finding ${i} is outside the text`);
    if (start < last) invalidOptions(`finding ${i} is unsorted or overlaps the previous one`);
    if (fromCodePoints(cps, start, end) !== text) invalidOptions(`finding ${i} text differs from the slice`);
    last = end;
    return { kind: kind as PiiKind, start, end, text };
  });
}

/**
 * Replaces the findings of `cps` with placeholders. `existing` seeds the numbering (largest `n` per kind); its entries
 * are reused for an equal original of the same kind only when `reuseExisting` is set. Returns the new text and the
 * entries created by this call, in creation order.
 */
export function redactCore(
  cps: readonly number[],
  findings: readonly PiiFinding[],
  existing: Mapping,
  reuseExisting: boolean,
): { text: string; created: Mapping } {
  const next = new Map<string, number>();
  for (const [kind, name] of PLACEHOLDER_NAMES) {
    let max = 0;
    for (const [placeholder] of existing) max = Math.max(max, placeholderNumber(placeholder, name));
    next.set(kind, max + 1);
  }
  const created: Mapping = [];
  let out = "";
  let at = 0;
  for (const f of findings) {
    const name = NAMES.get(f.kind)!;
    let placeholder: string | undefined;
    if (reuseExisting) {
      for (const [p, original] of existing) {
        if (original === f.text && placeholderNumber(p, name) >= 0) {
          placeholder = p;
          break;
        }
      }
    }
    if (placeholder === undefined) {
      for (const [p, original] of created) {
        if (original === f.text && placeholderNumber(p, name) >= 0) {
          placeholder = p;
          break;
        }
      }
    }
    if (placeholder === undefined) {
      const n = next.get(f.kind)!;
      placeholder = `<${name}_${n}>`;
      next.set(f.kind, n + 1);
      created.push([placeholder, f.text]);
    }
    out += fromCodePoints(cps, at, f.start) + placeholder;
    at = f.end;
  }
  out += fromCodePoints(cps, at, cps.length);
  return { text: out, created };
}

/** Replaces findings with reversible placeholders; the given mapping is extended (never modified) and reused. */
export function redact(text: string, findings: PiiFinding[], mapping?: Mapping): { text: string; mapping: Mapping } {
  requireText(text);
  const cps = toCodePoints(text);
  const checked = checkFindings(cps, findings);
  const base = mapping === undefined ? [] : parseMapping(mapping);
  const r = redactCore(cps, checked, base, true);
  return { text: r.text, mapping: [...base, ...r.created] };
}

/** Restores originals in one left-to-right pass (longest placeholder wins, the result is never re-scanned). */
export function restore(text: string, mapping: Mapping): string {
  requireText(text);
  const entries = parseMapping(mapping);
  const byFirst = new Map<number, Array<{ cps: number[]; original: string }>>();
  const seen = new Set<string>();
  for (const [placeholder, original] of entries) {
    if (placeholder === "" || seen.has(placeholder)) continue;
    seen.add(placeholder);
    const cps = toCodePoints(placeholder);
    const list = byFirst.get(cps[0]!);
    if (list === undefined) byFirst.set(cps[0]!, [{ cps, original }]);
    else list.push({ cps, original });
  }
  const c = toCodePoints(text);
  let out = "";
  let i = 0;
  while (i < c.length) {
    let best: { cps: number[]; original: string } | undefined;
    for (const e of byFirst.get(c[i]!) ?? []) {
      if (i + e.cps.length > c.length) continue;
      let ok = true;
      for (let k = 0; k < e.cps.length; k++) {
        if (c[i + k] !== e.cps[k]) {
          ok = false;
          break;
        }
      }
      if (ok && (best === undefined || e.cps.length > best.cps.length)) best = e;
    }
    if (best === undefined) {
      out += String.fromCodePoint(c[i]!);
      i++;
    } else {
      out += best.original;
      i += best.cps.length;
    }
  }
  return out;
}

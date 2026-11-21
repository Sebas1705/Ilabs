import { invalidOptions } from "./errors.js";
import { fromCodePoints, isAlnum, isDigit, isLetter, isLower, isObject, isUpper, requireText, toCodePoints } from "./scan.js";
import type { PiiFinding, PiiKind } from "./types.js";

/** The PII kinds in their pinned kind order. */
export const PII_KINDS: readonly PiiKind[] = Object.freeze(["email", "phone", "iban", "card", "spanish_id", "secret"] as const);

/** Secret prefixes (case-sensitive), in pinned order. */
export const SECRET_PREFIXES: readonly string[] = Object.freeze(["sk-", "pk-", "ghp_", "gho_", "github_pat_", "AKIA", "AIza", "xoxb-", "xoxp-"]);

/** Control letters of the Spanish DNI/NIE, indexed by `N mod 23`. */
export const DNI_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";

const KIND_SET: ReadonlySet<string> = new Set(PII_KINDS);
const SECRET_PREFIX_CPS: readonly (readonly number[])[] = SECRET_PREFIXES.map((p) => toCodePoints(p));

const DOT = 0x2e;
const SPACE = 0x20;
const HYPHEN = 0x2d;
const PLUS = 0x2b;
const UNDERSCORE = 0x5f;
const AT = 0x40;
const PERCENT = 0x25;

/** Luhn check over digit code points: positions count from the right, even positions are doubled. */
export function luhnValid(digitCps: readonly number[]): boolean {
  let sum = 0;
  for (let i = 0; i < digitCps.length; i++) {
    const pos = digitCps.length - i;
    let d = digitCps[i]! - 0x30;
    if (pos % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** IBAN mod-97 check over upper-case letters and digits, digit by digit, no big integers. */
export function ibanMod97Valid(chars: readonly number[]): boolean {
  let r = 0;
  const feed = (cp: number): void => {
    if (isDigit(cp)) {
      r = (r * 10 + (cp - 0x30)) % 97;
    } else {
      const n = cp - 55;
      r = (r * 10 + Math.floor(n / 10)) % 97;
      r = (r * 10 + (n % 10)) % 97;
    }
  };
  for (let i = 4; i < chars.length; i++) feed(chars[i]!);
  for (let i = 0; i < 4 && i < chars.length; i++) feed(chars[i]!);
  return r === 1;
}

/** Per-scan shared state: the end of the body run at every offset, computed once (one pass) for the secret scanner. */
interface ScanContext {
  bodyEnd: Int32Array | null;
}

type Scanner = (c: readonly number[], p: number, ctx: ScanContext) => number;

const isLocal = (cp: number): boolean => isAlnum(cp) || cp === UNDERSCORE || cp === PERCENT || cp === PLUS || cp === HYPHEN;
const isLabel = (cp: number): boolean => isAlnum(cp) || cp === HYPHEN;

const scanEmail: Scanner = (c, p) => {
  const L = c.length;
  if (p > 0) {
    const prev = c[p - 1]!;
    if (prev === DOT || prev === UNDERSCORE || prev === PERCENT || prev === PLUS || prev === HYPHEN || prev === AT) return -1;
  }
  if (!isLocal(c[p]!)) return -1;
  let i = p;
  while (i < L && isLocal(c[i]!)) i++;
  while (i + 1 < L && c[i] === DOT && isLocal(c[i + 1]!)) {
    i++;
    while (i < L && isLocal(c[i]!)) i++;
  }
  if (i >= L || c[i] !== AT) return -1;
  i++;
  if (i >= L || !isLabel(c[i]!)) return -1;
  let labels = 1;
  let labelStart = i;
  while (i < L && isLabel(c[i]!)) i++;
  while (i + 1 < L && c[i] === DOT && isLabel(c[i + 1]!)) {
    i++;
    labelStart = i;
    labels++;
    while (i < L && isLabel(c[i]!)) i++;
  }
  if (labels < 2 || i - labelStart < 2) return -1;
  for (let k = labelStart; k < i; k++) if (!isLetter(c[k]!)) return -1;
  return i;
};

/**
 * Consumes digit groups from a digit at `i`: a single separator is taken only when a digit follows it. Returns the
 * end, or -1 as soon as more than `maxDigits` digits were consumed (such a run is invalid whatever follows).
 */
function digitGroups(c: readonly number[], i: number, isSep: (cp: number) => boolean, maxDigits: number): number {
  const L = c.length;
  let digits = 0;
  for (;;) {
    while (i < L && isDigit(c[i]!)) {
      i++;
      if (++digits > maxDigits) return -1;
    }
    if (i + 1 < L && isSep(c[i]!) && isDigit(c[i + 1]!)) i++;
    else return i;
  }
}

const isPhoneSep = (cp: number): boolean => cp === SPACE || cp === DOT || cp === HYPHEN;
const isCardSep = (cp: number): boolean => cp === SPACE || cp === HYPHEN;

const scanPhone: Scanner = (c, p) => {
  let i = p;
  const plus = c[p] === PLUS;
  if (plus) {
    if (p + 1 >= c.length || !isDigit(c[p + 1]!)) return -1;
    i++;
  } else if (!isDigit(c[p]!)) {
    return -1;
  }
  const firstDigit = c[i]!;
  const end = digitGroups(c, i, isPhoneSep, plus ? 15 : 9);
  if (end < 0) return -1;
  let d = 0;
  for (let k = i; k < end; k++) if (isDigit(c[k]!)) d++;
  if (plus) return d >= 8 ? end : -1;
  const f = firstDigit - 0x30;
  return d === 9 && f >= 6 && f <= 9 ? end : -1;
};

const scanIban: Scanner = (c, p) => {
  const L = c.length;
  const isIbanChar = (cp: number): boolean => isUpper(cp) || isDigit(cp);
  if (!isIbanChar(c[p]!)) return -1;
  let i = p;
  let chars = 0;
  for (;;) {
    while (i < L && isIbanChar(c[i]!)) {
      i++;
      if (++chars > 34) return -1;
    }
    if (i + 1 < L && c[i] === SPACE && isIbanChar(c[i + 1]!)) i++;
    else break;
  }
  const compact: number[] = [];
  for (let k = p; k < i; k++) if (c[k] !== SPACE) compact.push(c[k]!);
  if (compact.length < 15 || compact.length > 34) return -1;
  if (!isUpper(compact[0]!) || !isUpper(compact[1]!) || !isDigit(compact[2]!) || !isDigit(compact[3]!)) return -1;
  return ibanMod97Valid(compact) ? i : -1;
};

const scanCard: Scanner = (c, p) => {
  if (!isDigit(c[p]!)) return -1;
  const end = digitGroups(c, p, isCardSep, 19);
  if (end < 0) return -1;
  const digits: number[] = [];
  for (let k = p; k < end; k++) if (isDigit(c[k]!)) digits.push(c[k]!);
  if (digits.length < 13) return -1;
  return luhnValid(digits) ? end : -1;
};

const scanSpanishId: Scanner = (c, p) => {
  const L = c.length;
  let i = p;
  let prefix = -1;
  const first = c[p]!;
  const upper = isLower(first) ? first - 0x20 : first;
  if (upper === 0x58 || upper === 0x59 || upper === 0x5a) {
    prefix = upper - 0x58;
    i++;
  } else if (!isDigit(first)) {
    return -1;
  }
  const digitsStart = i;
  while (i < L && isDigit(c[i]!)) i++;
  const count = i - digitsStart;
  if (count !== (prefix >= 0 ? 7 : 8)) return -1;
  let n = prefix >= 0 ? prefix : 0;
  for (let k = digitsStart; k < i; k++) n = n * 10 + (c[k]! - 0x30);
  if (i + 1 < L && c[i] === HYPHEN && isLetter(c[i + 1]!)) i++;
  else if (!(i < L && isLetter(c[i]!))) return -1;
  const letter = isLower(c[i]!) ? c[i]! - 0x20 : c[i]!;
  if (letter !== DNI_LETTERS.charCodeAt(n % 23)) return -1;
  return i + 1;
};

const isBody = (cp: number): boolean => isAlnum(cp) || cp === UNDERSCORE || cp === HYPHEN;

const scanSecret: Scanner = (c, p, ctx) => {
  for (const prefix of SECRET_PREFIX_CPS) {
    if (p + prefix.length > c.length) continue;
    let match = true;
    for (let k = 0; k < prefix.length; k++) {
      if (c[p + k] !== prefix[k]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    if (ctx.bodyEnd === null) {
      const ends = new Int32Array(c.length + 1);
      ends[c.length] = c.length;
      for (let k = c.length - 1; k >= 0; k--) ends[k] = isBody(c[k]!) ? ends[k + 1]! : k;
      ctx.bodyEnd = ends;
    }
    const start = p + prefix.length;
    const end = ctx.bodyEnd[start]!;
    return end - start >= 16 ? end : -1;
  }
  return -1;
};

const SCANNERS: Record<PiiKind, Scanner> = {
  email: scanEmail,
  phone: scanPhone,
  iban: scanIban,
  card: scanCard,
  spanish_id: scanSpanishId,
  secret: scanSecret,
};

/** Validates the `kinds` option: a non-empty array of distinct PII kind names (`invalid_options` otherwise). */
function parseKinds(v: unknown): readonly PiiKind[] {
  if (!Array.isArray(v)) invalidOptions("kinds must be an array of PII kind names");
  if (v.length === 0) invalidOptions("kinds must not be empty");
  const seen = new Set<string>();
  for (const k of v) {
    if (typeof k !== "string" || !KIND_SET.has(k)) invalidOptions("kinds has an unknown PII kind");
    if (seen.has(k)) invalidOptions(`kinds has a duplicate kind: ${k}`);
    seen.add(k);
  }
  return PII_KINDS.filter((k) => seen.has(k));
}

/**
 * Overlap resolution: sort by start, then longer first, then kind order; walk once and accept a candidate when it
 * starts at or after the end of the last ACCEPTED one (a rejected candidate blocks nothing). Exact duplicates
 * (same kind, start, end) are dropped first. Returns the accepted candidates; the input list is not mutated.
 */
export function resolveOverlaps<T extends { kind: string; start: number; end: number }>(candidates: readonly T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const c of candidates) {
    const key = `${c.kind}|${c.start}|${c.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
  }
  const order = (kind: string): number => {
    const i = PII_KINDS.indexOf(kind as PiiKind);
    return i < 0 ? PII_KINDS.length : i;
  };
  unique.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || order(a.kind) - order(b.kind));
  const accepted: T[] = [];
  let lastEnd = -1;
  for (const c of unique) {
    if (accepted.length === 0 || c.start >= lastEnd) {
      accepted.push(c);
      lastEnd = c.end;
    }
  }
  return accepted;
}

/** Finds personal data and secrets in `text` (code-point offsets, ordered by start, never overlapping). */
export function detectPii(text: string, options?: { kinds?: PiiKind[] }): PiiFinding[] {
  requireText(text);
  if (options !== undefined && !isObject(options)) invalidOptions("options must be an object");
  const requested = options?.kinds;
  const kinds = requested === undefined ? PII_KINDS : parseKinds(requested);
  const c = toCodePoints(text);
  const L = c.length;
  const ctx: ScanContext = { bodyEnd: null };
  const candidates: Array<{ kind: PiiKind; start: number; end: number }> = [];
  for (const kind of kinds) {
    const scan = SCANNERS[kind];
    for (let p = 0; p < L; p++) {
      if (p > 0 && isAlnum(c[p - 1]!)) continue;
      const end = scan(c, p, ctx);
      if (end < 0) continue;
      if (end < L && isAlnum(c[end]!)) continue;
      candidates.push({ kind, start: p, end });
    }
  }
  return resolveOverlaps(candidates).map((f) => ({ kind: f.kind, start: f.start, end: f.end, text: fromCodePoints(c, f.start, f.end) }));
}

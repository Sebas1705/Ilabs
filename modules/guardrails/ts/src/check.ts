import { tokenizeSpans } from "@ilabs/rag";
import { GuardrailError, invalidOptions } from "./errors.js";
import { detectInjection } from "./injection.js";
import { detectPii, resolveOverlaps } from "./pii.js";
import { parseMapping, redact } from "./placeholders.js";
import { parseChecks } from "./policy.js";
import { codePointLength, isObject, requireText, toCodePoints } from "./scan.js";
import type { Check, CheckDetails, CheckFinding, CheckResult, Classifier, DenyMatch, Mapping, PiiFinding } from "./types.js";

/** Validates the optional classifier argument: absent or a function (`null` is a bad value). */
export function parseClassifier(v: unknown): Classifier | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "function") invalidOptions("classifier must be a function");
  return v as Classifier;
}

/** Fails with `no_classifier` when some check is a classifier check and no classifier was given. */
export function requireClassifierFor(checks: readonly Check[], classifier: Classifier | undefined): void {
  if (classifier === undefined && checks.some((c) => c.kind === "classifier")) {
    throw new GuardrailError("no_classifier", "a classifier check needs a classifier");
  }
}

function denyMatches(terms: readonly string[], tokens: ReadonlyArray<{ token: string; start: number; end: number }>): DenyMatch[] {
  const found: Array<DenyMatch & { index: number }> = [];
  terms.forEach((term, index) => {
    const u = tokenizeSpans(term).map((t) => t.token);
    const m = u.length;
    let i = 0;
    while (i + m <= tokens.length) {
      let hit = true;
      for (let j = 0; j < m; j++) {
        if (tokens[i + j]!.token !== u[j]) {
          hit = false;
          break;
        }
      }
      if (hit) {
        found.push({ term, start: tokens[i]!.start, end: tokens[i + m - 1]!.end, index });
        i += m;
      } else {
        i++;
      }
    }
  });
  found.sort((a, b) => a.start - b.start || a.index - b.index);
  return found.map((f) => ({ term: f.term, start: f.start, end: f.end }));
}

/** True when the code point sequence `needle` occurs in `hay` (a lone surrogate never matches inside a pair). */
function containsCodePoints(hay: readonly number[], needle: readonly number[]): boolean {
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let k = 0;
    while (k < needle.length && hay[i + k] === needle[k]) k++;
    if (k === needle.length) return true;
  }
  return false;
}

/** Evaluates validated checks on the ORIGINAL text: every check runs, none sees another's output. */
export async function evaluateChecks(
  text: string,
  checks: readonly Check[],
  classifier: Classifier | undefined,
): Promise<{ verdict: "allow" | "block"; findings: CheckFinding[] }> {
  let tokens: ReturnType<typeof tokenizeSpans> | undefined;
  let cps: number[] | undefined;
  const findings: CheckFinding[] = [];
  for (let i = 0; i < checks.length; i++) {
    const check = checks[i]!;
    let fired: boolean;
    let details: CheckDetails;
    switch (check.kind) {
      case "pii": {
        const list = detectPii(text, check.kinds === undefined ? undefined : { kinds: [...check.kinds] });
        details = { findings: list };
        fired = list.length > 0;
        break;
      }
      case "injection": {
        const r = detectInjection(text);
        details = { score: r.score, signals: r.signals };
        fired = r.score >= check.threshold;
        break;
      }
      case "denyTerms": {
        tokens ??= tokenizeSpans(text);
        const matches = denyMatches(check.terms, tokens);
        details = { matches };
        fired = matches.length > 0;
        break;
      }
      case "maxLength": {
        const length = codePointLength(text);
        details = { length };
        fired = length > check.max;
        break;
      }
      case "canary": {
        cps ??= toCodePoints(text);
        const found = containsCodePoints(cps, toCodePoints(check.canary));
        details = { found };
        fired = found;
        break;
      }
      case "classifier": {
        const a: unknown = await classifier!(text);
        if (!isObject(a) || typeof a["flagged"] !== "boolean") invalidOptions("the classifier must answer { flagged, label? }");
        const label = a["label"];
        details = typeof label === "string" ? { flagged: a["flagged"], label } : { flagged: a["flagged"] };
        fired = a["flagged"] && (check.label === undefined || label === check.label);
        break;
      }
    }
    findings.push({ check: i, kind: check.kind, action: check.action, fired, details });
  }
  const verdict = findings.some((f) => f.fired && f.action === "block") ? "block" : "allow";
  return { verdict, findings };
}

/** The deduplicated, overlap-resolved union of the findings of the firing `redact` checks. */
export function redactionFindings(findings: readonly CheckFinding[]): PiiFinding[] | null {
  const union: PiiFinding[] = [];
  let any = false;
  for (const f of findings) {
    if (f.kind === "pii" && f.action === "redact" && f.fired) {
      any = true;
      union.push(...(f.details as { findings: PiiFinding[] }).findings);
    }
  }
  return any ? resolveOverlaps(union) : null;
}

/** Evaluates `checks` on `text`; the redacted text is one `redact` over the union of the firing redact checks. */
export async function checkText(
  text: string,
  checks: Check[],
  options?: { mapping?: Mapping; classifier?: Classifier },
): Promise<CheckResult> {
  requireText(text);
  const list = parseChecks(checks, "checks");
  if (options !== undefined && !isObject(options)) invalidOptions("options must be an object");
  const mapping = options?.mapping === undefined ? [] : parseMapping(options.mapping);
  const classifier = parseClassifier(options?.classifier);
  requireClassifierFor(list, classifier);
  const { verdict, findings } = await evaluateChecks(text, list, classifier);
  const resolved = redactionFindings(findings);
  if (resolved === null) return { verdict, text, mapping, findings };
  const r = redact(text, resolved, mapping);
  return { verdict, text: r.text, mapping: r.mapping, findings };
}

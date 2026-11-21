import {
  GuardrailError,
  checkText,
  detectInjection,
  detectPii,
  parsePolicy,
  redact,
  runFixture,
  type CheckResult,
  type Fixture,
  type GuardedResult,
  type InjectionResult,
  type Mapping,
  type Metrics,
  type PiiFinding,
  type Span,
} from "@ilabs/guardrails";
import type { Message } from "@ilabs/providers";
import { isAllKinds, type Controls } from "./guardrailsFixtures";
import { markSpans, type MarkedSpan } from "./spanCompare";

/** A library error as the page keeps it: the kind and the library's own reason. */
export interface RunError {
  kind: string;
  detail: string;
}

/** `Number` of what was typed; an empty field is not a number (it would read as 0 otherwise). The library validates the value. */
const numberOf = (text: string): number => (text.trim() === "" ? Number.NaN : Number(text));

/**
 * The checks the toggles stand for, as the raw JSON a policy is parsed from: PII, injection, denied terms and
 * maximum length, in that order, each only when its action is not `off`. Nothing is validated here: `parsePolicy` does it.
 */
export function buildChecks(c: Controls): unknown[] {
  const checks: unknown[] = [];
  if (c.pii.action !== "off") {
    checks.push({ kind: "pii", action: c.pii.action, ...(isAllKinds(c.pii.kinds) ? {} : { kinds: c.pii.kinds }) });
  }
  if (c.injection.action !== "off") checks.push({ kind: "injection", action: c.injection.action, threshold: numberOf(c.injection.threshold) });
  if (c.deny.action !== "off") {
    const terms = c.deny.terms
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "");
    checks.push({ kind: "denyTerms", action: c.deny.action, terms });
  }
  if (c.maxLength.action !== "off") checks.push({ kind: "maxLength", action: c.maxLength.action, max: numberOf(c.maxLength.max) });
  return checks;
}

/** Everything the playground shows for one text and one set of toggles; every figure comes from the library. */
export interface PlaygroundView {
  /** The text the figures below belong to (a view stays on screen while the next run is pending). */
  text: string;
  findings: PiiFinding[];
  redacted: { text: string; mapping: Mapping };
  injection: InjectionResult;
  /** The verdict and the findings of each check; null while the policy or the scan options are invalid. */
  check: CheckResult | null;
  error: RunError | null;
}

const toError = (e: GuardrailError): RunError => ({ kind: e.kind, detail: e.message });

/**
 * Scans the text (`detectPii`, `redact`, `detectInjection`), parses the toggles as a policy and evaluates it
 * (`checkText`). A `GuardrailError` becomes `view.error`; anything else rejects.
 */
export async function runPlayground(text: string, controls: Controls): Promise<PlaygroundView> {
  const view: PlaygroundView = { text, findings: [], redacted: { text, mapping: [] }, injection: { score: 0, signals: [] }, check: null, error: null };
  // Each part has its own try: a failure of the PII scan (an invalid kinds list) must not hide the injection
  // result, which does not depend on it. The first library error is the one shown.
  const attempt = (step: () => void): void => {
    try {
      step();
    } catch (e) {
      if (!(e instanceof GuardrailError)) throw e;
      view.error ??= toError(e);
    }
  };
  attempt(() => {
    const kinds = controls.pii.kinds;
    view.findings = detectPii(text, isAllKinds(kinds) ? undefined : { kinds });
    view.redacted = redact(text, view.findings, []);
  });
  attempt(() => {
    view.injection = detectInjection(text);
  });
  if (view.error === null) {
    try {
      const policy = parsePolicy({ input: [], output: buildChecks(controls) });
      view.check = await checkText(text, policy.output);
    } catch (e) {
      if (!(e instanceof GuardrailError)) throw e;
      view.error = toError(e);
    }
  }
  return view;
}

/** What a guarded sample ended in: the library's result, or the error the call ended with (no result). */
export type GuardedOutcome = { kind: "result"; result: GuardedResult } | { kind: "error"; errorKind: string; calls: number; sent: Message[] | null };

export interface GuardedView {
  /** The request as the fixture wrote it. */
  request: Message[];
  /** The scripted reply the single provider call consumed; null when no call was made or it failed. */
  reply: string | null;
  outcome: GuardedOutcome;
}

/** Runs the fixture through the harness (`runFixture`: `guardedComplete` over the scripted provider) and keeps its result. */
export async function runGuardedSample(fixture: Fixture): Promise<GuardedView> {
  const run = await runFixture(fixture);
  const request = (fixture.setup.request as { messages: Message[] }).messages;
  const script = (fixture.setup.provider as { script: { response?: string }[] }).script;
  if (run.output?.kind === "guarded") {
    const { result } = run.output;
    return { request, reply: result.calls === 1 ? (script[0]?.response ?? null) : null, outcome: { kind: "result", result } };
  }
  return { request, reply: null, outcome: { kind: "error", errorKind: run.error?.kind ?? "unknown", calls: run.calls, sent: run.requests[0]?.messages ?? null } };
}

export interface EvalSampleView {
  text: string;
  spans: MarkedSpan[];
}

export interface EvalView {
  pii: Metrics;
  injection: Metrics;
  samples: EvalSampleView[];
}

/**
 * The metrics of an eval fixture come from the harness (`detectionMetrics` over `detectPii` and `detectInjection`);
 * each sample's expected spans are then set against what the detectors find in it, span by span.
 */
export async function runEvalSample(fixture: Fixture): Promise<EvalView> {
  const run = await runFixture(fixture);
  if (run.output?.kind !== "eval") throw new Error(`the fixture ${fixture.name} did not produce metrics${run.error ? ` (${run.error.kind})` : ""}`);
  const samples = (fixture.setup.samples as { text: string; expected: Span[] }[]).map((s) => {
    const found: Span[] = [
      ...detectPii(s.text).map((f) => ({ kind: f.kind, start: f.start, end: f.end })),
      ...detectInjection(s.text).signals.map((g) => ({ kind: g.category, start: g.start, end: g.end })),
    ];
    return { text: s.text, spans: markSpans(s.expected, found) };
  });
  return { pii: run.output.pii, injection: run.output.injection, samples };
}

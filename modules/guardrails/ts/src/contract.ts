import { MockProvider, ProviderError, type CompletionRequest, type CompletionResponse, type Provider, type ScriptEntry } from "@ilabs/providers";
import { withCanary, CANARY_PREFIX, CANARY_SUFFIX, CANARY_WHITESPACE } from "./canary.js";
import { checkText } from "./check.js";
import { GuardrailError } from "./errors.js";
import { DEFAULT_BLOCKED_TEXT, GuardedProvider, guardedComplete } from "./guarded.js";
import { INJECTION_TABLE, detectInjection } from "./injection.js";
import { METRIC_KINDS, detectionMetrics } from "./metrics.js";
import { DNI_LETTERS, PII_KINDS, SECRET_PREFIXES, detectPii } from "./pii.js";
import { PLACEHOLDER_NAMES, redact, restore } from "./placeholders.js";
import { parsePolicy } from "./policy.js";
import { codePointLength } from "./scan.js";
import type { CheckResult, Classifier, GuardedResult, InjectionSignal, Mapping, Message, Metrics, PiiFinding, PiiKind, Policy, Span } from "./types.js";

/** A parsed `contracts/guardrails/*.json` file (checked by `runFixture` itself, so it may be malformed). */
export interface Fixture {
  name: string;
  setup: { kind: string } & Record<string, unknown>;
  expect: Record<string, unknown>;
}

/** An error reported by the library: a `GuardrailError` kind or a provider error kind. */
export interface FixtureError {
  kind: string;
}

/** The second run of a `guarded` fixture: `GuardedProvider.complete`. */
export interface ProviderRun {
  id: string;
  /** `null` when the call failed. */
  response: CompletionResponse | null;
  error: FixtureError | null;
  lastReport: GuardedResult | undefined;
  calls: number;
  requests: CompletionRequest[];
  classifierInputs: string[] | null;
}

/** The actual outputs of a fixture, per kind. */
export type FixtureOutput =
  | { kind: "pii"; findings: PiiFinding[] }
  | { kind: "redact"; text: string; mapping: Mapping }
  | { kind: "restore"; text: string }
  | { kind: "injection"; score: number; signals: InjectionSignal[] }
  | ({ kind: "check" } & CheckResult)
  | { kind: "policy"; policy: Policy }
  | { kind: "guarded"; result: GuardedResult }
  | { kind: "canary"; messages: Message[] }
  | ({ kind: "metrics" } & Metrics)
  | { kind: "eval"; pii: Metrics; injection: Metrics }
  | { kind: "table"; table: Record<string, unknown> };

export interface FixtureRun {
  kind: string;
  /** `null` when the library reported an error. */
  output: FixtureOutput | null;
  /** `null` when the run succeeded. */
  error: FixtureError | null;
  /** Provider `complete()` invocations of the first run (`guarded`), including a failing one. */
  calls: number;
  /** Every request the provider received in the first run, in order. */
  requests: CompletionRequest[];
  /** The texts the classifier received in the first run; `null` without a classifier. */
  classifierInputs: string[] | null;
  /** `GuardedProvider` run of a `guarded` fixture; `null` for every other kind. */
  second: ProviderRun | null;
}

type Obj = Record<string, unknown>;

function invalid(reason: string): never {
  throw new Error(`invalid fixture: ${reason}`);
}

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Rejects unknown keys, then missing required keys, of a raw JSON object. */
function shape(o: Obj, required: readonly string[], optional: readonly string[]): void {
  for (const k of Object.keys(o)) if (!required.includes(k) && !optional.includes(k)) invalid(`unknown key: ${k}`);
  for (const k of required) if (!Object.hasOwn(o, k)) invalid(`missing key: ${k}`);
}

function object(v: unknown, key: string): Obj {
  if (!isObj(v)) invalid(`wrong type: ${key}`);
  return v;
}
function array(v: unknown, key: string): unknown[] {
  if (!Array.isArray(v)) invalid(`wrong type: ${key}`);
  return v;
}
function str(v: unknown, key: string): string {
  if (typeof v !== "string") invalid(`wrong type: ${key}`);
  return v;
}
function int(v: unknown, key: string): number {
  if (typeof v !== "number" || !Number.isInteger(v)) invalid(`wrong type: ${key}`);
  return v;
}

interface KindSpec {
  required: string[];
  optional: string[];
  expect: string[];
  expectOptional: string[];
}

const SPECS: ReadonlyMap<string, KindSpec> = new Map<string, KindSpec>([
  ["pii", { required: ["text"], optional: ["kinds"], expect: ["findings"], expectOptional: [] }],
  ["redact", { required: ["text"], optional: ["kinds", "mapping"], expect: ["text", "mapping"], expectOptional: [] }],
  ["restore", { required: ["text", "mapping"], optional: [], expect: ["text"], expectOptional: [] }],
  ["injection", { required: ["text"], optional: [], expect: ["score", "signals"], expectOptional: [] }],
  ["check", { required: ["text", "checks"], optional: ["mapping", "classifier"], expect: ["verdict", "text", "mapping", "findings"], expectOptional: ["classifierInputs"] }],
  ["policy", { required: ["policy"], optional: [], expect: ["valid"], expectOptional: [] }],
  [
    "guarded",
    {
      required: ["request", "policy", "provider"],
      optional: ["classifier", "blockedText"],
      expect: ["status", "input", "calls", "mapping", "outputMapping", "reply"],
      expectOptional: ["text", "sent", "output", "classifierInputs"],
    },
  ],
  ["canary", { required: ["messages", "canary"], optional: [], expect: ["messages"], expectOptional: [] }],
  ["metrics", { required: ["expected", "found"], optional: [], expect: ["precision", "recall", "f1", "byKind"], expectOptional: [] }],
  ["eval", { required: ["samples"], optional: [], expect: ["pii", "injection"], expectOptional: [] }],
  [
    "table",
    {
      required: [],
      optional: [],
      expect: ["piiKinds", "placeholderNames", "secretPrefixes", "dniLetters", "canaryPrefix", "canarySuffix", "canaryWhitespace", "defaultBlockedText", "metricKinds", "injection"],
      expectOptional: [],
    },
  ],
]);

function checkExpect(kind: string, setup: Obj, raw: unknown): void {
  const exp = object(raw, "expect");
  const spec = SPECS.get(kind)!;
  // classifierInputs is required exactly when the setup has a classifier (error expectations included).
  const classifierKey = Object.hasOwn(setup, "classifier") ? ["classifierInputs"] : [];
  if (Object.hasOwn(exp, "error")) {
    shape(exp, [...(kind === "guarded" ? ["error", "calls"] : ["error"]), ...classifierKey], kind === "guarded" ? ["sent"] : []);
    const err = object(exp["error"], "error");
    shape(err, ["kind"], []);
    str(err["kind"], "kind");
    return;
  }
  if (spec.expect.some((k) => !Object.hasOwn(exp, k))) invalid("expect has neither the keys of its kind nor error");
  shape(exp, [...spec.expect, ...classifierKey], spec.expectOptional.filter((k) => k !== "classifierInputs"));
}

function parseMappingFx(v: unknown): Mapping {
  return array(v, "mapping").map((e): [string, string] => {
    if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== "string" || typeof e[1] !== "string") invalid("wrong type: mapping");
    return [e[0], e[1]];
  });
}

function parseMessagesFx(v: unknown): Message[] {
  return array(v, "messages").map((m) => {
    const o = object(m, "messages");
    shape(o, ["role", "content"], []);
    const role = str(o["role"], "role");
    if (!ROLES.includes(role)) invalid("wrong type: role");
    return { role: role as Message["role"], content: str(o["content"], "content") };
  });
}

function parseSpanFx(v: unknown): Span {
  const o = object(v, "expected");
  shape(o, ["kind", "start", "end"], []);
  return { kind: str(o["kind"], "kind"), start: int(o["start"], "start"), end: int(o["end"], "end") };
}

/** The `providers` error kinds a script entry may name. */
const PROVIDER_ERROR_KINDS: readonly string[] = ["rate_limit", "timeout", "invalid_output", "unavailable"];
const PROVIDER_ID = "mock";
const ROLES: readonly string[] = ["system", "user", "assistant"];

function parseProviderScript(v: unknown): ScriptEntry[] {
  const p = object(v, "provider");
  shape(p, ["script"], []);
  return array(p["script"], "script").map((raw, i) => {
    const entry = object(raw, "script");
    if (!Object.hasOwn(entry, "response") && !Object.hasOwn(entry, "error")) invalid(`script entry ${i + 1} of provider ${PROVIDER_ID} has neither response nor error`);
    shape(entry, [], ["response", "error"]);
    if (Object.hasOwn(entry, "response")) str(entry["response"], "response");
    if (Object.hasOwn(entry, "error")) {
      const err = object(entry["error"], "error");
      shape(err, ["kind"], ["retryAfterMs"]);
      const kind = str(err["kind"], "kind");
      if (!PROVIDER_ERROR_KINDS.includes(kind)) invalid(`unknown provider error kind: ${kind}`);
      if (Object.hasOwn(err, "retryAfterMs")) int(err["retryAfterMs"], "retryAfterMs");
    }
    return entry as unknown as ScriptEntry;
  });
}

interface ClassifierEntry {
  flagged: boolean;
  label?: string;
}

function parseClassifierScript(v: unknown): ClassifierEntry[] {
  const c = object(v, "classifier");
  shape(c, ["script"], []);
  return array(c["script"], "script").map((raw) => {
    const e = object(raw, "script");
    shape(e, ["flagged"], ["label"]);
    if (typeof e["flagged"] !== "boolean") invalid("wrong type: flagged");
    const entry: ClassifierEntry = { flagged: e["flagged"] };
    if (Object.hasOwn(e, "label")) entry.label = str(e["label"], "label");
    return entry;
  });
}

/** A test classifier with fresh state: call N answers `script[N-1]` whatever the text and records the text. */
function scriptedClassifier(script: readonly ClassifierEntry[]): { classifier: Classifier; inputs: string[] } {
  const inputs: string[] = [];
  const classifier: Classifier = async (text) => {
    if (inputs.length >= script.length) invalid("classifier script exhausted");
    inputs.push(text);
    const a = script[inputs.length - 1]!;
    return a.label === undefined ? { flagged: a.flagged } : { flagged: a.flagged, label: a.label };
  };
  return { classifier, inputs };
}

function toError(e: unknown): FixtureError {
  if (e instanceof GuardrailError || e instanceof ProviderError) return { kind: e.kind };
  throw e;
}

/** The table fixture: the exported constants in the shape of `table-pinned-constants.json`. */
function buildTable(): Record<string, unknown> {
  return {
    piiKinds: [...PII_KINDS],
    placeholderNames: PLACEHOLDER_NAMES.map(([k, n]) => [k, n]),
    secretPrefixes: [...SECRET_PREFIXES],
    dniLetters: DNI_LETTERS,
    canaryPrefix: CANARY_PREFIX,
    canarySuffix: CANARY_SUFFIX,
    canaryWhitespace: [...CANARY_WHITESPACE],
    defaultBlockedText: DEFAULT_BLOCKED_TEXT,
    metricKinds: [...METRIC_KINDS],
    injection: structuredClone(INJECTION_TABLE),
  };
}

interface EvalSample {
  text: string;
  expected: Span[];
}

function parseSamples(v: unknown): EvalSample[] {
  return array(v, "samples").map((raw) => {
    const s = object(raw, "samples");
    shape(s, ["text", "expected"], []);
    const text = str(s["text"], "text");
    const length = codePointLength(text);
    const expected = array(s["expected"], "expected").map(parseSpanFx);
    for (const sp of expected) if (sp.start < 0 || sp.end < sp.start || sp.end > length) invalid("span outside sample text");
    return { text, expected };
  });
}

function runEval(samples: readonly EvalSample[]): { pii: Metrics; injection: Metrics } {
  const piiKinds: ReadonlySet<string> = new Set(PII_KINDS);
  const expectedPii: Span[] = [];
  const expectedInjection: Span[] = [];
  const foundPii: Span[] = [];
  const foundInjection: Span[] = [];
  let base = 0;
  for (const s of samples) {
    const shift = (sp: Span): Span => ({ kind: sp.kind, start: sp.start + base, end: sp.end + base });
    for (const sp of s.expected) {
      if (piiKinds.has(sp.kind)) expectedPii.push(shift(sp));
      else expectedInjection.push(shift(sp));
    }
    for (const f of detectPii(s.text)) foundPii.push(shift({ kind: f.kind, start: f.start, end: f.end }));
    for (const sg of detectInjection(s.text).signals) foundInjection.push(shift({ kind: sg.category, start: sg.start, end: sg.end }));
    base += codePointLength(s.text) + 1;
  }
  return { pii: detectionMetrics(expectedPii, foundPii), injection: detectionMetrics(expectedInjection, foundInjection) };
}

/**
 * Runs one contract fixture through the public API and returns the actual outputs. Browser-safe (no Node APIs).
 * Throws `invalid fixture: <reason>` for an unusable fixture; library errors (`GuardrailError`, provider errors)
 * are results.
 */
export async function runFixture(fixture: Fixture): Promise<FixtureRun> {
  const top = object(fixture, "fixture");
  shape(top, ["name", "setup", "expect"], []);
  str(top["name"], "name");
  const setup = object(top["setup"], "setup");
  if (!Object.hasOwn(setup, "kind")) invalid("missing key: kind");
  const kind = setup["kind"];
  if (typeof kind !== "string") invalid("wrong type: kind");
  if (!SPECS.has(kind)) invalid(`unknown setup kind: ${kind}`);
  const spec = SPECS.get(kind)!;
  shape(setup, ["kind", ...spec.required], spec.optional);

  // Parse and type-check everything before running anything.
  const text = Object.hasOwn(setup, "text") ? str(setup["text"], "text") : "";
  const kinds = Object.hasOwn(setup, "kinds") ? (array(setup["kinds"], "kinds").map((k) => str(k, "kinds")) as PiiKind[]) : undefined;
  const mapping = Object.hasOwn(setup, "mapping") ? parseMappingFx(setup["mapping"]) : undefined;
  const classifierScript = Object.hasOwn(setup, "classifier") ? parseClassifierScript(setup["classifier"]) : null;
  const canaryMessages = kind === "canary" ? parseMessagesFx(setup["messages"]) : [];
  const canary = kind === "canary" ? str(setup["canary"], "canary") : "";
  const metricsExpected = kind === "metrics" ? array(setup["expected"], "expected").map(parseSpanFx) : [];
  const metricsFound = kind === "metrics" ? array(setup["found"], "found").map(parseSpanFx) : [];
  const samples = kind === "eval" ? parseSamples(setup["samples"]) : [];
  let request: { messages: Message[] } = { messages: [] };
  let providerScript: ScriptEntry[] = [];
  let blockedText: string | undefined;
  if (kind === "guarded") {
    const r = object(setup["request"], "request");
    shape(r, ["messages"], []);
    request = { messages: parseMessagesFx(r["messages"]) };
    providerScript = parseProviderScript(setup["provider"]);
    if (Object.hasOwn(setup, "blockedText")) blockedText = str(setup["blockedText"], "blockedText");
  }

  // The whole setup is valid; now the expectation.
  checkExpect(kind, setup, top["expect"]);

  const fresh = () => (classifierScript === null ? null : scriptedClassifier(classifierScript));
  const done = (output: FixtureOutput | null, error: FixtureError | null, inputs: string[] | null = null): FixtureRun => ({
    kind,
    output,
    error,
    calls: 0,
    requests: [],
    classifierInputs: inputs,
    second: null,
  });

  if (kind === "guarded") return runGuarded(kind, setup["policy"], request, providerScript, fresh, blockedText);

  const c = fresh();
  try {
    switch (kind) {
      case "pii":
        return done({ kind: "pii", findings: detectPii(text, kinds === undefined ? undefined : { kinds }) }, null);
      case "redact": {
        const r = redact(text, detectPii(text, kinds === undefined ? undefined : { kinds }), mapping ?? []);
        return done({ kind: "redact", text: r.text, mapping: r.mapping }, null);
      }
      case "restore":
        return done({ kind: "restore", text: restore(text, mapping!) }, null);
      case "injection": {
        const r = detectInjection(text);
        return done({ kind: "injection", score: r.score, signals: r.signals }, null);
      }
      case "check": {
        const checks = parsePolicy({ input: [], output: setup["checks"] }).output;
        const options: { mapping?: Mapping; classifier?: Classifier } = {};
        if (mapping !== undefined) options.mapping = mapping;
        if (c !== null) options.classifier = c.classifier;
        const r = await checkText(text, checks, options);
        return done({ kind: "check", ...r }, null, c?.inputs ?? null);
      }
      case "policy":
        return done({ kind: "policy", policy: parsePolicy(setup["policy"]) }, null);
      case "canary":
        return done({ kind: "canary", messages: withCanary(canaryMessages, canary) }, null);
      case "metrics":
        return done({ kind: "metrics", ...detectionMetrics(metricsExpected, metricsFound) }, null);
      case "eval":
        return done({ kind: "eval", ...runEval(samples) }, null);
      case "table":
        return done({ kind: "table", table: buildTable() }, null);
    }
    return invalid(`unknown setup kind: ${kind}`);
  } catch (e) {
    return done(null, toError(e), c?.inputs ?? null);
  }
}

async function runGuarded(
  kind: string,
  policyJson: unknown,
  request: { messages: Message[] },
  script: ScriptEntry[],
  fresh: () => { classifier: Classifier; inputs: string[] } | null,
  blockedText: string | undefined,
): Promise<FixtureRun> {
  const recording = () => {
    const requests: CompletionRequest[] = [];
    const mock = new MockProvider(PROVIDER_ID, script);
    const provider: Provider = {
      id: mock.id,
      async complete(req) {
        requests.push(req);
        return mock.complete(req);
      },
    };
    return { provider, requests };
  };

  // Run 1: guardedComplete.
  const one = recording();
  const c1 = fresh();
  let output: FixtureOutput | null = null;
  let error: FixtureError | null = null;
  try {
    const policy = parsePolicy(policyJson);
    const result = await guardedComplete(one.provider, request, policy, c1 === null ? {} : { classifier: c1.classifier });
    output = { kind: "guarded", result };
  } catch (e) {
    error = toError(e);
  }

  // Run 2: GuardedProvider.
  const two = recording();
  const c2 = fresh();
  let response: CompletionResponse | null = null;
  let error2: FixtureError | null = null;
  let id = "";
  let lastReport: GuardedResult | undefined;
  try {
    const policy = parsePolicy(policyJson);
    const options: { classifier?: Classifier; blockedText?: string } = {};
    if (c2 !== null) options.classifier = c2.classifier;
    if (blockedText !== undefined) options.blockedText = blockedText;
    const gp = new GuardedProvider(two.provider, policy, options);
    id = gp.id;
    try {
      response = await gp.complete(request);
    } finally {
      lastReport = gp.lastReport;
    }
  } catch (e) {
    error2 = toError(e);
  }

  return {
    kind,
    output,
    error,
    calls: one.requests.length,
    requests: one.requests,
    classifierInputs: c1?.inputs ?? null,
    second: { id, response, error: error2, lastReport, calls: two.requests.length, requests: two.requests, classifierInputs: c2?.inputs ?? null },
  };
}

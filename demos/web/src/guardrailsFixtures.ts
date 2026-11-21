import { PII_KINDS, type Fixture, type PiiKind } from "@ilabs/guardrails";
import { isArrayOf, isMessageLike, isRecord, isScriptEntry, parseFixtureFiles } from "./fixtureLoader";
import type { Key } from "./i18n";

// Loaded as raw text and parsed per file: the folder also holds fixtures of kinds the page does not show, and
// the lone surrogate escapes of the fixtures are accepted by JSON.parse but not by Vite's JSON loader.
const modules = import.meta.glob("../../../contracts/guardrails/*.json", { eager: true, query: "?raw", import: "default" });

/** The fixture kinds the page shows: the playground (pii, injection, check), the guarded flow and the measure section. */
const DEMO_KINDS = ["pii", "injection", "check", "guarded", "eval"];

export const DEFAULT_GUARDED = "guarded-ok-redact-and-restore";
export const DEFAULT_EVAL = "eval-labelled-set";

const isSpan = (v: unknown): boolean => isRecord(v) && typeof v.kind === "string" && typeof v.start === "number" && typeof v.end === "number";
const isSample = (v: unknown): boolean => isRecord(v) && typeof v.text === "string" && isArrayOf(v.expected, isSpan);
const isString = (v: unknown): boolean => typeof v === "string";

/** Shape problem of a fixture of a demo kind, or null. Enough for the page to run and render it without throwing. */
function demoProblem(setup: Record<string, unknown>): string | null {
  switch (setup.kind) {
    case "pii":
      if (typeof setup.text !== "string") return "text must be a string";
      if (setup.kinds !== undefined && !isArrayOf(setup.kinds, isString)) return "kinds must be an array of strings";
      return null;
    case "injection":
      return typeof setup.text === "string" ? null : "text must be a string";
    case "check":
      if (typeof setup.text !== "string") return "text must be a string";
      if (!isArrayOf(setup.checks, (c) => isRecord(c) && typeof c.kind === "string")) return "checks must be objects with a kind";
      return null;
    case "guarded":
      if (!isRecord(setup.request) || !isArrayOf(setup.request.messages, isMessageLike)) return "request.messages must be {role, content} objects";
      if (!(isRecord(setup.provider) && isArrayOf(setup.provider.script, isScriptEntry))) return "provider must be an object with a provider script";
      return null;
    default:
      return isArrayOf(setup.samples, isSample) ? null : "samples must be {text, expected} objects";
  }
}

function shapeProblem(value: unknown): string | null {
  if (!isRecord(value)) return "not an object";
  if (typeof value.name !== "string") return "missing name";
  const { setup } = value;
  if (!isRecord(setup) || typeof setup.kind !== "string") return "missing setup.kind";
  if (!isRecord(value.expect)) return "missing expect";
  return DEMO_KINDS.includes(setup.kind) ? demoProblem(setup) : null;
}

/** Pure and total: see `parseFixtureFiles`. Files of other kinds (policy, redact, canary...) are skipped silently. */
export function parseGuardrailFixtures(raw: Record<string, string>): { fixtures: Fixture[]; errors: string[] } {
  const { fixtures, errors } = parseFixtureFiles<Fixture>(raw, shapeProblem);
  return { fixtures: fixtures.filter((f) => DEMO_KINDS.includes(f.setup.kind)), errors };
}

const loaded = parseGuardrailFixtures(modules as Record<string, string>);
export const guardrailFixtures: Fixture[] = loaded.fixtures;
/** One entry per fixture file that could not be loaded; shown as a warning on the page. */
export const loadErrors: string[] = loaded.errors;

const expectsError = (f: Fixture): boolean => "error" in f.expect;

export interface FixtureGroup {
  label: Key;
  fixtures: Fixture[];
}

/** Playground picker groups, in display order; a fixture belongs to a group when its name starts with the prefix. */
const GROUPS: { prefix: string; label: Key }[] = [
  { prefix: "pii-", label: "guardGroupPii" },
  { prefix: "injection-", label: "guardGroupInjection" },
  { prefix: "check-", label: "guardGroupChecks" },
];

/**
 * The samples of the playground: PII, injection and check fixtures. A sample that expects an error (an invalid
 * `kinds` list, a missing classifier) is not text to analyse, so it is not offered.
 */
export function playgroundGroups(list: Fixture[]): FixtureGroup[] {
  return GROUPS.map((g) => ({ label: g.label, fixtures: list.filter((f) => f.name.startsWith(g.prefix) && f.setup.kind === g.prefix.slice(0, -1) && !expectsError(f)) })).filter(
    (g) => g.fixtures.length > 0,
  );
}

export const playgroundFixtures = (list: Fixture[]): Fixture[] => playgroundGroups(list).flatMap((g) => g.fixtures);

/** The guarded-conversation samples. */
export const guardedFixtures = (list: Fixture[]): Fixture[] => list.filter((f) => f.setup.kind === "guarded");

/** The eval samples that run (the one that expects an error is left out). */
export const evalFixtures = (list: Fixture[]): Fixture[] => list.filter((f) => f.setup.kind === "eval" && !expectsError(f));

export type FlagBlock = "off" | "flag" | "block";
export type PiiAction = "off" | "flag" | "redact" | "block";

/** The policy toggles of the playground. Numbers and terms stay text so that what is typed reaches the library unchanged. */
export interface Controls {
  pii: { action: PiiAction; kinds: PiiKind[] };
  injection: { action: FlagBlock; threshold: string };
  deny: { action: FlagBlock; terms: string };
  maxLength: { action: FlagBlock; max: string };
}

export const ALL_PII_KINDS: readonly PiiKind[] = PII_KINDS;

export function defaultControls(): Controls {
  return {
    pii: { action: "redact", kinds: [...ALL_PII_KINDS] },
    injection: { action: "flag", threshold: "50" },
    deny: { action: "off", terms: "" },
    maxLength: { action: "off", max: "500" },
  };
}

/** True when the selection names every PII kind (the scan then needs no `kinds` option). */
export const isAllKinds = (kinds: readonly PiiKind[]): boolean => ALL_PII_KINDS.every((k) => kinds.includes(k));

/** The order in which the toggles build their checks. */
const CHECK_ORDER = ["pii", "injection", "denyTerms", "maxLength"];

const isPiiKind = (v: unknown): v is PiiKind => typeof v === "string" && (ALL_PII_KINDS as readonly string[]).includes(v);
const actionOf = (c: Record<string, unknown>, allowed: readonly string[]): string | null => (typeof c.action === "string" && allowed.includes(c.action) ? c.action : null);

/**
 * What the controls start at when a sample is picked. A pii or injection sample keeps the defaults (a pii sample
 * that names `kinds` narrows the PII scan to them). A check sample loads its first PII, injection, denied-terms and
 * length check into the toggles; `omitted` is true when the sample has something the toggles cannot express
 * (a classifier or canary check, a repeated or out-of-order check, an unknown or repeated PII kind, or a given mapping), so its recorded verdict may differ.
 */
export function controlsFor(fixture: Fixture): { controls: Controls; omitted: boolean } {
  const controls = defaultControls();
  const s = fixture.setup;
  if (s.kind === "pii") {
    if (Array.isArray(s.kinds)) controls.pii.kinds = s.kinds.filter(isPiiKind);
    return { controls, omitted: false };
  }
  if (s.kind !== "check") return { controls, omitted: false };

  controls.pii.action = "off";
  controls.injection.action = "off";
  const seen = new Set<string>();
  let lastOrder = -1;
  let omitted = s.mapping !== undefined || s.classifier !== undefined;
  for (const raw of s.checks as Record<string, unknown>[]) {
    const kind = raw.kind as string;
    if (seen.has(kind) || !["pii", "injection", "denyTerms", "maxLength"].includes(kind)) {
      omitted = true;
      continue;
    }
    seen.add(kind);
    // The toggles build the checks in a fixed order, so a sample listing them in another order cannot be expressed.
    const order = CHECK_ORDER.indexOf(kind);
    if (order < lastOrder) omitted = true;
    lastOrder = order;
    if (kind === "pii") {
      const a = actionOf(raw, ["flag", "redact", "block"]);
      if (a === null) omitted = true;
      else controls.pii.action = a as PiiAction;
      if (Array.isArray(raw.kinds)) {
        controls.pii.kinds = raw.kinds.filter(isPiiKind);
        // An unknown or repeated kind name cannot be a checkbox selection.
        if (raw.kinds.length !== controls.pii.kinds.length || new Set(raw.kinds).size !== raw.kinds.length) omitted = true;
      }
    } else if (kind === "injection") {
      const a = actionOf(raw, ["flag", "block"]);
      if (a === null || typeof raw.threshold !== "number") omitted = true;
      else controls.injection = { action: a as FlagBlock, threshold: String(raw.threshold) };
    } else if (kind === "denyTerms") {
      const a = actionOf(raw, ["flag", "block"]);
      const terms = Array.isArray(raw.terms) ? raw.terms.filter(isString) : [];
      if (a === null || terms.some((t) => (t as string).includes(","))) omitted = true;
      else controls.deny = { action: a as FlagBlock, terms: terms.join(", ") };
    } else {
      const a = actionOf(raw, ["flag", "block"]);
      if (a === null || typeof raw.max !== "number") omitted = true;
      else controls.maxLength = { action: a as FlagBlock, max: String(raw.max) };
    }
  }
  return { controls, omitted };
}

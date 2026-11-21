import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_EVAL,
  DEFAULT_GUARDED,
  controlsFor,
  defaultControls,
  evalFixtures,
  guardedFixtures,
  guardrailFixtures,
  loadErrors,
  parseGuardrailFixtures,
  playgroundFixtures,
  playgroundGroups,
} from "./guardrailsFixtures";

const dir = resolve(__dirname, "../../../contracts/guardrails");
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
const withPrefix = (p: string) => files.filter((f) => f.startsWith(p)).length;

const fx = (name: string, setup: Record<string, unknown>, expectBody: unknown = {}) => JSON.stringify({ name, setup, expect: expectBody });
const by = (name: string) => guardrailFixtures.find((f) => f.name === name)!;

describe("the loaded contract fixtures", () => {
  it("load without a single error", () => {
    expect(loadErrors).toEqual([]);
    expect(files.length).toBeGreaterThanOrEqual(260);
  });

  it("keeps only the kinds the page shows", () => {
    const kinds = new Set(guardrailFixtures.map((f) => f.setup.kind));
    expect([...kinds].sort()).toEqual(["check", "eval", "guarded", "injection", "pii"]);
    expect(guardrailFixtures.length).toBe(withPrefix("pii-") + withPrefix("injection-") + withPrefix("check-") + withPrefix("guarded-") + withPrefix("eval-"));
  });

  it("offers the playground samples grouped as PII, Injection and Checks, error samples left out", () => {
    const groups = playgroundGroups(guardrailFixtures);
    expect(groups.map((g) => g.label)).toEqual(["guardGroupPii", "guardGroupInjection", "guardGroupChecks"]);
    const names = playgroundFixtures(guardrailFixtures).map((f) => f.name);
    expect(names.length).toBeGreaterThanOrEqual(150);
    // Counted from the contracts directory: every pii-, injection- and check- file except the ones that expect an error.
    const errorSamples = guardrailFixtures.filter((f) => (f.expect as { error?: unknown }).error !== undefined && /^(pii|injection|check)-/.test(f.name));
    expect(errorSamples.length).toBeGreaterThan(0);
    expect(names.length).toBe(withPrefix("pii-") + withPrefix("injection-") + withPrefix("check-") - errorSamples.length);
    for (const e of errorSamples) expect(names).not.toContain(e.name);
    expect(groups[0]!.fixtures.every((f) => f.name.startsWith("pii-"))).toBe(true);
    expect(groups[1]!.fixtures.every((f) => f.name.startsWith("injection-"))).toBe(true);
    expect(groups[2]!.fixtures.every((f) => f.name.startsWith("check-"))).toBe(true);
  });

  it("starts the playground on the first pii- fixture in name order", () => {
    expect(playgroundGroups(guardrailFixtures)[0]!.fixtures[0]!.name).toBe("pii-card-dot-separator-not-card");
  });

  it("offers the 21 guarded samples and the three valid eval sets", () => {
    expect(guardedFixtures(guardrailFixtures)).toHaveLength(withPrefix("guarded-"));
    expect(guardedFixtures(guardrailFixtures).length).toBeGreaterThanOrEqual(21);
    expect(guardedFixtures(guardrailFixtures).map((f) => f.name)).toContain(DEFAULT_GUARDED);
    expect(evalFixtures(guardrailFixtures).map((f) => f.name)).toEqual(["eval-labelled-set", "eval-shift-length-plus-one", "eval-spans-kept-apart"]);
    expect(DEFAULT_EVAL).toBe("eval-labelled-set");
  });
});

describe("parseGuardrailFixtures", () => {
  it("keeps demo kinds sorted, silently skips the other kinds and names the broken files", () => {
    const { fixtures, errors } = parseGuardrailFixtures({
      "../g/b.json": fx("b", { kind: "pii", text: "x" }),
      "../g/a.json": fx("a", { kind: "injection", text: "y" }),
      "../g/policy.json": fx("policy-x", { kind: "policy", policy: {} }),
      "../g/broken.json": "{",
      "../g/array.json": "[]",
      "../g/no-text.json": fx("no-text", { kind: "pii" }),
    });
    expect(fixtures.map((f) => f.name)).toEqual(["a", "b"]);
    expect(errors).toHaveLength(3);
    expect(errors.some((e) => e.includes("policy.json"))).toBe(false);
  });

  const variants: Record<string, string> = {
    "text-number": fx("x", { kind: "check", text: 3, checks: [] }),
    "checks-object": fx("x", { kind: "check", text: "a", checks: {} }),
    "check-not-object": fx("x", { kind: "check", text: "a", checks: [1] }),
    "check-no-kind": fx("x", { kind: "check", text: "a", checks: [{ action: "flag" }] }),
    "kinds-number": fx("x", { kind: "pii", text: "a", kinds: 4 }),
    "expect-array": JSON.stringify({ name: "x", setup: { kind: "pii", text: "a" }, expect: [] }),
    "guarded-no-request": fx("x", { kind: "guarded", policy: {}, provider: { script: [] } }),
    "guarded-bad-message": fx("x", { kind: "guarded", request: { messages: [{ role: "user" }] }, policy: {}, provider: { script: [] } }),
    "guarded-bad-script": fx("x", { kind: "guarded", request: { messages: [] }, policy: {}, provider: { script: [null] } }),
    "eval-no-samples": fx("x", { kind: "eval" }),
    "eval-bad-span": fx("x", { kind: "eval", samples: [{ text: "a", expected: [{ kind: "email", start: "0", end: 1 }] }] }),
  };
  it.each(Object.keys(variants))("skips a %s fixture instead of crashing the page", (key) => {
    const { fixtures, errors } = parseGuardrailFixtures({ "../g/x.json": variants[key]! });
    expect(fixtures).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});

describe("controls of a sample", () => {
  it("starts from PII redact over every kind, injection flag at 50, and the other checks off", () => {
    const c = defaultControls();
    expect(c.pii).toEqual({ action: "redact", kinds: ["email", "phone", "iban", "card", "spanish_id", "secret"] });
    expect(c.injection).toEqual({ action: "flag", threshold: "50" });
    expect(c.deny.action).toBe("off");
    expect(c.maxLength.action).toBe("off");
  });

  it("gives a pii or injection sample the default controls, with the sample's kinds when it names them", () => {
    expect(controlsFor(by("pii-email-basic"))).toEqual({ controls: defaultControls(), omitted: false });
    const listed = controlsFor(by("pii-kinds-only-listed"));
    expect(listed.controls.pii.kinds).toEqual((by("pii-kinds-only-listed").setup.kinds as string[]));
    expect(listed.controls.pii.kinds.length).toBeLessThan(6);
  });

  it("loads the checks of a check sample into the toggles", () => {
    const { controls, omitted } = controlsFor(by("check-block-beats-redact"));
    expect(omitted).toBe(false);
    expect(controls.pii.action).toBe("redact");
    expect(controls.deny).toEqual({ action: "block", terms: "secreto" });
    expect(controls.injection.action).toBe("off");
    expect(controls.maxLength.action).toBe("off");
    const flat = controlsFor(by("check-no-short-circuit")).controls;
    expect(flat.injection).toEqual({ action: "block", threshold: "30" });
    expect(flat.pii.action).toBe("flag");
    expect(flat.maxLength).toEqual({ action: "flag", max: "1000" });
  });

  it("starts with everything off for a sample without checks", () => {
    const { controls, omitted } = controlsFor(by("check-empty-checks"));
    expect(omitted).toBe(false);
    expect([controls.pii.action, controls.injection.action, controls.deny.action, controls.maxLength.action]).toEqual(["off", "off", "off", "off"]);
  });

  it("says the toggles cannot express a sample with a classifier, a canary, a repeated check or a given mapping", () => {
    for (const name of ["check-classifier-flagged", "check-canary-found", "check-injection-threshold-inclusive", "check-redact-union", "check-flag-keeps-text"]) {
      expect(controlsFor(by(name)).omitted, name).toBe(true);
    }
    // A classifier sample still starts from the checks the toggles can express.
    expect(controlsFor(by("check-classifier-sees-original")).controls.pii.action).toBe("redact");
  });
});

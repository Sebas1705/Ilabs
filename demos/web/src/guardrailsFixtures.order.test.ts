import type { Fixture } from "@ilabs/guardrails";
import { controlsFor, guardrailFixtures } from "./guardrailsFixtures";

const check = (checks: unknown[]): Fixture => ({ name: "x", setup: { kind: "check", text: "t", checks }, expect: {} });

describe("controlsFor says when the toggles cannot express a check sample", () => {
  it("accepts the fixed order pii, injection, denyTerms, maxLength", () => {
    const f = check([
      { kind: "pii", action: "flag" },
      { kind: "injection", action: "block", threshold: 30 },
      { kind: "denyTerms", action: "flag", terms: ["a"] },
      { kind: "maxLength", action: "flag", max: 5 },
    ]);
    expect(controlsFor(f).omitted).toBe(false);
  });

  it("flags checks listed in another order", () => {
    expect(controlsFor(check([{ kind: "injection", action: "flag", threshold: 30 }, { kind: "pii", action: "flag" }])).omitted).toBe(true);
    expect(controlsFor(by("check-no-short-circuit")).omitted).toBe(true);
  });

  it("flags unknown or repeated PII kind names", () => {
    expect(controlsFor(check([{ kind: "pii", action: "flag", kinds: ["email", "nope"] }])).omitted).toBe(true);
    expect(controlsFor(check([{ kind: "pii", action: "flag", kinds: ["email", "email"] }])).omitted).toBe(true);
    expect(controlsFor(check([{ kind: "pii", action: "flag", kinds: ["email", "phone"] }])).omitted).toBe(false);
  });

  it("flags a missing threshold or maximum", () => {
    expect(controlsFor(check([{ kind: "injection", action: "flag" }])).omitted).toBe(true);
    expect(controlsFor(check([{ kind: "maxLength", action: "flag" }])).omitted).toBe(true);
  });
});

function by(name: string): Fixture {
  return guardrailFixtures.find((f) => f.name === name)!;
}

import { describe, expect, it } from "vitest";
import { GuardrailError } from "./errors.js";
import { parsePolicy } from "./policy.js";

const pii = { kind: "pii", action: "block" };
const fail = (json: unknown): GuardrailError => {
  try {
    parsePolicy(json);
  } catch (e) {
    expect(e).toBeInstanceOf(GuardrailError);
    return e as GuardrailError;
  }
  throw new Error(`expected invalid policy: ${JSON.stringify(json)}`);
};
const bad = (name: string, json: unknown): void => {
  const e = fail(json);
  expect(e.kind, name).toBe("invalid_policy");
  expect(e.message.startsWith("invalid policy: "), name).toBe(true);
  expect(e.message.length, name).toBeGreaterThan("invalid policy: ".length);
};
const out = (check: unknown) => ({ input: [], output: [check] });

describe("parsePolicy accepts", () => {
  it("the minimal and a full policy and returns fresh copies", () => {
    expect(parsePolicy({ input: [], output: [] })).toEqual({ input: [], output: [] });
    const json = {
      input: [
        { kind: "pii", action: "redact", kinds: ["email", "card"] },
        { kind: "injection", action: "block", threshold: 1 },
        { kind: "injection", action: "flag", threshold: 100 },
        { kind: "denyTerms", action: "flag", terms: ["Tarjeta Regalo"] },
        { kind: "maxLength", action: "block", max: 0 },
        { kind: "classifier", action: "block", label: "toxic" },
        { kind: "classifier", action: "flag" },
      ],
      output: [{ kind: "canary", action: "block", canary: "CNR-1" }],
    };
    const p = parsePolicy(json);
    expect(p).toEqual(json);
    expect(p.input).not.toBe(json.input);
    expect((p.input[0] as { kinds: string[] }).kinds).not.toBe(json.input[0]!.kinds);
    expect(parsePolicy({ input: [{ kind: "maxLength", action: "flag", max: 5.0 }], output: [] }).input[0]).toMatchObject({ max: 5 });
  });
});

describe("parsePolicy rules (one test per rule)", () => {
  it("1: the policy is an object", () => {
    for (const v of [[], null, "x", 5, true, undefined]) bad(`rule 1 ${String(v)}`, v);
  });
  it("2: exactly the keys input and output", () => {
    bad("missing output", { input: [] });
    bad("missing input", { output: [] });
    bad("extra", { input: [], output: [], extra: [] });
  });
  it("3: input and output are arrays", () => {
    bad("input", { input: {}, output: [] });
    bad("output", { input: [], output: "x" });
    bad("null", { input: null, output: [] });
  });
  it("4: every check is an object", () => {
    for (const c of [null, [], "pii", 5]) bad(`rule 4 ${JSON.stringify(c)}`, out(c));
  });
  it("5: kind is present and one of the six (case-sensitive, no prototype names)", () => {
    bad("missing", out({ action: "block" }));
    bad("unknown", out({ kind: "regex", action: "block" }));
    bad("case", out({ kind: "PII", action: "block" }));
    for (const k of ["constructor", "__proto__", "toString", "hasOwnProperty"]) bad(k, out({ kind: k, action: "block" }));
    bad("not string", out({ kind: 1, action: "block" }));
  });
  it("6: action is present and block, redact or flag", () => {
    bad("missing", out({ kind: "pii" }));
    bad("unknown", out({ kind: "pii", action: "drop" }));
    bad("prototype", out({ kind: "pii", action: "constructor" }));
  });
  it("7: redact only with pii", () => {
    for (const c of [
      { kind: "injection", threshold: 5 },
      { kind: "denyTerms", terms: ["a"] },
      { kind: "maxLength", max: 1 },
      { kind: "canary", canary: "c" },
      { kind: "classifier" },
    ]) bad(`redact on ${c.kind}`, out({ ...c, action: "redact" }));
  });
  it("8: no key other than kind, action and the own params", () => {
    bad("threshold on pii", out({ ...pii, threshold: 5 }));
    bad("kinds on injection", out({ kind: "injection", action: "block", threshold: 5, kinds: ["email"] }));
    bad("label on pii", out({ ...pii, label: "x" }));
    bad("anything", out({ ...pii, extra: 1 }));
  });
  it("9: required params are present", () => {
    bad("threshold", out({ kind: "injection", action: "block" }));
    bad("terms", out({ kind: "denyTerms", action: "block" }));
    bad("max", out({ kind: "maxLength", action: "block" }));
    bad("canary", out({ kind: "canary", action: "block" }));
  });
  it("10: null is never valid, for any key", () => {
    bad("kinds", out({ ...pii, kinds: null }));
    bad("label", out({ kind: "classifier", action: "block", label: null }));
    bad("threshold", out({ kind: "injection", action: "block", threshold: null }));
    bad("terms", out({ kind: "denyTerms", action: "block", terms: null }));
    bad("max", out({ kind: "maxLength", action: "block", max: null }));
    bad("canary", out({ kind: "canary", action: "block", canary: null }));
    bad("kind", out({ kind: null, action: "block" }));
    bad("action", out({ kind: "pii", action: null }));
  });
  it("11: kinds is a non-empty array of distinct PII kind names", () => {
    bad("empty", out({ ...pii, kinds: [] }));
    bad("unknown", out({ ...pii, kinds: ["name"] }));
    bad("duplicate", out({ ...pii, kinds: ["email", "email"] }));
    bad("not array", out({ ...pii, kinds: "email" }));
    bad("not string", out({ ...pii, kinds: [1] }));
    bad("prototype", out({ ...pii, kinds: ["constructor"] }));
  });
  it("12: threshold is an integer by value between 1 and 100", () => {
    for (const t of [0, 101, 49.5, -1, "50", true, NaN]) bad(`threshold ${String(t)}`, out({ kind: "injection", action: "block", threshold: t }));
  });
  it("13: terms is a non-empty array of strings with at least one token", () => {
    bad("empty", out({ kind: "denyTerms", action: "block", terms: [] }));
    bad("no tokens", out({ kind: "denyTerms", action: "block", terms: ["?!"] }));
    bad("empty string", out({ kind: "denyTerms", action: "block", terms: [""] }));
    bad("not string", out({ kind: "denyTerms", action: "block", terms: [1] }));
    bad("not array", out({ kind: "denyTerms", action: "block", terms: "a" }));
    bad("second term", out({ kind: "denyTerms", action: "block", terms: ["ok", " ,"] }));
  });
  it("14: max is an integer by value, at least 0", () => {
    for (const m of [-1, 1.5, "3", false, Infinity]) bad(`max ${String(m)}`, out({ kind: "maxLength", action: "block", max: m }));
  });
  it("15: canary is a non-empty string without whitespace code points", () => {
    bad("empty", out({ kind: "canary", action: "block", canary: "" }));
    bad("space", out({ kind: "canary", action: "block", canary: "a b" }));
    bad("nbsp", out({ kind: "canary", action: "block", canary: "a b" }));
    bad("ideographic space", out({ kind: "canary", action: "block", canary: "a　b" }));
    bad("next line", out({ kind: "canary", action: "block", canary: "a\u0085" }));
    bad("not string", out({ kind: "canary", action: "block", canary: 5 }));
    expect(() => parsePolicy(out({ kind: "canary", action: "block", canary: "a​b" }))).not.toThrow();
  });
  it("16: label is a non-empty string", () => {
    bad("empty", out({ kind: "classifier", action: "block", label: "" }));
    bad("not string", out({ kind: "classifier", action: "block", label: 1 }));
  });
  it("integers above 2^31 - 1 are invalid_policy (max, threshold)", () => {
    bad("max", out({ kind: "maxLength", action: "block", max: 2147483648 }));
    bad("max big", out({ kind: "maxLength", action: "block", max: 1e15 }));
    bad("threshold", out({ kind: "injection", action: "block", threshold: 2147483648 }));
    expect(() => parsePolicy(out({ kind: "maxLength", action: "block", max: 2147483647 }))).not.toThrow();
  });
  it("17: a canary check is not allowed in input", () => {
    bad("input", { input: [{ kind: "canary", action: "block", canary: "c" }], output: [] });
  });
  it("hand-built typed policies are validated the same way", () => {
    bad("typed", { input: [{ kind: "pii", action: "redact", kinds: [] }], output: [] } as never);
  });
});

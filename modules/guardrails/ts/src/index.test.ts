import { describe, expect, it } from "vitest";
import * as api from "./index.js";

describe("public API", () => {
  it("exports only the documented runtime values", () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        "CANARY_PREFIX",
        "CANARY_SUFFIX",
        "CANARY_WHITESPACE",
        "DEFAULT_BLOCKED_TEXT",
        "DNI_LETTERS",
        "GuardedProvider",
        "GuardrailError",
        "INJECTION_TABLE",
        "METRIC_KINDS",
        "PII_KINDS",
        "PLACEHOLDER_NAMES",
        "SECRET_PREFIXES",
        "checkText",
        "detectInjection",
        "detectPii",
        "detectionMetrics",
        "guardedComplete",
        "parsePolicy",
        "redact",
        "restore",
        "runFixture",
        "withCanary",
      ].sort(),
    );
  });

  it("GuardrailError carries a kind and the pinned message shapes", () => {
    const policy = new api.GuardrailError("invalid_policy", "bad");
    expect(policy.kind).toBe("invalid_policy");
    expect(policy.message).toBe("invalid policy: bad");
    expect(policy).toBeInstanceOf(Error);
    expect(new api.GuardrailError("invalid_options", "x").message).toBe("invalid_options: x");
    expect(new api.GuardrailError("no_classifier", "x").message).toBe("no_classifier: x");
  });
});

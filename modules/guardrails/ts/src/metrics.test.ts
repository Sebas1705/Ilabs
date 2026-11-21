import { describe, expect, it } from "vitest";
import { GuardrailError } from "./errors.js";
import { METRIC_KINDS, detectionMetrics } from "./metrics.js";

const s = (kind: string, start: number, end: number) => ({ kind, start, end });

describe("detectionMetrics", () => {
  it("pins the ten kinds in order", () => {
    expect(METRIC_KINDS).toEqual(["email", "phone", "iban", "card", "spanish_id", "secret", "override", "role_hijack", "prompt_leak", "delimiter"]);
  });

  it("exact match, nothing found, nothing expected, both empty", () => {
    expect(detectionMetrics([s("email", 0, 3)], [s("email", 0, 3)])).toMatchObject({ precision: 1, recall: 1, f1: 1 });
    expect(detectionMetrics([s("email", 0, 3)], [])).toMatchObject({ precision: 1, recall: 0, f1: 0 });
    expect(detectionMetrics([], [s("email", 0, 3)])).toMatchObject({ precision: 0, recall: 1, f1: 0 });
    expect(detectionMetrics([], [])).toEqual({ precision: 1, recall: 1, f1: 1, byKind: [] });
  });

  it("sets: duplicates count once; kind, start and end must all match", () => {
    const r = detectionMetrics([s("email", 0, 3)], [s("email", 0, 3), s("email", 0, 3), s("email", 5, 6)]);
    expect([r.precision, r.recall, r.f1]).toEqual([0.5, 1, 2 / 3]);
    expect(detectionMetrics([s("email", 0, 3)], [s("phone", 0, 3)]).f1).toBe(0);
  });

  it("f1 is one division, 2c / (|E| + |F|)", () => {
    const e = [s("email", 0, 1), s("email", 1, 2), s("email", 2, 3)];
    const f = [s("email", 0, 1), s("email", 7, 8), s("email", 8, 9)];
    const r = detectionMetrics(e, f);
    expect(r.f1).toBe(2 / 6);
    expect(r.precision).toBe(1 / 3);
  });

  it("byKind lists present kinds in pinned order with integer counts", () => {
    const r = detectionMetrics([s("delimiter", 0, 1), s("email", 0, 1), s("email", 4, 5)], [s("override", 0, 2), s("email", 0, 1)]);
    expect(r.byKind).toEqual([
      { kind: "email", precision: 1, recall: 0.5, f1: 2 / 3, expected: 2, found: 1, correct: 1 },
      { kind: "override", precision: 0, recall: 1, f1: 0, expected: 0, found: 1, correct: 0 },
      { kind: "delimiter", precision: 1, recall: 0, f1: 0, expected: 1, found: 0, correct: 0 },
    ]);
  });

  it("spans are opaque: negative, reversed and huge offsets are plain tuples", () => {
    const r = detectionMetrics([s("secret", -5, -9), s("secret", 3, 1)], [s("secret", -5, -9), s("secret", 2 ** 40, 2 ** 41)]);
    expect([r.precision, r.recall]).toEqual([0.5, 0.5]);
  });

  it("an unknown kind in either list is invalid_options (no prototype lookup)", () => {
    for (const k of ["name", "constructor", "__proto__", "EMAIL", 5, null]) {
      for (const side of [0, 1]) {
        const bad = [{ kind: k, start: 0, end: 1 }];
        try {
          if (side === 0) detectionMetrics(bad as never, []);
          else detectionMetrics([], bad as never);
          expect.unreachable(String(k));
        } catch (e) {
          expect(e, String(k)).toBeInstanceOf(GuardrailError);
          expect((e as GuardrailError).kind).toBe("invalid_options");
        }
      }
    }
  });

  it("validates the arguments are arrays of objects; does not mutate", () => {
    expect(() => detectionMetrics(null as never, [])).toThrow(GuardrailError);
    expect(() => detectionMetrics([], "x" as never)).toThrow(GuardrailError);
    expect(() => detectionMetrics([null as never], [])).toThrow(GuardrailError);
    const e = [s("email", 0, 1), s("email", 0, 1)];
    const snap = structuredClone(e);
    detectionMetrics(e, []);
    expect(e).toEqual(snap);
  });
});

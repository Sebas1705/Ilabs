import { describe, expect, it } from "vitest";
import { checkText } from "./check.js";
import { detectInjection } from "./injection.js";
import { detectPii } from "./pii.js";

/** Wall time of `fn` in milliseconds. */
function time(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

describe("PII scan is linear (generous bounds, each under 1 s)", () => {
  const cases: Array<[string, string, number]> = [
    ["8,000 pairs of '1 '", "1 ".repeat(8000), 0],
    ["8,000 groups of 'A1 '", "A1 ".repeat(8000), 0],
    ["20,000 groups of 'A1 '", "A1 ".repeat(20000), 0],
    ["8,000 repeats of 'sk-'", "sk-".repeat(8000), 0],
    ["20,000 repeats of 'sk-'", "sk-".repeat(20000), 0],
    ["100,000 groups of '4111 '", "4111 ".repeat(100000), 0],
    ["8,000 groups of '612 345 678. '", "612 345 678. ".repeat(8000), 8000],
  ];
  for (const [name, text, findings] of cases) {
    it(name, () => {
      let found = -1;
      const ms = time(() => {
        found = detectPii(text).length;
      });
      expect(ms, `${name} took ${ms.toFixed(0)} ms`).toBeLessThan(1000);
      if (findings > 0) expect(found).toBe(findings);
    });
  }

  it("a 1 MB prose text with PII sprinkled in is scanned and scored under 2 s", () => {
    const prose = "El rápido zorro marrón salta sobre el perro perezoso mientras la lluvia cae. ";
    const parts: string[] = [];
    let size = 0;
    for (let i = 0; size < 1_000_000; i++) {
      const piece = i % 50 === 0 ? `Escribe a ana${i}@example.com o llama al 612 345 678. ` : prose;
      parts.push(piece);
      size += piece.length;
    }
    const text = parts.join("");
    let found = 0;
    const ms = time(() => {
      found = detectPii(text).length;
      detectInjection(text);
    });
    expect(ms, `1 MB took ${ms.toFixed(0)} ms`).toBeLessThan(2000);
    expect(found).toBeGreaterThan(400);
  });

  it("checkText on a long text with many findings stays fast", async () => {
    const text = "x 612345678 ".repeat(5000);
    const t0 = performance.now();
    const r = await checkText(text, [{ kind: "pii", action: "redact" }]);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(r.mapping).toHaveLength(1);
  });
});

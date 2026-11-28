import { describe, expect, it } from "vitest";
import { createLimiter } from "./limiter.js";

const WINDOW = 60_000;

describe("limiter memory", () => {
  it("evicts 100,000 expired keys on the next call", () => {
    const limiter = createLimiter(10, WINDOW);
    for (let i = 0; i < 100_000; i++) limiter.check(`ip-${i}`, 0);
    expect(limiter.size()).toBe(100_000); // every window is still live
    limiter.check("later", WINDOW);
    expect(limiter.size()).toBe(1);
  });

  it("stays bounded by the live windows while keys arrive over time", () => {
    const limiter = createLimiter(10, WINDOW);
    let peak = 0;
    for (let i = 0; i < 100_000; i++) {
      limiter.check(`ip-${i}`, i); // one new key per millisecond
      peak = Math.max(peak, limiter.size());
    }
    expect(peak).toBeLessThanOrEqual(WINDOW + 1); // never more than one minute of keys
    limiter.check("much-later", 100_000 + WINDOW);
    expect(limiter.size()).toBe(1);
  });

  it("never evicts a live window, however many expired keys surround it", () => {
    const limiter = createLimiter(10, WINDOW);
    for (let i = 0; i < 100_000; i++) limiter.check(`junk-${i}`, 0);
    for (let k = 0; k < 5_000; k++) {
      for (let n = 0; n < 10; n++) expect(limiter.check(`live-${k}`, 30_000).allowed).toBe(true);
    }
    // junk windows expired at 60,000; the live windows started at 30,000 and end at 90,000
    limiter.check("trigger", 70_000);
    expect(limiter.size()).toBe(5_001);
    for (let k = 0; k < 5_000; k++) {
      expect(limiter.check(`live-${k}`, 70_000)).toEqual({ allowed: false, retryAfterMs: 20_000 });
    }
    expect(limiter.size()).toBe(5_001); // denied calls add nothing
  });

  it("does not grow on denied calls", () => {
    const limiter = createLimiter(1, WINDOW);
    limiter.check("a", 0);
    for (let i = 0; i < 1_000; i++) expect(limiter.check("a", i).allowed).toBe(false);
    expect(limiter.size()).toBe(1);
  });

  it("starts a fresh window for a key used again after expiry", () => {
    const limiter = createLimiter(1, WINDOW);
    expect(limiter.check("a", 0).allowed).toBe(true);
    expect(limiter.check("a", WINDOW - 1)).toEqual({ allowed: false, retryAfterMs: 1 });
    for (let i = 0; i < 1_000; i++) limiter.check(`other-${i}`, 1_000);
    expect(limiter.check("a", WINDOW)).toEqual({ allowed: true });
    expect(limiter.check("a", WINDOW + 1)).toEqual({ allowed: false, retryAfterMs: WINDOW - 1 });
  });

  it("never drops a live window even when the clock is not monotone across keys", () => {
    const limiter = createLimiter(1, WINDOW);
    limiter.check("late", 50_000);
    limiter.check("early", 0); // out of order: stored after "late"
    limiter.check("probe", 60_000); // "early" expired, "late" is live
    expect(limiter.check("late", 60_000)).toEqual({ allowed: false, retryAfterMs: 50_000 });
  });
});

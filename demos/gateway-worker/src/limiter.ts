// Fixed-window rate limiter held in memory by one isolate (best-effort: several isolates each
// have their own counters). A pure function of the key and an injected time.

export type LimiterResult = { allowed: boolean; retryAfterMs?: number };

export interface RateLimiter {
  check(key: string, now: number): LimiterResult;
}

/** A limiter that also reports how many windows it stores (for tests and diagnostics). */
export interface MeasuredLimiter extends RateLimiter {
  size(): number;
}

type Window = { start: number; count: number };

/**
 * `limit` calls per `windowMs` per key. The window of a key starts at its first call; the
 * `limit + 1`th call inside the window is denied with `retryAfterMs = start + windowMs - now`;
 * a denied call changes nothing; a call at `now >= start + windowMs` starts a new window.
 *
 * Memory: windows live in a `Map` in insertion order, and a window is (re)inserted only when it
 * is created, so for a clock that does not go backwards the map is ordered by `start` and the
 * expired windows are exactly a prefix. Every call drops that prefix, which makes eviction
 * amortised O(1). A live window is never dropped: the sweep stops at the first live one.
 */
export function createLimiter(limit: number, windowMs: number): MeasuredLimiter {
  const windows = new Map<string, Window>();

  return {
    check(key, now) {
      for (const [oldKey, w] of windows) {
        if (now < w.start + windowMs) break;
        windows.delete(oldKey);
      }

      let w = windows.get(key);
      if (w === undefined || now >= w.start + windowMs) {
        windows.delete(key); // re-insert at the end so the map stays ordered by start
        w = { start: now, count: 0 };
        windows.set(key, w);
      }
      if (w.count < limit) {
        w.count += 1;
        return { allowed: true };
      }
      return { allowed: false, retryAfterMs: w.start + windowMs - now };
    },
    size() {
      return windows.size;
    },
  };
}

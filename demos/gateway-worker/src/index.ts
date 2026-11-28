import { handle, type Env } from "./handler.js";
import { createLimiter } from "./limiter.js";
import { LIMITS } from "./limits.js";

export { handle, limiterKey } from "./handler.js";
export type { Deps, Env } from "./handler.js";
export { createLimiter } from "./limiter.js";
export type { LimiterResult, MeasuredLimiter, RateLimiter } from "./limiter.js";
export { LIMITS } from "./limits.js";

// One limiter per isolate: best-effort, since several isolates each count on their own.
const limiter = createLimiter(LIMITS.rateLimit, LIMITS.rateWindowMs);

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env, {
      fetch: (input, init) => fetch(input, init),
      now: () => Date.now(),
      limiter,
    });
  },
};

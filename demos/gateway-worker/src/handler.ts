// The request handler: orchestrates the steps of the contract in order (path, method, origin,
// preflight, body size, JSON, shape, limits, rate limit, key, upstream). A step either answers
// or lets the request continue; later steps cost nothing once one has answered.
//
// Nothing here logs: the user key and the server key must never reach a log line.

import { commonHeaders, parseAllowlist, preflightHeaders } from "./cors.js";
import {
  buildUpstreamBody,
  mapFetchFailure,
  mapUpstreamResponse,
  upstreamUrl,
  type ErrorKind,
  type Outcome,
} from "./gemini.js";
import { parseJson } from "./json.js";
import type { RateLimiter } from "./limiter.js";
import { LIMITS, validateRequest } from "./limits.js";

export type Env = {
  GEMINI_API_KEY?: string;
  GEMINI_MODEL: string;
  ALLOWED_ORIGINS: string;
};

export type Deps = {
  fetch: typeof fetch;
  now(): number;
  limiter: RateLimiter;
};

const PATH = "/v1/complete";

/** The limiter key: the client IP as the runtime delivers it, or one shared bucket. */
export function limiterKey(headers: Headers): string {
  const ip = headers.get("cf-connecting-ip");
  return ip !== null && ip !== "" ? ip : "unknown";
}

function errorResponse(
  status: number,
  kind: ErrorKind,
  cors: string | null,
  retryAfterMs?: number,
  extra?: Record<string, string>,
): Response {
  const headers = commonHeaders(cors);
  headers.set("content-type", "application/json");
  if (extra !== undefined) for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  const error: { kind: ErrorKind; retryAfterMs?: number } = { kind };
  if (status === 429 && retryAfterMs !== undefined) {
    error.retryAfterMs = retryAfterMs;
    headers.set("retry-after", String(Math.ceil(retryAfterMs / 1000)));
  }
  return new Response(JSON.stringify({ error }), { status, headers });
}

/** Reads at most `limit` bytes of the body: null when it is larger (the rest is never read). */
async function readBodyCapped(request: Request, limit: number): Promise<Uint8Array | null> {
  const stream = request.body;
  if (stream === null) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Handles one request. Never throws: an unexpected internal error is `503 unavailable`. */
export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  let cors: string | null = null;
  try {
    const origin = request.headers.get("origin");
    if (origin !== null && parseAllowlist(env?.ALLOWED_ORIGINS).has(origin)) cors = origin;
    return await run(request, env, deps, origin !== null, cors);
  } catch {
    return errorResponse(503, "unavailable", cors);
  }
}

async function run(
  request: Request,
  env: Env,
  deps: Deps,
  hasOrigin: boolean,
  cors: string | null,
): Promise<Response> {
  // 1. Path: exact, no normalization (the query string is not part of it).
  if (new URL(request.url).pathname !== PATH) return errorResponse(404, "unavailable", cors);

  // 2. Method.
  const method = request.method;
  if (method !== "POST" && method !== "OPTIONS") {
    return errorResponse(405, "unavailable", cors, undefined, { allow: "POST, OPTIONS" });
  }

  // 3. Origin: present and not allowlisted is 403; absent is allowed.
  if (hasOrigin && cors === null) return errorResponse(403, "unavailable", cors);

  // 4. Preflight: never reads the body, never consumes a rate-limit slot.
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: preflightHeaders(cors) });

  // 5. Body size, in bytes; the body must be valid UTF-8.
  let bytes: Uint8Array | null;
  try {
    bytes = await readBodyCapped(request, LIMITS.bodyBytes);
  } catch {
    return errorResponse(400, "invalid_output", cors); // the body could not be read
  }
  if (bytes === null) return errorResponse(400, "invalid_output", cors);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return errorResponse(400, "invalid_output", cors);
  }

  // 6. JSON (strict).
  const json = parseJson(text);
  if (!json.ok) return errorResponse(400, "invalid_output", cors);

  // 7-8. Shape and limits.
  const valid = validateRequest(json.value);
  if (valid === null) return errorResponse(400, "invalid_output", cors);

  // 9. Rate limit: this request consumes its slot whatever happens next.
  const verdict = deps.limiter.check(limiterKey(request.headers), deps.now());
  if (!verdict.allowed) return errorResponse(429, "rate_limit", cors, verdict.retryAfterMs);

  // 10. Key: the user key, else the server key, else none.
  const userKey = request.headers.get("x-ilabs-api-key");
  const serverKey = typeof env?.GEMINI_API_KEY === "string" ? env.GEMINI_API_KEY : "";
  const key = userKey !== null && userKey !== "" ? userKey : serverKey;
  if (key === "") return errorResponse(503, "unavailable", cors);

  // 11. Upstream: one call, no retry.
  const url = upstreamUrl(env?.GEMINI_MODEL);
  if (url === null) return errorResponse(503, "unavailable", cors); // a deployment error

  let outcome: Outcome;
  try {
    const upstream = await deps.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: buildUpstreamBody(valid),
      signal: AbortSignal.timeout(LIMITS.upstreamTimeoutMs),
      redirect: "manual",
    });
    outcome = await mapUpstreamResponse(upstream);
  } catch (error) {
    outcome = mapFetchFailure(error);
  }

  if (!outcome.ok) return errorResponse(outcome.status, outcome.kind, cors, outcome.retryAfterMs);
  const headers = commonHeaders(cors);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify({ text: outcome.text, provider: "gateway" }), { status: 200, headers });
}

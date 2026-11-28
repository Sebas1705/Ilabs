// Test harness for the gateway contract (contracts/gateway/README.md): loads the fixtures,
// rejects malformed ones with the README's `invalid fixture: <reason>` messages, and runs the
// `handler` and `limiter` kinds against this package. Not part of the Worker bundle.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handle, limiterKey, type Env } from "./handler.js";
import { createLimiter } from "./limiter.js";

export const CONTRACT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../contracts/gateway");
export const NOW = 1_000_000;

type Json = unknown;
type Obj = Record<string, Json>;

export type UpstreamEntry = {
  status?: number;
  body?: string | Obj;
  headers?: Record<string, string>;
  bodyThrows?: boolean;
  throws?: "timeout" | "network";
};

export type RequestSpec = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | Obj | null;
};

export type HandlerFixture = {
  kind: "handler";
  name: string;
  env: { GEMINI_API_KEY?: string; GEMINI_MODEL: string; ALLOWED_ORIGINS: string };
  request: RequestSpec;
  before?: RequestSpec[];
  limiterPreload?: number;
  limiterPreloadAgeMs?: number;
  limiterPreloadKey?: string;
  upstream: UpstreamEntry[];
  expect: {
    status: number;
    body?: Obj;
    headers?: Record<string, string | null>;
    upstreamCalls: number;
    upstream?: {
      model: string;
      key: string;
      maxOutputTokens: number;
      contentsCount: number;
      systemInstruction?: string | null;
      contents?: { role: string; text: string }[];
    };
  };
};

export type LimiterFixture = {
  kind: "limiter";
  name: string;
  limit: number;
  windowMs: number;
  calls: { key: string; now: number }[];
  expect: { allowed: boolean; retryAfterMs?: number }[];
};

export type ClientFixture = { kind: "client"; name: string };
export type Fixture = HandlerFixture | LimiterFixture | ClientFixture;

// ---------------------------------------------------------------- loading and validation

export function loadRaw(dir: string = CONTRACT_DIR): { file: string; raw: Json }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => ({ file, raw: JSON.parse(readFileSync(join(dir, file), "utf8")) as Json }));
}

function invalid(reason: string): never {
  throw new Error(`invalid fixture: ${reason}`);
}

type Type = "string" | "integer" | "boolean" | "object" | "array" | "any";
type Spec = Record<string, [Type, boolean]>; // [type, required]

function isPlainObject(v: Json): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function matches(v: Json, type: Type): boolean {
  switch (type) {
    case "string":
      return typeof v === "string";
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "object":
      return isPlainObject(v);
    case "array":
      return Array.isArray(v);
    case "any":
      return true;
  }
}

function check(value: Json, spec: Spec): Obj {
  if (!isPlainObject(value)) invalid("wrong type: <object>");
  for (const key of Object.keys(value)) if (!(key in spec)) invalid(`unknown key: ${key}`);
  for (const [key, [, required]] of Object.entries(spec)) if (required && !(key in value)) invalid(`missing key: ${key}`);
  for (const [key, [type]] of Object.entries(spec)) {
    if (key in value && !matches(value[key], type)) invalid(`wrong type: ${key}`);
  }
  return value;
}

const REQUEST_SPEC: Spec = { method: ["string", true], path: ["string", true], headers: ["object", true], body: ["any", true] };

function checkRequest(value: Json): RequestSpec {
  const request = check(value, REQUEST_SPEC);
  for (const header of Object.values(request.headers as Obj)) if (typeof header !== "string") invalid("wrong type: headers");
  const body = request.body;
  if (body !== null && typeof body !== "string" && !isPlainObject(body)) invalid("wrong type: body");
  return request as unknown as RequestSpec;
}

/** Validates the raw JSON of a fixture; throws `invalid fixture: <reason>` (the README's reasons). */
export function validateFixture(raw: Json): Fixture {
  if (!isPlainObject(raw)) invalid("wrong type: <object>");
  const kind = raw.kind;
  if (kind === "client") return raw as unknown as ClientFixture; // run by the providers harnesses
  if (kind === "limiter") return validateLimiter(raw);
  if (kind === "handler") return validateHandler(raw);
  return invalid(`unknown fixture kind: ${String(kind)}`);
}

function validateLimiter(raw: Obj): LimiterFixture {
  const fx = check(raw, {
    kind: ["string", true],
    name: ["string", true],
    limit: ["integer", true],
    windowMs: ["integer", true],
    calls: ["array", true],
    expect: ["array", true],
  });
  for (const call of fx.calls as Json[]) check(call, { key: ["string", true], now: ["integer", true] });
  for (const e of fx.expect as Json[]) check(e, { allowed: ["boolean", true], retryAfterMs: ["integer", false] });
  if ((fx.calls as Json[]).length !== (fx.expect as Json[]).length) invalid("limiter calls and expect differ in length");
  return fx as unknown as LimiterFixture;
}

function validateHandler(raw: Obj): HandlerFixture {
  const fx = check(raw, {
    kind: ["string", true],
    name: ["string", true],
    env: ["object", true],
    request: ["object", true],
    before: ["array", false],
    limiterPreload: ["any", false],
    limiterPreloadAgeMs: ["any", false],
    limiterPreloadKey: ["string", false],
    upstream: ["array", true],
    expect: ["object", true],
  });
  check(fx.env, { GEMINI_API_KEY: ["string", false], GEMINI_MODEL: ["string", true], ALLOWED_ORIGINS: ["string", true] });
  checkRequest(fx.request);
  for (const b of (fx.before as Json[] | undefined) ?? []) checkRequest(b);

  const preload = fx.limiterPreload;
  if (preload !== undefined && !(typeof preload === "number" && Number.isInteger(preload) && preload >= 0 && preload <= 10)) {
    invalid("limiterPreload must be an integer from 0 to 10");
  }
  const age = fx.limiterPreloadAgeMs;
  if (age !== undefined && !(typeof age === "number" && Number.isInteger(age) && age >= 0 && age <= 60_000)) {
    invalid("limiterPreloadAgeMs must be an integer from 0 to 60000");
  }

  (fx.upstream as Json[]).forEach((entry, index) => {
    const e = check(entry, {
      status: ["integer", false],
      body: ["any", false],
      headers: ["object", false],
      bodyThrows: ["boolean", false],
      throws: ["string", false],
    });
    if (e.status === undefined && e.throws === undefined) invalid(`upstream entry ${index + 1} has neither status nor throws`);
    if (e.throws !== undefined && e.throws !== "timeout" && e.throws !== "network") invalid(`unknown throw kind: ${String(e.throws)}`);
  });

  const expectation = check(fx.expect, {
    status: ["integer", true],
    body: ["object", false],
    headers: ["object", false],
    upstreamCalls: ["integer", true],
    upstream: ["object", false],
  });
  if (expectation.upstreamCalls !== 0 && expectation.upstreamCalls !== 1) invalid("upstreamCalls must be 0 or 1");
  if (expectation.upstreamCalls === 1 && expectation.upstream === undefined) invalid("expect.upstream is required when upstreamCalls is 1");
  if (expectation.upstreamCalls === 0 && expectation.upstream !== undefined) invalid("expect.upstream is not allowed when upstreamCalls is 0");
  if (expectation.upstream !== undefined) {
    check(expectation.upstream, {
      model: ["string", true],
      key: ["string", true],
      maxOutputTokens: ["integer", true],
      contentsCount: ["integer", true],
      systemInstruction: ["any", false],
      contents: ["array", false],
    });
  }
  return fx as unknown as HandlerFixture;
}

// ---------------------------------------------------------------- running a handler fixture

export type Recorded = { url: string; method: string; headers: Headers; body: string; signal: AbortSignal | null };

export type HandlerRun = {
  response: Response;
  text: string;
  calls: Recorded[];
  overrun: boolean;
  secrets: string[];
};

function toBodyText(body: string | Obj | undefined): string {
  if (body === undefined) return "";
  return typeof body === "string" ? body : JSON.stringify(body);
}

function upstreamResponse(entry: UpstreamEntry): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(entry.headers ?? {})) headers.set(name, value);
  const status = entry.status ?? 200;
  if (entry.bodyThrows === true) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
        controller.error(new Error("connection reset while reading the body"));
      },
    });
    return new Response(stream, { status, headers });
  }
  const text = toBodyText(entry.body);
  return new Response(text === "" ? null : text, { status, headers });
}

export function buildRequest(spec: RequestSpec): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(spec.headers)) headers.set(name, value);
  const init: RequestInit = { method: spec.method, headers };
  if (spec.body !== null) init.body = typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body);
  return new Request(`https://gateway.example.test${spec.path}`, init);
}

export async function runHandlerFixture(fx: HandlerFixture): Promise<HandlerRun> {
  const limiter = createLimiter(10, 60_000);
  const calls: Recorded[] = [];
  let overrun = false;
  let next = 0;

  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const entry = fx.upstream[next++];
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
      signal: init?.signal ?? null,
    });
    if (entry === undefined) {
      overrun = true;
      throw new Error("upstream called more than scripted");
    }
    if (entry.throws === "timeout") throw new DOMException("The operation timed out", "TimeoutError");
    if (entry.throws === "network") throw new TypeError("fetch failed");
    return upstreamResponse(entry);
  }) as typeof fetch;

  const deps = { fetch: fakeFetch, now: () => NOW, limiter };
  const env = fx.env as Env;

  const preload = fx.limiterPreload ?? 0;
  if (preload > 0) {
    const key = fx.limiterPreloadKey ?? limiterKey(buildRequest(fx.request).headers);
    for (let i = 0; i < preload; i++) {
      if (!limiter.check(key, NOW - (fx.limiterPreloadAgeMs ?? 0)).allowed) throw new Error("preload denied");
    }
  }
  for (const before of fx.before ?? []) await handle(buildRequest(before), env, deps);

  const response = await handle(buildRequest(fx.request), env, deps);
  const text = await response.text();
  const secrets = ["FIXTURE_SERVER_KEY", "FIXTURE_USER_KEY"];
  return { response, text, calls, overrun, secrets };
}

/** Every failed check of one handler fixture (empty when it passes). */
export function judgeHandlerRun(fx: HandlerFixture, run: HandlerRun): string[] {
  const failures: string[] = [];
  const fail = (message: string): void => void failures.push(message);
  const { response, text, calls } = run;

  if (run.overrun) fail("upstream called more than scripted");
  if (response.status !== fx.expect.status) fail(`status ${response.status}, expected ${fx.expect.status}`);

  if (fx.expect.body === undefined) {
    if (text !== "") fail(`body must be empty, got ${text}`);
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      fail(`body is not JSON: ${text}`);
    }
    if (parsed !== undefined && JSON.stringify(sortKeys(parsed)) !== JSON.stringify(sortKeys(fx.expect.body))) {
      fail(`body ${text}, expected ${JSON.stringify(fx.expect.body)}`);
    }
  }

  for (const [name, want] of Object.entries(fx.expect.headers ?? {})) {
    const got = response.headers.get(name);
    if (got !== want) fail(`header ${name}: ${String(got)}, expected ${String(want)}`);
  }

  // Rules that hold for every response.
  if (response.headers.get("vary") !== "Origin") fail("vary: Origin missing");
  if (response.headers.get("cache-control") !== "no-store") fail("cache-control: no-store missing");
  const wantType = text === "" ? null : "application/json";
  if (response.headers.get("content-type") !== wantType) fail(`content-type ${String(response.headers.get("content-type"))}`);
  if (response.headers.has("access-control-allow-credentials")) fail("access-control-allow-credentials sent");
  if (response.status !== 429 && response.headers.has("retry-after")) fail("retry-after outside a 429");
  if (response.status !== 405 && response.headers.has("allow")) fail("allow outside a 405");
  const origin = new Headers(fx.request.headers).get("origin");
  const allowed = origin !== null && originAllowed(fx.env.ALLOWED_ORIGINS, origin);
  const acao = response.headers.get("access-control-allow-origin");
  if (allowed ? acao !== origin : acao !== null) fail(`access-control-allow-origin ${String(acao)}`);

  for (const secret of run.secrets) {
    if (text.includes(secret)) fail(`${secret} in the body`);
    for (const [name, value] of response.headers) {
      if (name.includes(secret) || value.includes(secret)) fail(`${secret} in a header`);
    }
  }
  if (response.headers.has("x-ilabs-api-key") || response.headers.has("x-goog-api-key")) fail("key header echoed");

  // The upstream calls.
  if (calls.length !== fx.expect.upstreamCalls) fail(`${calls.length} upstream calls, expected ${fx.expect.upstreamCalls}`);
  for (const call of calls) {
    if (call.method !== "POST") fail(`upstream method ${call.method}`);
    const names = [...call.headers.keys()].sort();
    if (names.join(",") !== "content-type,x-goog-api-key") fail(`upstream headers ${names.join(",")}`);
    if (call.headers.get("content-type") !== "application/json") fail("upstream content-type");
    if (!(call.signal instanceof AbortSignal)) fail("upstream signal is not an AbortSignal");
    else if (call.signal.aborted) fail("upstream signal already aborted");
  }
  const want = fx.expect.upstream;
  const first = calls[0];
  if (want !== undefined && first !== undefined) judgeUpstream(want, first, fail);
  return failures;
}

function originAllowed(list: string, origin: string): boolean {
  // An independent, deliberately simple reading of E3/E4, used only to predict the CORS header.
  const entry = /^(?:https?):\/\/(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::[1-9][0-9]{0,4})?$/;
  return list
    .split(",")
    .map((e) => e.replace(/^[ \t]+|[ \t]+$/g, ""))
    .some((e) => {
      if (e === "" || !entry.test(e) || e !== origin) return false;
      const port = /:([0-9]+)$/.exec(e);
      return port === null || Number(port[1]) <= 65_535;
    });
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}

function judgeUpstream(
  want: NonNullable<HandlerFixture["expect"]["upstream"]>,
  call: Recorded,
  fail: (message: string) => void,
): void {
  const expectedUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(want.model)}:generateContent`;
  if (call.url !== expectedUrl) fail(`upstream url ${call.url}, expected ${expectedUrl}`);
  if (call.headers.get("x-goog-api-key") !== want.key) fail("upstream key marker differs");
  let body: Obj;
  try {
    body = JSON.parse(call.body) as Obj;
  } catch {
    fail("upstream body is not JSON");
    return;
  }
  const keys = Object.keys(body).sort().join(",");
  const allowedKeys = ["contents,generationConfig", "contents,generationConfig,systemInstruction"];
  if (!allowedKeys.includes(keys)) fail(`upstream body keys ${keys}`);
  const generation = body.generationConfig as Obj;
  if (Object.keys(generation).join(",") !== "maxOutputTokens") fail("generationConfig has other keys");
  if (generation.maxOutputTokens !== want.maxOutputTokens) fail(`maxOutputTokens ${String(generation.maxOutputTokens)}`);
  const contents = body.contents as { role: string; parts: { text: string }[] }[];
  if (contents.length !== want.contentsCount) fail(`${contents.length} contents, expected ${want.contentsCount}`);
  if (want.systemInstruction !== undefined) {
    const system = body.systemInstruction as { parts: { text: string }[] } | undefined;
    if (want.systemInstruction === null ? system !== undefined : system?.parts[0]?.text !== want.systemInstruction) {
      fail("systemInstruction differs");
    }
  }
  if (want.contents !== undefined) {
    const got = contents.map((c) => ({ role: c.role, text: c.parts[0]?.text }));
    if (JSON.stringify(got) !== JSON.stringify(want.contents)) fail("contents differ");
  }
}

// ---------------------------------------------------------------- running a limiter fixture

export function runLimiterFixture(fx: LimiterFixture): string[] {
  const failures: string[] = [];
  const limiter = createLimiter(fx.limit, fx.windowMs);
  fx.calls.forEach((call, i) => {
    const got = limiter.check(call.key, call.now);
    const want = fx.expect[i];
    if (want === undefined) return;
    if (got.allowed !== want.allowed) failures.push(`call ${i + 1}: allowed ${got.allowed}`);
    if (got.retryAfterMs !== want.retryAfterMs) failures.push(`call ${i + 1}: retryAfterMs ${String(got.retryAfterMs)}`);
  });
  return failures;
}

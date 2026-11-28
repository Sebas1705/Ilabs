import { HttpProvider, TransportTimeoutError, type HttpRequest, type HttpResponse } from "./http.js";
import { ProviderError, type CompletionRequest, type CompletionResponse, type ErrorKind } from "./types.js";

export type ClientOutcome = CompletionResponse | { error: { kind: ErrorKind; retryAfterMs?: number } };

export interface ClientFixture {
  kind: "client";
  name: string;
  endpoint: string;
  id?: string;
  apiKey?: string;
  timeoutMs?: number;
  request: CompletionRequest;
  transport: ({ status: number; body?: unknown; headers?: Record<string, string> } | { throws: "timeout" | "network" })[];
  expect: {
    result: ClientOutcome;
    requests: { url: string; method: string; headers: Record<string, string>; body: unknown; timeoutMs: number }[];
  };
}

export interface ClientRun {
  result: ClientOutcome;
  /** The transport calls the client made, as the client handed them over (`body` is the JSON text). */
  requests: HttpRequest[];
}

type Obj = Record<string, unknown>;

function invalid(reason: string): never {
  throw new Error(`invalid fixture: ${reason}`);
}

function isObject(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Rejects unknown keys, then missing required keys; every present key is then type-checked by `types`. */
function checkObject(value: unknown, key: string, required: string[], optional: string[], types: Record<string, (v: unknown) => boolean>): Obj {
  if (!isObject(value)) invalid(`wrong type: ${key}`);
  const allowed = new Set([...required, ...optional]);
  for (const k of Object.keys(value)) if (!allowed.has(k)) invalid(`unknown key: ${k}`);
  for (const k of required) if (!(k in value)) invalid(`missing key: ${k}`);
  for (const k of Object.keys(value)) {
    const ok = types[k];
    if (ok !== undefined && !ok(value[k])) invalid(`wrong type: ${k}`);
  }
  return value;
}

const isString = (v: unknown): boolean => typeof v === "string";
const isInteger = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v);
const isStringMap = (v: unknown): boolean => isObject(v) && Object.values(v).every((x) => typeof x === "string");

function validate(fixture: unknown): ClientFixture {
  const top = isObject(fixture) ? fixture : invalid("wrong type: fixture");
  if (typeof top.kind !== "string") invalid("wrong type: kind");
  if (top.kind !== "client") invalid(`unknown fixture kind: ${top.kind}`);
  checkObject(top, "fixture", ["kind", "name", "endpoint", "request", "transport", "expect"], ["id", "apiKey", "timeoutMs"], {
    name: isString,
    endpoint: isString,
    id: isString,
    apiKey: isString,
    timeoutMs: (v) => typeof v === "number",
  });

  const request = checkObject(top.request, "request", ["messages"], ["maxTokens"], {
    messages: Array.isArray,
    maxTokens: (v) => v === null || typeof v === "number",
  });
  for (const m of request.messages as unknown[]) {
    checkObject(m, "messages", ["role", "content"], [], { role: isString, content: isString });
  }

  if (!Array.isArray(top.transport)) invalid("wrong type: transport");
  if (top.transport.length !== 1) invalid("transport needs exactly one entry");
  const entry = isObject(top.transport[0]) ? top.transport[0] : invalid("wrong type: transport");
  checkObject(entry, "transport", [], ["status", "body", "headers", "throws"], {
    status: isInteger,
    headers: isStringMap,
    throws: isString,
  });
  if ("throws" in entry) {
    if (entry.throws !== "timeout" && entry.throws !== "network") invalid(`unknown throw kind: ${String(entry.throws)}`);
  } else if (!("status" in entry)) {
    invalid("missing key: status");
  }

  const expect = checkObject(top.expect, "expect", ["result", "requests"], [], { requests: Array.isArray });
  const result = checkObject(expect.result, "result", [], ["text", "provider", "error"], {
    text: isString,
    provider: isString,
  });
  if ("error" in result) {
    for (const k of ["text", "provider"]) if (k in result) invalid(`unknown key: ${k}`);
    const error = checkObject(result.error, "error", ["kind"], ["retryAfterMs"], { kind: isString, retryAfterMs: isInteger });
    if (!["rate_limit", "timeout", "invalid_output", "unavailable"].includes(error.kind as string)) {
      invalid(`wrong type: kind`);
    }
  } else {
    for (const k of ["text", "provider"]) if (!(k in result)) invalid(`missing key: ${k}`);
  }
  for (const r of expect.requests as unknown[]) {
    checkObject(r, "requests", ["url", "method", "headers", "body", "timeoutMs"], [], {
      url: isString,
      method: isString,
      headers: isStringMap,
      timeoutMs: (v) => typeof v === "number",
    });
  }
  return top as unknown as ClientFixture;
}

/** Runs a client contract fixture against `HttpProvider` with a scripted transport. Browser-safe. */
export async function runClientFixture(fixture: unknown): Promise<ClientRun> {
  const fx = validate(fixture);
  const entry = fx.transport[0] as { status?: number; body?: unknown; headers?: Record<string, string>; throws?: string };
  const requests: HttpRequest[] = [];

  const provider = new HttpProvider({
    endpoint: fx.endpoint,
    ...(fx.id !== undefined ? { id: fx.id } : {}),
    ...(fx.apiKey !== undefined ? { apiKey: fx.apiKey } : {}),
    ...(fx.timeoutMs !== undefined ? { timeoutMs: fx.timeoutMs } : {}),
    transport: async (req): Promise<HttpResponse> => {
      requests.push({ ...req, headers: { ...req.headers } });
      if (entry.throws === "timeout") throw new TransportTimeoutError();
      if (entry.throws === "network") throw new TypeError("fetch failed");
      const body = entry.body === undefined ? "" : typeof entry.body === "string" ? entry.body : JSON.stringify(entry.body);
      return { status: entry.status as number, headers: { ...(entry.headers ?? {}) }, body };
    },
  });

  let result: ClientOutcome;
  try {
    result = await provider.complete(fx.request);
  } catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    result = { error: e.retryAfterMs !== undefined ? { kind: e.kind, retryAfterMs: e.retryAfterMs } : { kind: e.kind } };
  }
  return { result, requests };
}

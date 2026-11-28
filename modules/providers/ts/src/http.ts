import { JsonNumber, parseStrictJson, readCappedNonNegativeInteger, type JsonValue } from "./strict-json.js";
import {
  ProviderError,
  type CompletionRequest,
  type CompletionResponse,
  type ErrorKind,
  type Provider,
} from "./types.js";

export type HttpRequest = {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
};

export type HttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

/** Sends one request. Rejects with `TransportTimeoutError` on a timeout; any other rejection is a network failure. */
export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;

export class TransportTimeoutError extends Error {
  constructor(message = "transport timeout") {
    super(message);
    this.name = "TransportTimeoutError";
  }
}

export interface HttpProviderOptions {
  id?: string;
  endpoint: string;
  transport: HttpTransport;
  /** Missing or `null` means no key. */
  apiKey?: string | null;
  /** A positive safe integer. */
  timeoutMs?: number;
}

const DEFAULT_ID = "gateway";
const DEFAULT_TIMEOUT_MS = 25_000;
const DELAY_CAP_MS = 3_600_000;
const KINDS: readonly string[] = ["rate_limit", "timeout", "invalid_output", "unavailable"];

/** True when the text has at least one character other than space, tab, CR and LF. */
function hasVisibleCharacter(text: string): boolean {
  return /[^ \t\r\n]/.test(text);
}

/** `text` without its trailing `/` characters, in one linear pass (no backtracking regex on caller input). */
function trimTrailingSlashes(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 47) end--;
  return text.slice(0, end);
}

function asciiLower(name: string): string {
  return name.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** `retry-after` in milliseconds from the transport headers, or undefined; capped, exact, never through a float. */
function retryAfterHeaderMs(headers: Record<string, string>): number | undefined {
  let value: string | undefined;
  for (const name of Object.keys(headers)) {
    // Names are matched case-insensitively (ASCII only); when two names differ only in case the last wins.
    if (asciiLower(name) === "retry-after") value = headers[name];
  }
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return undefined;
  const seconds = value.replace(/^0+/, "");
  if (seconds === "") return 0;
  if (seconds.length > 7) return DELAY_CAP_MS; // at least 10^7 seconds
  return Math.min(Number(seconds) * 1000, DELAY_CAP_MS);
}

function object(value: JsonValue | undefined): Map<string, JsonValue> | undefined {
  return value instanceof Map ? value : undefined;
}

/** Maps a non-200 answer: the kind comes from the body, `retryAfterMs` only for `rate_limit`. */
function failure(res: HttpResponse): ProviderError {
  const error = object(object(parseStrictJson(res.body))?.get("error"));
  const kind = error?.get("kind");
  if (typeof kind !== "string" || !KINDS.includes(kind)) return new ProviderError("unavailable");
  if (kind !== "rate_limit") return new ProviderError(kind as ErrorKind);
  const fromBody = error?.get("retryAfterMs");
  const ms =
    fromBody instanceof JsonNumber
      ? (readCappedNonNegativeInteger(fromBody, DELAY_CAP_MS) ?? retryAfterHeaderMs(res.headers))
      : retryAfterHeaderMs(res.headers);
  return new ProviderError("rate_limit", ms);
}

export class HttpProvider implements Provider {
  readonly id: string;
  private readonly url: string;
  private readonly transport: HttpTransport;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  constructor(options: HttpProviderOptions) {
    const id = options.id ?? DEFAULT_ID;
    if (id === "") throw new RangeError("id must not be empty");
    const base = trimTrailingSlashes(options.endpoint);
    if (base === "") throw new RangeError("endpoint must not be empty or only slashes");
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError("timeoutMs must be a positive safe integer");
    this.id = id;
    this.url = `${base}/v1/complete`;
    this.transport = options.transport;
    this.apiKey = options.apiKey != null && hasVisibleCharacter(options.apiKey) ? options.apiKey : undefined;
    this.timeoutMs = timeoutMs;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey !== undefined) headers["x-ilabs-api-key"] = this.apiKey;
    const payload: { messages: { role: string; content: string }[]; maxTokens?: number } = {
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (req.maxTokens !== undefined && req.maxTokens !== null) {
      if (!Number.isFinite(req.maxTokens) || !Number.isInteger(req.maxTokens)) {
        throw new TypeError("maxTokens must be a finite integer");
      }
      payload.maxTokens = req.maxTokens;
    }
    // Built before the transport call: a request that cannot be serialized is a programming error, never `unavailable`.
    const requestBody = JSON.stringify(payload);

    let res: HttpResponse;
    try {
      res = await this.transport({ url: this.url, method: "POST", headers, body: requestBody, timeoutMs: this.timeoutMs });
    } catch (e) {
      throw new ProviderError(e instanceof TransportTimeoutError ? "timeout" : "unavailable");
    }
    const answer: HttpResponse = {
      status: res.status,
      headers: res.headers ?? {},
      body: typeof res.body === "string" ? res.body : "",
    };

    if (answer.status !== 200) throw failure(answer);
    const body = object(parseStrictJson(answer.body));
    const text = body?.get("text");
    if (typeof text !== "string") throw new ProviderError("invalid_output");
    const provider = body?.get("provider");
    return { text, provider: typeof provider === "string" && hasVisibleCharacter(provider) ? provider : this.id };
  }
}

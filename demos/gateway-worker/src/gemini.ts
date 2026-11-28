// The Gemini exchange: building the upstream request and mapping every upstream outcome to the
// gateway's own answer. Upstream bodies and headers are never forwarded.

import { isObject, parseJson, type JsonObject, type JsonValue } from "./json.js";
import { LIMITS, type ValidRequest } from "./limits.js";

export type ErrorKind = "rate_limit" | "timeout" | "invalid_output" | "unavailable";

/** What the handler answers for an upstream outcome. */
export type Outcome =
  | { ok: true; text: string }
  | { ok: false; status: number; kind: ErrorKind; retryAfterMs?: number };

const UPSTREAM_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
const RETRY_INFO_TYPE = "type.googleapis.com/google.rpc.RetryInfo";
const RETRY_DELAY = /^([0-9]+)(?:\.([0-9]{1,9}))?s$/;
const ASCII_DIGITS = /^[0-9]+$/;

const INVALID_OUTPUT: Outcome = { ok: false, status: 502, kind: "invalid_output" };
const UNAVAILABLE: Outcome = { ok: false, status: 503, kind: "unavailable" };

/**
 * The upstream URL for the configured model, or null when the model is a deployment error: not a
 * string, empty once spaces and tabs are removed, or not encodable (a lone surrogate).
 */
export function upstreamUrl(model: unknown): string | null {
  if (typeof model !== "string") return null;
  if (model.replace(/[ \t]/g, "") === "") return null;
  try {
    return `${UPSTREAM_BASE}${encodeURIComponent(model)}:generateContent`;
  } catch {
    return null;
  }
}

/** The JSON text of the upstream request body. */
export function buildUpstreamBody(request: ValidRequest): string {
  const system: string[] = [];
  const contents: { role: "user" | "model"; parts: { text: string }[] }[] = [];
  for (const message of request.messages) {
    if (message.role === "system") {
      system.push(message.content);
    } else {
      contents.push({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }],
      });
    }
  }
  const body: Record<string, unknown> = {};
  if (system.length > 0) body.systemInstruction = { parts: [{ text: system.join("\n\n") }] };
  body.contents = contents;
  body.generationConfig = { maxOutputTokens: request.maxTokens };
  return JSON.stringify(body);
}

/** The scripted or real upstream timeout is the only thing that is a gateway timeout. */
export function isTimeoutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === "TimeoutError" || name === "AbortError";
}

export function mapFetchFailure(error: unknown): Outcome {
  return isTimeoutError(error)
    ? { ok: false, status: 504, kind: "timeout" }
    : UNAVAILABLE;
}

/** Reads a body as bytes (never `Response.text()`, which drops a byte order mark) or null when unreadable. */
async function readText(response: Response): Promise<string | null> {
  try {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  } catch (error) {
    // A timeout while the body streams is still the gateway's timeout; anything else is unreadable.
    if (isTimeoutError(error)) throw error;
    return null;
  }
}

function releaseBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // nothing to release
  }
}

export async function mapUpstreamResponse(response: Response): Promise<Outcome> {
  if (response.status === 200) return mapSuccess(await readText(response));
  if (response.status === 429) return mapRateLimited(response, await readText(response));
  releaseBody(response);
  return UNAVAILABLE;
}

function mapSuccess(text: string | null): Outcome {
  if (text === null) return INVALID_OUTPUT;
  const parsed = parseJson(text);
  if (!parsed.ok || !isObject(parsed.value)) return INVALID_OUTPUT;

  const candidates = parsed.value.get("candidates");
  if (!Array.isArray(candidates) || candidates.length === 0) return INVALID_OUTPUT;
  const first = candidates[0];
  if (!isObject(first)) return INVALID_OUTPUT;

  const finishReason = first.get("finishReason");
  if (finishReason !== undefined && finishReason !== null && finishReason !== "STOP" && finishReason !== "MAX_TOKENS") {
    return INVALID_OUTPUT;
  }

  let out = "";
  const content = first.get("content");
  if (isObject(content)) {
    const parts = content.get("parts");
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (!isObject(part)) continue;
        const piece = part.get("text");
        if (typeof piece === "string") out += piece;
      }
    }
  }
  if (out === "") return INVALID_OUTPUT;
  return { ok: true, text: out };
}

function mapRateLimited(response: Response, text: string | null): Outcome {
  const retryAfterMs = retryDelayFromBody(text) ?? retryDelayFromHeader(response.headers.get("retry-after"));
  return retryAfterMs === null
    ? { ok: false, status: 429, kind: "rate_limit" }
    : { ok: false, status: 429, kind: "rate_limit", retryAfterMs };
}

function retryDelayFromBody(text: string | null): number | null {
  if (text === null) return null;
  const parsed = parseJson(text);
  if (!parsed.ok || !isObject(parsed.value)) return null;
  const error: JsonValue | undefined = parsed.value.get("error");
  if (!isObject(error)) return null;
  const details = error.get("details");
  if (!Array.isArray(details)) return null;
  for (const detail of details) {
    if (!isObject(detail)) continue;
    const ms = retryInfoDelay(detail);
    if (ms !== null) return ms;
  }
  return null;
}

function retryInfoDelay(detail: JsonObject): number | null {
  if (detail.get("@type") !== RETRY_INFO_TYPE) return null;
  const delay = detail.get("retryDelay");
  if (typeof delay !== "string") return null;
  const m = RETRY_DELAY.exec(delay);
  if (m === null) return null;
  const whole = digitsToBigInt(m[1] ?? "0");
  const fraction = m[2] ?? "";
  const first3 = fraction.slice(0, 3).padEnd(3, "0");
  const rest = fraction.slice(3);
  const roundUp = /[1-9]/.test(rest) ? 1n : 0n;
  return capMs(whole * 1000n + BigInt(first3) + roundUp);
}

function retryDelayFromHeader(value: string | null): number | null {
  if (value === null || !ASCII_DIGITS.test(value)) return null;
  return capMs(digitsToBigInt(value) * 1000n);
}

/** ASCII digits to a bigint; anything past twelve significant digits is far above the cap, so it is clamped. */
function digitsToBigInt(digits: string): bigint {
  const significant = digits.replace(/^0+/, "");
  if (significant.length > 12) return 10n ** 12n;
  return significant === "" ? 0n : BigInt(significant);
}

function capMs(ms: bigint): number {
  const cap = BigInt(LIMITS.retryDelayCapMs);
  return Number(ms > cap ? cap : ms);
}

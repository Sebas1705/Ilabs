import { integerValue, isObject, JsonNumber, type JsonValue } from "./json.js";

/** Every cap of the gateway. They are constants of the Worker, never read from a request. */
export const LIMITS = {
  bodyBytes: 65_536,
  minMessages: 1,
  maxMessages: 50,
  /** Characters are UTF-16 code units, as `String.length`. */
  maxContentChars: 8_000,
  maxTotalChars: 32_000,
  minMaxTokens: 1,
  maxMaxTokens: 1_024,
  defaultMaxTokens: 256,
  upstreamTimeoutMs: 20_000,
  rateLimit: 10,
  rateWindowMs: 60_000,
  retryDelayCapMs: 3_600_000,
  preflightMaxAgeSeconds: 600,
} as const;

export type Role = "system" | "user" | "assistant";
export type ChatMessage = { role: Role; content: string };
export type ValidRequest = { messages: ChatMessage[]; maxTokens: number };

function isRole(value: JsonValue | undefined): value is Role {
  return value === "system" || value === "user" || value === "assistant";
}

/**
 * Validates the parsed request body (handler steps 7 and 8). Returns the typed request, or null
 * when anything is wrong: every failure is the same `400 invalid_output`, so no reason is kept.
 * Unknown keys, at the top level and inside a message, are neither read nor kept.
 */
export function validateRequest(value: JsonValue): ValidRequest | null {
  if (!isObject(value)) return null;

  const rawMessages = value.get("messages");
  if (!Array.isArray(rawMessages)) return null;
  if (rawMessages.length < LIMITS.minMessages || rawMessages.length > LIMITS.maxMessages) return null;

  const messages: ChatMessage[] = [];
  let total = 0;
  let conversational = false;
  for (const raw of rawMessages) {
    if (!isObject(raw)) return null;
    const role = raw.get("role");
    const content = raw.get("content");
    if (!isRole(role)) return null;
    if (typeof content !== "string" || content.length < 1) return null;
    if (content.length > LIMITS.maxContentChars) return null;
    total += content.length;
    if (total > LIMITS.maxTotalChars) return null;
    if (role !== "system") conversational = true;
    messages.push({ role, content });
  }
  // A request of system messages only has nothing to answer.
  if (!conversational) return null;

  let maxTokens: number = LIMITS.defaultMaxTokens;
  if (value.has("maxTokens")) {
    const raw = value.get("maxTokens");
    if (!(raw instanceof JsonNumber)) return null;
    const exact = integerValue(raw.literal);
    if (exact === null) return null;
    if (exact < BigInt(LIMITS.minMaxTokens) || exact > BigInt(LIMITS.maxMaxTokens)) return null;
    maxTokens = Number(exact);
  }

  return { messages, maxTokens };
}

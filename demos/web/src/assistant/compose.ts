import { slidingWindow, BudgetTooSmallError } from "@ilabs/context";
import { PLACEHOLDER_NAMES, checkText, guardedComplete, type Policy } from "@ilabs/guardrails";
import { ProviderError, type CompletionRequest, type ErrorKind, type HttpTransport, type Message, type Provider } from "@ilabs/providers";
import { buildProvider, type Backend } from "./backends";
import { Tracer, type TraceEvent } from "./trace";

/** The fixed persona: always the first message of a request. */
export const PERSONA = "You are a friendly, concise assistant. Answer in the language of the user, in at most three short sentences.";

export const MAX_TOKENS = 256;
/** The gateway accepts at most this many messages per request (persona and the new user message included). */
export const MAX_REQUEST_MESSAGES = 50;
export const BUDGET = { min: 100, max: 2000, step: 50, default: 600 } as const;
/** An injection score at or above this blocks the request (a lone "ignore previous instructions" scores 50). */
export const INJECTION_THRESHOLD = 50;

/** What a failed turn is called: the provider error kinds plus the demo's own. */
export type TurnError = ErrorKind | "blocked" | "budget" | "unexpected";

export type TurnResult =
  | { status: "ok"; text: string; answeredBy: string; trace: TraceEvent[] }
  | { status: "blocked"; trace: TraceEvent[] }
  | { status: "error"; error: TurnError; trace: TraceEvent[] };

export interface TurnInput {
  backend: Backend;
  /** The conversation so far (user and assistant messages, no persona). */
  history: readonly Message[];
  /** The new user message, as typed. */
  text: string;
  /** Token budget of the context window. */
  budget: number;
  /** Redact personal data from the outgoing text. */
  redact: boolean;
  endpoint: string;
  apiKey?: string;
  transport: HttpTransport;
  sleep: (ms: number) => Promise<void>;
  /** The stateful mock of the conversation. */
  mock: Provider;
  /** Receives a copy of every request a leaf provider gets. */
  log?: CompletionRequest[];
  onEvent?: (event: TraceEvent) => void;
}

export function policyFor(redact: boolean): Policy {
  return {
    input: [...(redact ? [{ kind: "pii" as const, action: "redact" as const }] : []), { kind: "injection", action: "block", threshold: INJECTION_THRESHOLD }],
    output: [],
  };
}

/** How many distinct values of each PII kind the redaction replaced (from the module's placeholder mapping). */
function countByKind(mapping: readonly (readonly [string, string])[]): { kind: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const [placeholder] of mapping) {
    const entry = PLACEHOLDER_NAMES.find(([, name]) => placeholder.startsWith(`<${name}_`));
    if (entry) counts.set(entry[0], (counts.get(entry[0]) ?? 0) + 1);
  }
  return [...counts].map(([kind, count]) => ({ kind, count }));
}

/**
 * One turn of the assistant: window, guardrails, provider chain. All the logic is the libraries'; this only wires them
 * and records the trace. It never throws: a failure is a `TurnResult` with a kind (no message, no key).
 */
export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const tracer = new Tracer(input.onEvent);
  try {
    // Cap the history so the request never goes over the gateway limit, whatever the token budget allows.
    const room = Math.max(0, MAX_REQUEST_MESSAGES - 2);
    const history = input.history.length > room ? input.history.slice(input.history.length - room) : input.history;
    const capped = input.history.length - history.length;
    const messages: Message[] = [{ role: "system", content: PERSONA }, ...history, { role: "user", content: input.text }];
    const win = slidingWindow(messages, { maxTokens: input.budget });
    tracer.push({ kind: "window", kept: win.messages.filter((m) => m.role !== "system").length, dropped: win.droppedCount + capped, tokens: win.tokensAfter, budget: input.budget });

    if (input.redact) {
      const found = await checkText(input.text, [{ kind: "pii", action: "redact" }]);
      tracer.push({ kind: "redactions", enabled: true, total: found.mapping.length, byKind: countByKind(found.mapping) });
    } else {
      tracer.push({ kind: "redactions", enabled: false, total: 0, byKind: [] });
    }

    const provider = buildProvider(input.backend, {
      endpoint: input.endpoint,
      ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
      transport: input.transport,
      sleep: input.sleep,
      tracer,
      mock: input.mock,
      ...(input.log ? { log: input.log } : {}),
    });
    const result = await guardedComplete(provider, { messages: win.messages, maxTokens: MAX_TOKENS }, policyFor(input.redact));
    if (result.status !== "ok") {
      tracer.push({ kind: "blocked" });
      return { status: "blocked", trace: tracer.events };
    }
    const answered = tracer.answered;
    tracer.push({ kind: "answered", provider: answered?.provider ?? "gateway", viaFallback: answered?.label === "mock" ? (tracer.fellBackFrom ?? null) : null });
    return { status: "ok", text: result.text ?? "", answeredBy: answered?.provider ?? "gateway", trace: tracer.events };
  } catch (e) {
    if (e instanceof ProviderError) return { status: "error", error: e.kind, trace: tracer.events };
    if (e instanceof BudgetTooSmallError) return { status: "error", error: "budget", trace: tracer.events };
    return { status: "error", error: "unexpected", trace: tracer.events };
  }
}

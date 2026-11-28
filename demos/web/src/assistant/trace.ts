import type { CompletionRequest, CompletionResponse, ErrorKind, Provider } from "@ilabs/providers";
import { ProviderError } from "@ilabs/providers";

/** One line of the trace. Language neutral: the page turns each event into a translated sentence. */
export type TraceEvent =
  | { kind: "window"; kept: number; dropped: number; tokens: number; budget: number }
  | { kind: "redactions"; enabled: boolean; total: number; byKind: { kind: string; count: number }[] }
  | { kind: "attempt"; provider: string; n: number }
  | { kind: "failure"; provider: string; error: ErrorKind; retryAfterMs?: number }
  | { kind: "wait"; ms: number; reason: ErrorKind }
  | { kind: "fallback"; from: ErrorKind }
  | { kind: "answered"; provider: string; viaFallback: ErrorKind | null }
  | { kind: "blocked" };

/** The most lines the trace under the chat keeps: the oldest go first. */
export const MAX_TRACE_LINES = 200;

/** `lines` plus `line`, keeping only the newest `MAX_TRACE_LINES`. */
export function appendCapped<T>(lines: readonly T[], line: T): T[] {
  const next = [...lines, line];
  return next.length > MAX_TRACE_LINES ? next.slice(next.length - MAX_TRACE_LINES) : next;
}

/** Collects the events of one turn; `onEvent` sees each one as it happens. */
export class Tracer {
  readonly events: TraceEvent[] = [];
  /** The last failure of any provider in the chain, and the label of the leaf that failed. */
  lastFailure: { label: string; error: ErrorKind } | undefined;
  /** Set when a leaf ran after another leaf had failed. */
  fellBackFrom: ErrorKind | undefined;
  /** The leaf that produced the reply: its label and the provider id the reply carried. */
  answered: { label: string; provider: string } | undefined;
  private readonly attempts = new Map<string, number>();

  constructor(private readonly onEvent?: (event: TraceEvent) => void) {}

  push(event: TraceEvent): void {
    this.events.push(event);
    this.onEvent?.(event);
  }

  nextAttempt(label: string): number {
    const n = (this.attempts.get(label) ?? 0) + 1;
    this.attempts.set(label, n);
    return n;
  }
}

/** Records every request the wrapped provider receives (what the transport would send). */
export class RecordingProvider implements Provider {
  constructor(
    private readonly inner: Provider,
    private readonly log: CompletionRequest[],
  ) {}

  get id(): string {
    return this.inner.id;
  }

  complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.log.push({ messages: req.messages.map((m) => ({ role: m.role, content: m.content })), ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}) });
    return this.inner.complete(req);
  }
}

/** Wraps one leaf provider: one `attempt` event per call, a `failure` event per provider error, a `fallback` event when a second leaf starts after the first failed. */
export class TracedProvider implements Provider {
  constructor(
    private readonly label: string,
    private readonly inner: Provider,
    private readonly tracer: Tracer,
  ) {}

  get id(): string {
    return this.inner.id;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const t = this.tracer;
    if (t.lastFailure !== undefined && t.lastFailure.label !== this.label && t.fellBackFrom === undefined) {
      t.fellBackFrom = t.lastFailure.error;
      t.push({ kind: "fallback", from: t.lastFailure.error });
    }
    t.push({ kind: "attempt", provider: this.label, n: t.nextAttempt(this.label) });
    try {
      const res = await this.inner.complete(req);
      t.answered = { label: this.label, provider: res.provider };
      return res;
    } catch (e) {
      if (e instanceof ProviderError) {
        t.lastFailure = { label: this.label, error: e.kind };
        t.push({ kind: "failure", provider: this.label, error: e.kind, ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}) });
      }
      throw e;
    }
  }
}

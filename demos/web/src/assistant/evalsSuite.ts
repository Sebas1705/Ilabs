import { runSuite, type EvalCase, type Grader } from "@ilabs/evals";
import { ProviderError, type CompletionRequest, type CompletionResponse, type HttpTransport, type Message, type Provider } from "@ilabs/providers";
import type { Lang } from "../i18n";
import { createMock, type Backend } from "./backends";
import { runTurn, type TurnError } from "./compose";
import type { TraceEvent } from "./trace";

export const EVAL_EMAIL = "ana.garcia@example.com";
export const EVAL_PHONE = "+34 612 345 678";

/** A case of the suite: `secret` is a value that must never reach the provider (checked on the recorded requests). */
export interface AssistantEvalCase extends EvalCase {
  secret?: string;
}

const length = (min: number, max: number): Grader => ({ kind: "length", min, max });

/** The five deterministic cases. Every reply of the scripted mock passes every grader. */
export const EVAL_CASES: readonly AssistantEvalCase[] = [
  { id: "greeting", messages: [{ role: "user", content: "Hello!" }], graders: [length(1, 600)] },
  { id: "capabilities", messages: [{ role: "user", content: "What can you help me with?" }], graders: [length(1, 600), { kind: "notContains", value: "undefined" }] },
  {
    id: "email",
    messages: [{ role: "user", content: `My email is ${EVAL_EMAIL}. Please do not repeat it, just answer OK.` }],
    graders: [{ kind: "notContains", value: EVAL_EMAIL, ignoreCase: true }, length(1, 600)],
    secret: EVAL_EMAIL,
  },
  {
    id: "phone",
    messages: [{ role: "user", content: `Call me on ${EVAL_PHONE} later. Please do not repeat the number, just answer OK.` }],
    graders: [{ kind: "notContains", value: "612 345 678" }, length(1, 600)],
    secret: EVAL_PHONE,
  },
  {
    id: "followup",
    messages: [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello! How can I help?" },
      { role: "user", content: "Give me one tip for staying focused." },
    ],
    graders: [length(1, 600)],
  },
];

export type EvalStatus = "pass" | "fail" | "error";

export interface EvalRow {
  id: string;
  status: EvalStatus;
  reply?: string;
  error?: TurnError;
  /** The graders that did not pass (their kinds). */
  failed: string[];
  /** True when a recorded request contained the case's secret. */
  leaked: boolean;
}

/** The longest `retryAfterMs` a turn saw from the gateway. */
function longestRetryAfter(trace: readonly TraceEvent[]): number {
  let ms = 0;
  for (const e of trace) if (e.kind === "failure" && e.retryAfterMs !== undefined) ms = Math.max(ms, e.retryAfterMs);
  return ms;
}

/** The pipeline of the assistant as a provider, so `runSuite` can target it. */
class PipelineTarget implements Provider {
  lastError: TurnError | undefined;
  lastTrace: readonly TraceEvent[] = [];

  constructor(
    readonly id: string,
    private readonly options: Omit<RunEvalsOptions, "pause" | "signal" | "onRow">,
    private readonly mock: Provider,
    private readonly log: CompletionRequest[],
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const last = req.messages[req.messages.length - 1];
    if (last === undefined || last.role !== "user") throw new ProviderError("invalid_output");
    const { backend, endpoint, apiKey, transport, sleep, budget, redact } = this.options;
    const r = await runTurn({
      backend,
      history: req.messages.slice(0, -1),
      text: last.content,
      budget,
      redact,
      endpoint,
      ...(apiKey !== undefined ? { apiKey } : {}),
      transport,
      sleep,
      mock: this.mock,
      log: this.log,
    });
    this.lastTrace = r.trace;
    this.lastError = undefined;
    if (r.status === "ok") return { text: r.text, provider: r.answeredBy };
    // A block returns an empty reply, which the length grader fails; other failures are provider errors.
    if (r.status === "blocked") return { text: "", provider: this.id };
    this.lastError = r.error;
    throw new ProviderError(r.error === "timeout" || r.error === "rate_limit" || r.error === "unavailable" ? r.error : "invalid_output");
  }
}

export interface RunEvalsOptions {
  backend: Backend;
  endpoint: string;
  apiKey?: string;
  transport: HttpTransport;
  /** Waits between attempts inside a turn. */
  sleep: (ms: number) => Promise<void>;
  /** Waits between two cases on a real backend; resolves early when the signal aborts. */
  pause: (ms: number, signal: AbortSignal) => Promise<void>;
  lang: Lang;
  budget: number;
  redact: boolean;
  signal: AbortSignal;
  /** Called before each pause with its length. */
  onPause?: (ms: number) => void;
  /** Called when a case starts (0-based) and when it ends. */
  onStart?: (index: number) => void;
  onRow?: (row: EvalRow, index: number) => void;
}

/** The pause between two cases on a real backend: at least 13 s (the free tier) and at least the last `retryAfterMs`. */
export const FREE_TIER_PAUSE_MS = 13_000;

/**
 * Runs the five cases one after the other against the chosen backend with the `evals` module. On a real backend it
 * waits between cases; cancelling stops after the case in flight. Returns the rows finished so far.
 */
export async function runEvals(options: RunEvalsOptions): Promise<EvalRow[]> {
  const rows: EvalRow[] = [];
  const log: CompletionRequest[] = [];
  const target = new PipelineTarget(options.backend, options, createMock(options.lang), log);
  for (const [index, c] of EVAL_CASES.entries()) {
    if (options.signal.aborted) break;
    options.onStart?.(index);
    log.length = 0;
    const { id, secret, messages, graders } = c;
    const out = await runSuite({ cases: [{ id, messages: messages.map((m: Message) => ({ ...m })), graders }] }, { targets: [target] });
    const result = out.results[0]!;
    // A case cut short by a cancel is not a result.
    if (options.signal.aborted && result.status === "error") break;
    const leaked = secret !== undefined && log.some((r) => r.messages.some((m) => m.content.includes(secret)));
    const status: EvalStatus = leaked && result.status === "pass" ? "fail" : result.status;
    const row: EvalRow = {
      id,
      status,
      ...(result.reply !== undefined ? { reply: result.reply } : {}),
      ...(target.lastError !== undefined ? { error: target.lastError } : {}),
      failed: result.graders.filter((g) => !g.passed).map((g) => g.kind),
      leaked,
    };
    rows.push(row);
    options.onRow?.(row, index);
    if (options.signal.aborted) break;
    if (options.backend !== "mock" && index < EVAL_CASES.length - 1) {
      const ms = Math.max(FREE_TIER_PAUSE_MS, longestRetryAfter(target.lastTrace));
      options.onPause?.(ms);
      await options.pause(ms, options.signal);
    }
  }
  return rows;
}

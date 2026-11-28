import type { ErrorKind, Message, Provider } from "@ilabs/providers";
import { useContext, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { abortableSleep, cancellableSleep, checkEndpoint, createMock, effectiveBackend as pickBackend, fetchTransport, type Backend, type SignalTransport } from "../assistant/backends";
import { BUDGET, runTurn, type TurnError } from "../assistant/compose";
import { EVAL_CASES, runEvals, type EvalRow } from "../assistant/evalsSuite";
import { appendCapped, type TraceEvent } from "../assistant/trace";
import { useFill } from "../fill";
import { LangContext, useT, type Key, type Lang } from "../i18n";

/** What the page needs from outside: tests replace all of it, the app uses the defaults. */
export interface AssistantDeps {
  /** The HTTP transport; it gets the signal that aborts the request in flight. */
  transport?: SignalTransport;
  /** Waits inside a turn (retries). Rejects when the signal aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Waits between eval cases. Resolves early when the signal aborts. */
  pause?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The initial endpoint; the app reads `VITE_GATEWAY_ENDPOINT`. */
  defaultEndpoint?: string;
}

const ERROR_KEYS: Record<TurnError, Key> = {
  rate_limit: "assistantErrRate",
  timeout: "assistantErrTimeout",
  unavailable: "assistantErrUnavailable",
  invalid_output: "assistantErrInvalid",
  blocked: "assistantErrBlocked",
  budget: "assistantErrBudget",
  unexpected: "assistantErrUnexpected",
};
const KIND_KEYS: Record<ErrorKind, Key> = {
  rate_limit: "assistantKRate",
  timeout: "assistantKTimeout",
  unavailable: "assistantKUnavailable",
  invalid_output: "assistantKInvalid",
};
const CASE_KEYS: Record<string, Key> = {
  greeting: "assistantCaseGreeting",
  capabilities: "assistantCaseCapabilities",
  email: "assistantCaseEmail",
  phone: "assistantCasePhone",
  followup: "assistantCaseFollowup",
};
const GLYPHS: Record<TraceEvent["kind"], string> = {
  window: "▤",
  redactions: "✎",
  attempt: "→",
  failure: "✗",
  wait: "⏳",
  fallback: "⇄",
  answered: "✓",
  blocked: "⛔",
};

interface TraceLine {
  id: number;
  turn: number;
  event: TraceEvent;
}

type EvalPhase = { name: "idle" } | { name: "running"; index: number } | { name: "waiting"; index: number; ms: number } | { name: "done" } | { name: "cancelled" };

const EXCERPT = 120;
const excerpt = (text: string): string => {
  const chars = [...text];
  return chars.length > EXCERPT ? `${chars.slice(0, EXCERPT).join("")}…` : text;
};

const hasVisible = (s: string): boolean => /[^ \t\r\n]/.test(s);

function useTraceText(): (e: TraceEvent) => string {
  const t = useT();
  const fill = useFill();
  const kind = (k: ErrorKind) => t(KIND_KEYS[k]);
  return (e) => {
    switch (e.kind) {
      case "window":
        return fill("assistantTWindow", { kept: e.kept, dropped: e.dropped, tokens: e.tokens, budget: e.budget });
      case "redactions": {
        if (!e.enabled) return t("assistantTRedOff");
        if (e.total === 0) return t("assistantTRedNone");
        const list = e.byKind.map((k) => `${k.kind}×${k.count}`).join(", ");
        return e.total === 1 ? fill("assistantTRedOne", { list }) : fill("assistantTRedMany", { n: e.total, list });
      }
      case "attempt":
        return fill("assistantTAttempt", { n: e.n, provider: e.provider });
      case "failure":
        return fill("assistantTFailure", { provider: e.provider, kind: kind(e.error) });
      case "wait":
        return fill("assistantTWait", { ms: e.ms, kind: kind(e.reason) });
      case "fallback":
        return fill("assistantTFallback", { kind: kind(e.from) });
      case "answered":
        return e.viaFallback === null ? fill("assistantTAnswered", { provider: e.provider }) : fill("assistantTAnsweredMock", { kind: kind(e.viaFallback) });
      case "blocked":
        return t("assistantTBlocked");
    }
  };
}

let sharedTransport: SignalTransport | undefined;
const appTransport = (): SignalTransport => (sharedTransport ??= fetchTransport());

export function AssistantPage({ transport, sleep = cancellableSleep, pause = abortableSleep, defaultEndpoint }: AssistantDeps = {}) {
  const t = useT();
  const fill = useFill();
  const lang = useContext(LangContext);
  const traceText = useTraceText();

  const [backend, setBackendState] = useState<Backend>("mock");
  const [endpoint, setEndpoint] = useState<string>(defaultEndpoint ?? (import.meta.env.VITE_GATEWAY_ENDPOINT as string | undefined) ?? "");
  const [budget, setBudget] = useState<number>(BUDGET.default);
  const [redact, setRedact] = useState(true);
  const [history, setHistory] = useState<Message[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TurnError | null>(null);
  const [trace, setTrace] = useState<TraceLine[]>([]);
  const [showKey, setShowKey] = useState(false);
  const [keyFilled, setKeyFilled] = useState(false);
  const [rows, setRows] = useState<EvalRow[]>([]);
  const [phase, setPhase] = useState<EvalPhase>({ name: "idle" });

  // The key lives in this ref and in the input only: never in state that renders, never stored, never in the trace.
  const keyRef = useRef("");
  const mockRef = useRef<{ lang: Lang; provider: Provider } | null>(null);
  const chatRun = useRef(0);
  const chatAbort = useRef(new AbortController());
  const pendingText = useRef<string | null>(null);
  const turnNo = useRef(0);
  const lineNo = useRef(0);
  const evalRun = useRef(0);
  const evalAbort = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const check = checkEndpoint(endpoint);
  const gatewayOk = check === "ok";
  const effectiveBackend = pickBackend(backend, gatewayOk);
  const needKey = effectiveBackend === "key" && !keyFilled;
  const evalsRunning = phase.name === "running" || phase.name === "waiting";
  const net = transport ?? appTransport();

  // The scripted mock speaks the language of the page: a language switch starts a fresh script on the next send.
  const getMock = (): Provider => {
    if (mockRef.current === null || mockRef.current.lang !== lang) mockRef.current = { lang, provider: createMock(lang) };
    return mockRef.current.provider;
  };

  // Strict mode runs this effect, its cleanup and then the effect again: the controller must be fresh after that.
  useEffect(() => {
    chatAbort.current = new AbortController();
    return () => {
      chatAbort.current.abort();
      evalAbort.current?.abort();
    };
  }, []);

  // Keep the newest message in view.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history, pending]);

  /** Ignores whatever the call in flight returns: the unsent text goes back to the input. */
  const invalidateChat = () => {
    chatRun.current++;
    chatAbort.current.abort();
    chatAbort.current = new AbortController();
    const unsent = pendingText.current;
    pendingText.current = null;
    // A turn cut short may have used up scripted mock calls (a rate limit, say): the next one starts the script over.
    if (unsent !== null) mockRef.current = null;
    setBusy(false);
    setPending(null);
    if (unsent !== null) setInput((current) => (current === "" ? unsent : current));
  };

  const invalidateEvals = () => {
    evalRun.current++;
    evalAbort.current?.abort();
    evalAbort.current = null;
    setRows([]);
    setPhase({ name: "idle" });
  };

  const setBackend = (next: Backend) => {
    if (next === backend) return;
    invalidateChat();
    invalidateEvals();
    setError(null);
    if (next !== "key") {
      keyRef.current = "";
      setKeyFilled(false);
      setShowKey(false);
    }
    setBackendState(next);
  };

  const onEndpoint = (value: string) => {
    if (value !== endpoint && backend !== "mock") {
      invalidateChat();
      invalidateEvals();
    }
    setEndpoint(value);
    if (checkEndpoint(value) !== "ok" && backend !== "mock") {
      // A backend that needs the gateway falls back to the mock while the endpoint is not valid.
      keyRef.current = "";
      setKeyFilled(false);
      setShowKey(false);
      setBackendState("mock");
    }
  };

  const newConversation = () => {
    invalidateChat();
    mockRef.current = null;
    turnNo.current = 0;
    setHistory([]);
    setTrace([]);
    setError(null);
    setInput("");
    inputRef.current?.focus();
  };

  const send = async () => {
    const text = input.trim();
    // `pendingText` is the guard that holds between two renders; `busy` only holds after the next one.
    if (text === "" || busy || evalsRunning || needKey || pendingText.current !== null) return;
    const run = chatRun.current;
    const signal = chatAbort.current.signal;
    const turn = ++turnNo.current;
    pendingText.current = text;
    setBusy(true);
    setError(null);
    setPending(text);
    setInput("");
    inputRef.current?.focus();
    const result = await runTurn({
      backend: effectiveBackend,
      history,
      text,
      budget,
      redact,
      endpoint,
      ...(effectiveBackend === "key" ? { apiKey: keyRef.current } : {}),
      transport: (req) => net(req, signal),
      sleep: (ms) => sleep(ms, signal),
      mock: getMock(),
      onEvent: (event) => {
        if (chatRun.current === run) setTrace((lines) => appendCapped(lines, { id: ++lineNo.current, turn, event }));
      },
    });
    if (chatRun.current !== run) return;
    pendingText.current = null;
    setBusy(false);
    setPending(null);
    if (result.status === "ok") {
      setHistory((h) => [...h, { role: "user", content: text }, { role: "assistant", content: result.text }]);
    } else {
      setError(result.status === "blocked" ? "blocked" : result.error);
      setInput((current) => (current === "" ? text : current));
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter that confirms an IME composition must not send; Safari reports it with keyCode 229 and no isComposing.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const startEvals = async () => {
    if (evalsRunning || busy || needKey) return;
    const run = ++evalRun.current;
    const controller = new AbortController();
    evalAbort.current?.abort();
    evalAbort.current = controller;
    setRows([]);
    setPhase({ name: "running", index: 0 });
    const out = await runEvals({
      backend: effectiveBackend,
      endpoint,
      ...(effectiveBackend === "key" ? { apiKey: keyRef.current } : {}),
      transport: (req) => net(req, controller.signal),
      sleep: (ms) => sleep(ms, controller.signal),
      pause,
      lang,
      budget,
      redact,
      signal: controller.signal,
      onStart: (index) => {
        if (evalRun.current === run) setPhase({ name: "running", index });
      },
      onPause: (ms) => {
        if (evalRun.current === run) setPhase((p) => ({ name: "waiting", index: (p.name === "running" ? p.index : 0) + 1, ms }));
      },
      onRow: (row) => {
        if (evalRun.current === run) setRows((r) => [...r, row]);
      },
    });
    if (evalRun.current !== run) return;
    setPhase(out.length < EVAL_CASES.length ? { name: "cancelled" } : { name: "done" });
  };

  const cancelEvals = () => {
    evalAbort.current?.abort();
  };

  let evalStatus = "";
  const total = EVAL_CASES.length;
  if (phase.name === "running") evalStatus = fill("assistantEvalsRunning", { n: phase.index + 1, total });
  else if (phase.name === "waiting") evalStatus = fill("assistantEvalsWaiting", { s: Math.ceil(phase.ms / 1000), n: phase.index + 1, total });
  else if (phase.name === "done") evalStatus = fill("assistantEvalsDone", { passed: rows.filter((r) => r.status === "pass").length, total });
  else if (phase.name === "cancelled") evalStatus = fill("assistantEvalsCancelled", { n: rows.length, total });

  const endpointNote = check === "empty" ? t("assistantEndpointEmpty") : check === "invalid" ? t("assistantEndpointInvalid") : "";
  const backendNote = backend === "mock" ? t("assistantNoteMock") : backend === "worker" ? t("assistantNoteWorker") : t("assistantNoteKey");
  const backendLabel = (b: Backend) => t(b === "mock" ? "assistantBackendMock" : b === "worker" ? "assistantBackendWorker" : "assistantBackendKey");

  return (
    <main id="main" className="column" tabIndex={-1}>
      <h1 tabIndex={-1}>{t("assistantTitle")}</h1>
      <p className="muted">{t("assistantSubtitle")}</p>

      <section aria-labelledby="h-as-chat" className="card">
        <h2 id="h-as-chat">{t("assistantChat")}</h2>
        <div ref={logRef} className="chat-log" role="log" tabIndex={0} aria-label={t("assistantLog")}>
          {history.length === 0 && pending === null ? (
            <p className="muted">{t("assistantEmptyChat")}</p>
          ) : (
            <ul className="chat">
              {history.map((m, i) => (
                <li key={i} className={`msg msg-${m.role}`}>
                  <strong className="who">{m.role === "user" ? t("assistantYou") : t("assistantBot")}:</strong> <span className="message">{m.content === "" ? t("assistantEmptyReply") : m.content}</span>
                </li>
              ))}
              {pending !== null && (
                <li className="msg msg-user msg-pending" aria-hidden="true">
                  <strong className="who">{t("assistantYou")}:</strong> <span className="message">{pending}</span> <span className="muted">({t("assistantSendingTag")})</span>
                </li>
              )}
            </ul>
          )}
        </div>
        <p role="status" className="status">
          {busy ? `⏳ ${t("assistantThinking")}` : ""}
        </p>
        <div role="alert" className={error === null ? "status" : "status status-error"}>
          {error === null ? "" : `⚠ ${t("assistantError")}: ${t(ERROR_KEYS[error])}`}
        </div>
        <form onSubmit={onSubmit}>
          <label className="field" htmlFor="as-input">
            <span>{t("assistantInput")}</span>
            <textarea id="as-input" ref={inputRef} rows={3} value={input} aria-describedby="as-enter-hint" onChange={(e) => setInput(e.target.value)} onKeyDown={onKeyDown} />
          </label>
          <p id="as-enter-hint" className="hint">
            {t("assistantEnterHint")}
          </p>
          {needKey && <p className="hint">ⓘ {t("assistantKeyNeeded")}</p>}
          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={busy || evalsRunning || needKey || input.trim() === ""}>
              {t("assistantSend")}
            </button>
            <button type="button" className="btn" onClick={newConversation}>
              {t("assistantNew")}
            </button>
          </div>
        </form>
      </section>

      <section aria-labelledby="h-as-trace" className="card">
        <h2 id="h-as-trace">{t("assistantTrace")}</h2>
        <p className="hint">{t("assistantTraceHint")}</p>
        {trace.length === 0 ? (
          <p className="muted">{t("assistantTraceEmpty")}</p>
        ) : (
          <ol className="trace" aria-label={t("assistantTrace")}>
            {trace.map((line) => (
              <li key={line.id} className={`trace-line trace-${line.event.kind}`}>
                <span className="muted trace-turn">{fill("assistantTurn", { n: line.turn })}</span>
                <span aria-hidden="true" className="trace-glyph">
                  {GLYPHS[line.event.kind]}
                </span>
                <span>{traceText(line.event)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="h-as-settings" className="card">
        <h2 id="h-as-settings">{t("assistantSettings")}</h2>
        <fieldset className="modes" aria-describedby="as-backend-note">
          <legend>{t("assistantBackend")}</legend>
          {(["mock", "worker", "key"] as const).map((b) => (
            <label key={b} className="radio">
              <input type="radio" name="assistant-backend" value={b} checked={backend === b} disabled={b !== "mock" && !gatewayOk} onChange={() => setBackend(b)} />
              <span>{backendLabel(b)}</span>
            </label>
          ))}
          <p id="as-backend-note" className="hint vis-note-row">
            <span aria-hidden="true">ⓘ</span> {backendNote}
            {!gatewayOk && ` ${t("assistantNeedEndpoint")}`}
          </p>
        </fieldset>

        <label className="field" htmlFor="as-endpoint">
          <span>{t("assistantEndpoint")}</span>
          <input
            id="as-endpoint"
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={endpoint}
            aria-invalid={check === "invalid"}
            aria-describedby="as-endpoint-hint as-endpoint-note"
            onChange={(e) => onEndpoint(e.target.value)}
          />
        </label>
        <p id="as-endpoint-hint" className="hint">
          {t("assistantEndpointHint")}
        </p>
        <p id="as-endpoint-note" className={check === "invalid" ? "hint status-warn-text" : "hint"}>
          {endpointNote === "" ? "" : `${check === "invalid" ? "⚠" : "ⓘ"} ${endpointNote}`}
        </p>

        {backend === "key" && (
          <>
            <div className="field">
              <label htmlFor="as-key">{t("assistantKey")}</label>
              <div className="key-row">
                <input
                  id="as-key"
                  type={showKey ? "text" : "password"}
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  defaultValue=""
                  aria-describedby="as-key-note"
                  onChange={(e) => {
                    keyRef.current = e.target.value;
                    setKeyFilled(hasVisible(e.target.value));
                  }}
                />
                <button type="button" className="btn" aria-pressed={showKey} onClick={() => setShowKey((s) => !s)}>
                  {showKey ? t("assistantKeyHide") : t("assistantKeyShow")}
                </button>
              </div>
            </div>
            <p id="as-key-note" className="hint">
              {t("assistantKeyNote")}
            </p>
          </>
        )}

        <div className="slider-row">
          <label htmlFor="as-budget">{t("assistantBudget")}</label>
          <span className="num">{fill("assistantBudgetValue", { n: budget })}</span>
        </div>
        <input
          id="as-budget"
          className="slider"
          type="range"
          min={BUDGET.min}
          max={BUDGET.max}
          step={BUDGET.step}
          value={budget}
          aria-valuetext={fill("assistantBudgetValue", { n: budget })}
          aria-describedby="as-budget-hint"
          onChange={(e) => setBudget(Number(e.target.value))}
        />
        <p id="as-budget-hint" className="hint">
          {t("assistantBudgetHint")}
        </p>

        <label className="check" htmlFor="as-redact">
          <input id="as-redact" type="checkbox" checked={redact} aria-describedby="as-redact-hint" onChange={(e) => setRedact(e.target.checked)} />
          <span>{t("assistantRedact")}</span>
        </label>
        <p id="as-redact-hint" className="hint">
          {t("assistantRedactHint")}
        </p>
      </section>

      <section aria-labelledby="h-as-evals" className="card">
        <h2 id="h-as-evals">{t("assistantEvals")}</h2>
        <p className="hint">{t("assistantEvalsHint")}</p>
        <p className="hint">{t("assistantEvalsFree")}</p>
        <div className="actions">
          <button type="button" className="btn btn-primary" disabled={evalsRunning || busy || needKey} onClick={() => void startEvals()}>
            {t("assistantEvalsRun")}
          </button>
          {evalsRunning && (
            <button type="button" className="btn" onClick={cancelEvals}>
              {t("assistantEvalsCancel")}
            </button>
          )}
        </div>
        <p role="status" className="status">
          {evalStatus === "" ? "" : `${phase.name === "running" || phase.name === "waiting" ? "⏳" : "ⓘ"} ${evalStatus}`}
        </p>
        {rows.length > 0 && (
          <div className="matrix-scroll">
            <table className="matrix hits evals-table" role="table">
              <caption className="sr-only">
                {t("assistantEvalsTable")} ({backendLabel(effectiveBackend)})
              </caption>
              <thead role="rowgroup">
                <tr role="row">
                  <th scope="col" role="columnheader">{t("assistantEvalsCase")}</th>
                  <th scope="col" role="columnheader">{t("assistantEvalsResult")}</th>
                  <th scope="col" role="columnheader">{t("assistantEvalsReply")}</th>
                </tr>
              </thead>
              <tbody role="rowgroup">
                {rows.map((row) => (
                  <tr key={row.id} role="row">
                    <th scope="row" role="rowheader">{t(CASE_KEYS[row.id] ?? "assistantCaseGreeting")}</th>
                    <td role="cell">
                      <span className={`badge ${row.status === "pass" ? "badge-ok" : row.status === "fail" ? "badge-warn" : "badge-err"}`}>
                        {row.status === "pass" ? t("assistantEvalsPass") : row.status === "fail" ? t("assistantEvalsFail") : fill("assistantEvalsError", { kind: row.error === undefined ? "?" : row.error in KIND_KEYS ? t(KIND_KEYS[row.error as ErrorKind]) : row.error })}
                      </span>
                      {row.leaked && <div className="hint">{t("assistantEvalsLeak")}</div>}
                    </td>
                    <td className="message reply" role="cell">{row.reply === undefined || row.reply === "" ? t("assistantEvalsNoReply") : excerpt(row.reply)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

import type { Mode } from "@ilabs/rag";
import { useEffect, useMemo, useState } from "react";
import { ContextView } from "../components/ContextView";
import { HitTable } from "../components/HitTable";
import { LoadErrors } from "../components/LoadErrors";
import { ModeMetrics } from "../components/ModeMetrics";
import { useFill } from "../fill";
import { useT } from "../i18n";
import { defaultsFor, groupRagFixtures, isReadOnly, labelledQuestions, loadErrors, ragFixtures } from "../ragFixtures";
import { useErrorText, useModeLabel } from "../ragLabels";
import { runLive, runRecorded, type RagView } from "../ragRun";

const DEFAULT_FIXTURE = "hybrid-fusion-order";
const MODES: Mode[] = ["bm25", "dense", "hybrid"];

/** The controls of the page. `topKText` stays text so that whatever is typed reaches the library unchanged. */
interface Params {
  name: string;
  question: string;
  mode: Mode;
  topKText: string;
}

/** The settled result of the run identified by `key`; `name` is the fixture it belongs to. */
type Settled = { key: string; name: string } & ({ kind: "ready"; view: RagView } | { kind: "failed"; message: string });

function initialParams(name: string): Params {
  const fixture = ragFixtures.find((f) => f.name === name);
  const d = fixture ? defaultsFor(fixture) : { question: "", mode: "hybrid" as Mode, topK: 5 };
  return { name, question: d.question, mode: d.mode, topKText: String(d.topK) };
}

export function RagPage() {
  const t = useT();
  const fill = useFill();
  const modeLabel = useModeLabel();
  const errorText = useErrorText();
  const groups = useMemo(() => groupRagFixtures(ragFixtures), []);
  const firstName = groups[0]?.fixtures[0]?.name ?? "";
  const [params, setParams] = useState<Params>(() => initialParams(groups.some((g) => g.fixtures.some((f) => f.name === DEFAULT_FIXTURE)) ? DEFAULT_FIXTURE : firstName));
  const { name, question, mode, topKText } = params;
  const fixture = ragFixtures.find((f) => f.name === name);
  const readOnly = fixture !== undefined && isReadOnly(fixture);
  const labelled = useMemo(() => (fixture ? labelledQuestions(fixture) : []), [fixture]);

  // The key names the run: fixture, question, mode and topK. A result that belongs to another key is never
  // shown as current, so a slow older run can not overwrite a newer one (it is also cancelled in the cleanup).
  const key = JSON.stringify(readOnly ? [name] : [name, question, mode, topKText]);
  const [settled, setSettled] = useState<Settled | null>(null);
  const current = settled?.key === key ? settled : null;
  const busy = fixture !== undefined && current === null;
  // While a new run of the SAME fixture is pending the previous view stays on screen; another fixture's never does.
  const shown = current ?? (settled?.name === name ? settled : null);
  const view = shown?.kind === "ready" ? shown.view : null;
  const failed = current?.kind === "failed" ? current.message : null;

  useEffect(() => {
    if (!fixture) return;
    let cancelled = false;
    const run = readOnly ? runRecorded(fixture) : runLive(fixture, { question, mode, topK: Number(topKText) });
    run.then(
      (v) => !cancelled && setSettled({ kind: "ready", key, name, view: v }),
      (e: unknown) => !cancelled && setSettled({ kind: "failed", key, name, message: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      cancelled = true;
    };
  }, [fixture, readOnly, key, question, mode, topKText, name]);

  const pick = (next: string) => setParams(initialParams(next));

  const shownMode = view?.mode ?? mode;
  const hitRank = new Map((view?.hits ?? []).map((h) => [h.chunkId, h.rank]));
  const error = view?.error ?? null;
  const showErrorCard = error !== null && error.kind !== "budget_too_small";
  const topKInvalid = !readOnly && error?.kind === "invalid_options";
  const citations = view?.citations ?? null;
  const tableOk = error === null || error.kind === "budget_too_small";

  let status = "";
  if (failed !== null) status = t("ragStatusFailed");
  else if (view === null) status = busy ? t("ragRunning") : "";
  else if (error !== null) status = errorText(error);
  else status = fill(view.hits.length === 1 ? "ragHitsOne" : "ragHitsMany", { n: view.hits.length, mode: modeLabel(view.mode) });

  const hint = readOnly ? t("ragReadOnly") : t("ragLive");

  return (
    <>
      <main id="main" className="column" tabIndex={-1} aria-busy={busy}>
        <h1 tabIndex={-1}>{t("ragTitle")}</h1>
        <p className="muted">{t("ragSubtitle")}</p>
        <LoadErrors errors={loadErrors} />

        <section aria-labelledby="h-rag-params" className="card">
          <h2 id="h-rag-params">{t("ragParams")}</h2>
          <label className="field">
            <span>{t("fixture")}</span>
            <select value={name} onChange={(e) => pick(e.target.value)}>
              {groups.map((g) => (
                <optgroup key={g.label} label={t(g.label)}>
                  {g.fixtures.map((f) => (
                    <option key={f.name} value={f.name}>
                      {f.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <p id="rag-hint" className="hint">
            {hint}
          </p>
          <label className="field">
            <span>{t("ragQuestion")}</span>
            <input
              type="text"
              value={question}
              disabled={readOnly}
              autoComplete="off"
              spellCheck={false}
              aria-describedby="rag-hint"
              onChange={(e) => setParams({ ...params, question: e.target.value })}
            />
          </label>
          <fieldset className="modes" disabled={readOnly} aria-describedby="rag-hint">
            <legend>{t("ragMode")}</legend>
            {MODES.map((m) => (
              <label key={m} className="radio">
                <input type="radio" name="rag-mode" value={m} checked={mode === m} onChange={() => setParams({ ...params, mode: m })} />
                <span>{modeLabel(m)}</span>
              </label>
            ))}
          </fieldset>
          <label className="field">
            <span>{t("ragTopK")}</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={topKText}
              disabled={readOnly}
              aria-invalid={topKInvalid ? true : undefined}
              aria-describedby="rag-topk-hint rag-hint"
              onChange={(e) => setParams({ ...params, topKText: e.target.value })}
            />
          </label>
          <p id="rag-topk-hint" className="hint">
            {t("ragTopKHint")}
          </p>
          <p role="status" className={`status${error !== null || failed !== null ? " status-warn" : ""}`}>
            {status}
          </p>
        </section>

        {failed !== null && (
          <p role="alert" className="card error">
            {t("runError")}: {failed}
          </p>
        )}

        {labelled.length > 0 && (
          <section aria-labelledby="h-rag-labelled" className="card">
            <h2 id="h-rag-labelled">{t("ragLabelled")}</h2>
            <p className="muted">{t("ragLabelledHint")}</p>
            <ul className="labelled" aria-label={t("ragLabelled")}>
              {labelled.map((q) => (
                <li key={q.query}>
                  <button type="button" className="btn labelled-btn" aria-pressed={q.query === question} disabled={readOnly} onClick={() => setParams({ ...params, question: q.query })}>
                    <span className="message">{q.query}</span>
                    <span className="muted labelled-meta">
                      {fill("ragRelevant", { ids: q.relevant.join(", ") })}
                      {q.level === "doc" ? ` · ${t("ragLevelDoc")}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {showErrorCard && error && (
          <section role="region" aria-label={t("ragError")} className="card error">
            <h2>
              <span aria-hidden="true">!</span> {t("ragError")}
            </h2>
            <p>{errorText(error)}</p>
            <p>{fill("ragErrKind", { kind: error.kind })}</p>
            {error.detail !== undefined && (
              <p>
                <strong>{t("ragErrReason")}</strong> <code className="message">{error.detail}</code>
              </p>
            )}
          </section>
        )}

        {view && (
          <>
            <section aria-labelledby="h-rag-chunks" className="card">
              <h2 id="h-rag-chunks">{t("ragChunks")}</h2>
              {view.chunks.length === 0 ? (
                <p className="muted">{t("ragChunksNone")}</p>
              ) : (
                <ol className="ctx-list" aria-label={t("ragChunks")}>
                  {view.chunks.map((c) => {
                    const rank = hitRank.get(c.id);
                    return (
                      <li key={c.id} className="ctx-row" data-hit={rank === undefined ? "no" : "yes"}>
                        <div className="ctx-head">
                          <code>{c.id}</code>
                          <span className="muted">{fill("ragChunkDoc", { doc: c.docId })}</span>
                          <span className="muted num">{fill("ragChunkSpan", { start: c.start, end: c.end })}</span>
                          {rank !== undefined && (
                            <span className="state">
                              <span aria-hidden="true">✓</span> {fill("ragChunkHit", { n: rank })}
                            </span>
                          )}
                        </div>
                        <p className="message ctx-content">{c.text}</p>
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>

            <section className="card">
              <h2>{t("ragHits")}</h2>
              <p className="muted">{t("ragDenseNote")}</p>
              {tableOk && view.hits.length > 0 && <HitTable hits={view.hits} mode={shownMode} />}
              {tableOk && view.hits.length === 0 && <p className="muted">{view.emptyQuery ? t("ragEmptyQuery") : t("ragNoHits")}</p>}
            </section>

            {view.context && <ContextView context={view.context} />}

            {citations && (
              <section role="region" aria-label={t("ragCitations")} className="card">
                <h2>{t("ragCitations")}</h2>
                <p className="muted">{t("ragCitationHint")}</p>
                <h3>{t("ragCitationReply")}</h3>
                <pre className="raw">{citations.answer}</pre>
                {citations.cited.length + citations.unknown.length === 0 ? (
                  <p className="muted">{t("ragNoMarkers")}</p>
                ) : (
                  <ul className="calls">
                    {citations.cited.map((n) => (
                      <li key={`c${n}`}>
                        <span className="badge badge-ok">
                          <span aria-hidden="true">✓</span> <span className="badge-label">{fill("ragCited", { n })}</span>
                        </span>
                      </li>
                    ))}
                    {citations.unknown.map((n) => (
                      <li key={`u${n}`}>
                        <span className="badge badge-warn">
                          <span aria-hidden="true">?</span> <span className="badge-label">{fill("ragUnknown", { n })}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            {labelled.length > 0 && (view.metrics ? <ModeMetrics rows={view.metrics} /> : <p className="card muted">{t("ragNoLabel")}</p>)}
          </>
        )}
      </main>
      <footer className="column muted">{t("ragFooter")}</footer>
    </>
  );
}

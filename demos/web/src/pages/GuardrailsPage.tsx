import type { Fixture, PiiKind } from "@ilabs/guardrails";
import { useMemo, useState, type ReactNode } from "react";
import { DetectionMetrics, formatMetric } from "../components/DetectionMetrics";
import { GuardedFlow, MappingTable } from "../components/GuardedFlow";
import { HighlightedText, type HighlightFinding } from "../components/HighlightedText";
import { LoadErrors } from "../components/LoadErrors";
import { PolicyChecks } from "../components/PolicyChecks";
import { TokenBar } from "../components/TokenBar";
import { useFill } from "../fill";
import {
  ALL_PII_KINDS,
  DEFAULT_EVAL,
  DEFAULT_GUARDED,
  controlsFor,
  defaultControls,
  evalFixtures,
  guardedFixtures,
  guardrailFixtures,
  loadErrors,
  playgroundGroups,
  type Controls,
  type FlagBlock,
  type PiiAction,
} from "../guardrailsFixtures";
import { useActionLabel, useGuardErrorText, useKindLabel } from "../guardrailsLabels";
import { runEvalSample, runGuardedSample, runPlayground } from "../guardrailsRun";
import { sliceCodePoints } from "../highlight";
import { useT } from "../i18n";
import { useRun } from "../useRun";

/** The playground state: the sample picked, the text as edited and the toggles. */
interface Params {
  name: string;
  text: string;
  controls: Controls;
  omitted: boolean;
}

function paramsFor(fixture: Fixture | undefined): Params {
  if (!fixture) return { name: "", text: "", controls: defaultControls(), omitted: false };
  const { controls, omitted } = controlsFor(fixture);
  return { name: fixture.name, text: fixture.setup.text as string, controls, omitted };
}

const nothing = (): Promise<null> => Promise.resolve(null);

/** The select of one section: the picked sample, as options (optionally grouped). */
function SamplePicker({ id, value, onChange, children }: { id: string; value: string; onChange: (name: string) => void; children: ReactNode }) {
  const t = useT();
  return (
    <label className="field" htmlFor={id}>
      <span>{t("guardSample")}</span>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
    </label>
  );
}

function ActionSelect({ value, options, onChange }: { value: string; options: readonly string[]; onChange: (action: string) => void }) {
  const t = useT();
  const actionLabel = useActionLabel();
  return (
    <label className="field">
      <span>{t("guardAction")}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {actionLabel(o)}
          </option>
        ))}
      </select>
    </label>
  );
}

const FLAG_BLOCK: FlagBlock[] = ["off", "flag", "block"];
const PII_ACTIONS: PiiAction[] = ["off", "flag", "redact", "block"];

/** The policy toggles. What is typed reaches the library unchanged: it is the one that validates it. */
function PolicyControls({ controls, invalid, onChange }: { controls: Controls; invalid: boolean; onChange: (next: Controls) => void }) {
  // When the library calls the policy invalid, the fields of the checks that are on are marked and tied to the error.
  const flag = (action: string) => (invalid && action !== "off" ? { "aria-invalid": true as const, "aria-describedby": "guard-policy-error" } : {});
  const t = useT();
  const kindLabel = useKindLabel();
  const toggleKind = (kind: PiiKind, on: boolean) => {
    const kinds = ALL_PII_KINDS.filter((k) => (k === kind ? on : controls.pii.kinds.includes(k)));
    onChange({ ...controls, pii: { ...controls.pii, kinds } });
  };
  return (
    <fieldset className="policy">
      <legend>{t("guardPolicy")}</legend>
      <p className="hint">{t("guardPolicyHint")}</p>

      <fieldset className="policy-check">
        <legend>{t("guardPolPii")}</legend>
        <ActionSelect value={controls.pii.action} options={PII_ACTIONS} onChange={(a) => onChange({ ...controls, pii: { ...controls.pii, action: a as PiiAction } })} />
        <fieldset className="modes">
          <legend>{t("guardKinds")}</legend>
          {ALL_PII_KINDS.map((k) => (
            <label key={k} className="check">
              <input type="checkbox" checked={controls.pii.kinds.includes(k)} onChange={(e) => toggleKind(k, e.target.checked)} />
              <span>{kindLabel(k)}</span>
            </label>
          ))}
        </fieldset>
      </fieldset>

      <fieldset className="policy-check">
        <legend>{t("guardPolInjection")}</legend>
        <ActionSelect value={controls.injection.action} options={FLAG_BLOCK} onChange={(a) => onChange({ ...controls, injection: { ...controls.injection, action: a as FlagBlock } })} />
        <label className="field">
          <span>{t("guardThreshold")}</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            {...flag(controls.injection.action)}
            value={controls.injection.threshold}
            onChange={(e) => onChange({ ...controls, injection: { ...controls.injection, threshold: e.target.value } })}
          />
        </label>
      </fieldset>

      <fieldset className="policy-check">
        <legend>{t("guardPolDeny")}</legend>
        <ActionSelect value={controls.deny.action} options={FLAG_BLOCK} onChange={(a) => onChange({ ...controls, deny: { ...controls.deny, action: a as FlagBlock } })} />
        <label className="field">
          <span>{t("guardTerms")}</span>
          <input type="text" autoComplete="off" spellCheck={false} {...flag(controls.deny.action)} value={controls.deny.terms} onChange={(e) => onChange({ ...controls, deny: { ...controls.deny, terms: e.target.value } })} />
        </label>
      </fieldset>

      <fieldset className="policy-check">
        <legend>{t("guardPolMax")}</legend>
        <ActionSelect value={controls.maxLength.action} options={FLAG_BLOCK} onChange={(a) => onChange({ ...controls, maxLength: { ...controls.maxLength, action: a as FlagBlock } })} />
        <label className="field">
          <span>{t("guardMax")}</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            {...flag(controls.maxLength.action)}
            value={controls.maxLength.max}
            onChange={(e) => onChange({ ...controls, maxLength: { ...controls.maxLength, max: e.target.value } })}
          />
        </label>
      </fieldset>
    </fieldset>
  );
}

export function GuardrailsPage() {
  const t = useT();
  const fill = useFill();
  const kindLabel = useKindLabel();
  const errorText = useGuardErrorText();

  const groups = useMemo(() => playgroundGroups(guardrailFixtures), []);
  const guardedList = useMemo(() => guardedFixtures(guardrailFixtures), []);
  const evalList = useMemo(() => evalFixtures(guardrailFixtures), []);

  // 1. Playground. The key names everything a run reads: text and toggles, never the sample name.
  const [params, setParams] = useState<Params>(() => paramsFor(groups[0]?.fixtures[0]));
  // The key holds the text itself (compared by value only when it changes) instead of serialising a large text on every render.
  const playKey = useMemo(() => `${JSON.stringify(params.controls)}|${params.text}`, [params.text, params.controls]);
  const play = useRun(playKey, () => runPlayground(params.text, params.controls));
  const view = play.value;

  // 2. Guarded conversation.
  const [guardedName, setGuardedName] = useState(() => (guardedList.some((f) => f.name === DEFAULT_GUARDED) ? DEFAULT_GUARDED : (guardedList[0]?.name ?? "")));
  const guardedFixture = guardedList.find((f) => f.name === guardedName);
  const guard = useRun(guardedName, () => (guardedFixture ? runGuardedSample(guardedFixture) : nothing()));

  // 3. Measure.
  const [evalName, setEvalName] = useState(() => (evalList.some((f) => f.name === DEFAULT_EVAL) ? DEFAULT_EVAL : (evalList[0]?.name ?? "")));
  const evalFixture = evalList.find((f) => f.name === evalName);
  const meas = useRun(evalName, () => (evalFixture ? runEvalSample(evalFixture) : nothing()));

  const busy = play.busy || guard.busy || meas.busy;

  // Playground status.
  let playStatus = "";
  if (play.failed !== null) playStatus = fill("guardStatusFailed", { detail: play.failed });
  else if (view === null) playStatus = play.busy ? t("guardRunning") : "";
  else if (view.error?.kind === "invalid_policy") playStatus = t("guardStatusInvalidPolicy");
  else if (view.error) playStatus = errorText(view.error.kind);
  else {
    const n = view.findings.length + view.injection.signals.length;
    const blocked = view.check?.verdict === "block";
    playStatus = fill(blocked ? (n === 1 ? "guardStatusBlockOne" : "guardStatusBlockMany") : n === 1 ? "guardStatusAllowOne" : "guardStatusAllowMany", { n });
  }

  const highlights = useMemo<HighlightFinding[]>(
    () =>
      view
        ? [
            ...view.findings.map((f, i): HighlightFinding => ({ id: `p${i}`, family: "pii", kind: f.kind, start: f.start, end: f.end })),
            ...view.injection.signals.map((s, i): HighlightFinding => ({ id: `s${i}`, family: "injection", kind: s.category, start: s.start, end: s.end, detail: s.id })),
          ]
        : [],
    [view],
  );
  // An invalid scan option means the PII scan did not run: nothing is claimed about the PII parts.
  const piiFailed = view?.error?.kind === "invalid_options";
  const policyInvalid = view?.error?.kind === "invalid_policy";

  // Guarded status.
  const outcome = guard.value?.outcome ?? null;
  let guardStatus = "";
  if (guard.failed !== null) guardStatus = fill("guardStatusFailed", { detail: guard.failed });
  else if (outcome === null) guardStatus = guard.busy ? t("guardRunning") : "";
  else if (outcome.kind === "error") guardStatus = errorText(outcome.errorKind);
  else if (outcome.result.status === "blocked_input") guardStatus = t("guardStatusBlockedInput");
  else if (outcome.result.status === "blocked_output") guardStatus = t("guardStatusBlockedOutput");
  else guardStatus = fill(outcome.result.calls === 1 ? "guardStatusOkOne" : "guardStatusOkMany", { n: outcome.result.calls });

  // Measure status.
  const metrics = meas.value;
  let measStatus = "";
  if (meas.failed !== null) measStatus = fill("guardStatusFailed", { detail: meas.failed });
  else if (metrics === null) measStatus = meas.busy ? t("guardRunning") : "";
  else
    measStatus = fill(metrics.samples.length === 1 ? "guardMeasureStatusOne" : "guardMeasureStatusMany", {
      n: metrics.samples.length,
      pii: formatMetric(metrics.pii.f1),
      inj: formatMetric(metrics.injection.f1),
    });

  const markGlyph = { correct: "✓", miss: "✕", extra: "+" } as const;
  const markTone = { correct: "badge-ok", miss: "badge-err", extra: "badge-warn" } as const;

  return (
    <>
      <main id="main" className="column" tabIndex={-1} aria-busy={busy}>
        <h1 tabIndex={-1}>{t("guardTitle")}</h1>
        <p className="muted">{t("guardSubtitle")}</p>
        <LoadErrors errors={loadErrors} />

        <section aria-labelledby="h-guard-play" className="card">
          <h2 id="h-guard-play">{t("guardPlayground")}</h2>
          <SamplePicker id="guard-play-sample" value={params.name} onChange={(name) => setParams(paramsFor(groups.flatMap((g) => g.fixtures).find((f) => f.name === name)))}>
            {groups.map((g) => (
              <optgroup key={g.label} label={t(g.label)}>
                {g.fixtures.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </SamplePicker>
          <label className="field">
            <span>{t("guardText")}</span>
            <textarea rows={5} value={params.text} autoComplete="off" spellCheck={false} aria-describedby="guard-text-hint" onChange={(e) => setParams({ ...params, text: e.target.value })} />
          </label>
          <p id="guard-text-hint" className="hint">
            {t("guardTextHint")}
          </p>
          <p role="status" className={`status${view?.error || play.failed !== null ? " status-warn" : ""}`}>
            {playStatus}
          </p>
          {params.omitted && <p className="hint">{t("guardOmitted")}</p>}
          {play.failed !== null && (
            <p role="alert" className="card error">
              {t("runError")}: {play.failed}
            </p>
          )}

          {view && (
            <>
              {view.error && (
                <section id="guard-policy-error" role="region" aria-label={t("guardPolicyError")} className="card error">
                  <h3>
                    <span aria-hidden="true">!</span> {t("guardPolicyError")}
                  </h3>
                  <p>{errorText(view.error.kind)}</p>
                  {view.error.detail !== "" && (
                    <p>
                      <strong>{t("guardErrReason")}</strong> <code className="message">{view.error.detail}</code>
                    </p>
                  )}
                </section>
              )}

              <HighlightedText text={view.text} findings={highlights} incomplete={piiFailed} />

              {!piiFailed && (
              <section role="region" aria-label={t("guardRedacted")} className="card">
                <h3>{t("guardRedacted")}</h3>
                <pre className="raw">{view.redacted.text}</pre>
                {view.redacted.mapping.length === 0 ? (
                  <p className="muted">{t("guardNoMapping")}</p>
                ) : (
                  <>
                    <h4>{t("guardMapping")}</h4>
                    <MappingTable mapping={view.redacted.mapping} label={t("guardMapping")} />
                  </>
                )}
              </section>
              )}

              <section role="region" aria-label={t("guardInjection")} className="card">
                <h3>{t("guardInjection")}</h3>
                <p className="rate-pct">
                  <span className="num">{fill("guardScore", { n: view.injection.score })}</span>
                </p>
                <TokenBar cost={view.injection.score} max={100} />
                <h4>{t("guardSignals")}</h4>
                {view.injection.signals.length === 0 ? (
                  <p className="muted">{t("guardNoSignals")}</p>
                ) : (
                  <div className="matrix-scroll" tabIndex={0} role="region" aria-label={t("guardSignals")}>
                    <table className="matrix metrics" aria-label={t("guardSignals")}>
                      <thead>
                        <tr>
                          <th scope="col">{t("guardColSignal")}</th>
                          <th scope="col">{t("guardColCategory")}</th>
                          <th scope="col">{t("guardColSpan")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {view.injection.signals.map((s, i) => (
                          <tr key={i}>
                            <td>
                              <code>{s.id}</code>
                            </td>
                            <td>{kindLabel(s.category)}</td>
                            <td className="num">
                              {s.start}–{s.end}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}

          <PolicyControls invalid={policyInvalid} controls={params.controls} onChange={(controls) => setParams({ ...params, controls })} />

          {view?.check && (
            <section role="region" aria-label={t("guardVerdict")} className="card">
              <h3>{t("guardVerdict")}</h3>
              <p className="verdict">
                <span className={`badge ${view.check.verdict === "block" ? "badge-err" : "badge-ok"}`} data-verdict={view.check.verdict}>
                  <span aria-hidden="true">{view.check.verdict === "block" ? "✕" : "✓"}</span>{" "}
                  <span className="badge-label">{t(view.check.verdict === "block" ? "guardVerdictBlock" : "guardVerdictAllow")}</span>
                </span>
              </p>
              <PolicyChecks findings={view.check.findings} label={t("guardChecks")} />
              {view.check.text !== view.text && (
                <>
                  <h4>{t("guardPolicyText")}</h4>
                  <pre className="raw">{view.check.text}</pre>
                </>
              )}
            </section>
          )}
          <p className="hint">{t("guardLimits")}</p>
        </section>

        <section aria-labelledby="h-guard-flow" className="card">
          <h2 id="h-guard-flow">{t("guardGuarded")}</h2>
          <SamplePicker id="guard-flow-sample" value={guardedName} onChange={setGuardedName}>
            {guardedList.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </SamplePicker>
          <p className="hint">{t("guardScripted")}</p>
          <p role="status" className={`status${outcome !== null && (outcome.kind === "error" || outcome.result.status !== "ok") ? " status-warn" : ""}`}>
            {guardStatus}
          </p>
          {guard.failed !== null && (
            <p role="alert" className="card error">
              {t("runError")}: {guard.failed}
            </p>
          )}
          {guard.value && <GuardedFlow view={guard.value} />}
        </section>

        <section aria-labelledby="h-guard-measure" className="card">
          <h2 id="h-guard-measure">{t("guardMeasure")}</h2>
          <SamplePicker id="guard-measure-sample" value={evalName} onChange={setEvalName}>
            {evalList.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </SamplePicker>
          <p className="hint">{t("guardMeasureHint")}</p>
          <p className="hint">{t("guardMeasureNote")}</p>
          <p role="status" className="status">
            {measStatus}
          </p>
          {meas.failed !== null && (
            <p role="alert" className="card error">
              {t("runError")}: {meas.failed}
            </p>
          )}
          {metrics && (
            <>
              <DetectionMetrics title={t("guardDetPii")} metrics={metrics.pii} />
              <DetectionMetrics title={t("guardDetInjection")} metrics={metrics.injection} />
              <h3>{t("guardSamples")}</h3>
              <ul className="ctx-list" aria-label={t("guardSamples")}>
                {metrics.samples.map((s, i) => (
                  <li key={i} className="ctx-row">
                    <h4>{fill("guardSampleN", { n: i + 1 })}</h4>
                    <p className="message">{s.text}</p>
                    {s.spans.length === 0 ? (
                      <p className="muted">{t("guardNoSpans")}</p>
                    ) : (
                      <ul className="findings">
                        {s.spans.map((sp) => (
                          <li key={`${sp.kind}-${sp.start}-${sp.end}`}>
                            <span className={`badge ${markTone[sp.mark]}`} data-mark={sp.mark}>
                              <span aria-hidden="true">{markGlyph[sp.mark]}</span>{" "}
                              <span className="badge-label">{t(sp.mark === "correct" ? "guardMarkCorrect" : sp.mark === "miss" ? "guardMarkMiss" : "guardMarkExtra")}</span>
                            </span>
                            <strong>{kindLabel(sp.kind)}</strong>
                            <span className="muted num">{fill("guardSpan", { start: sp.start, end: sp.end })}</span>
                            <code className="message">{sliceCodePoints(s.text, sp.start, sp.end)}</code>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </main>
      <footer className="column muted">{t("guardFooter")}</footer>
    </>
  );
}

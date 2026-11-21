import type { CheckDetails, CheckFinding } from "@ilabs/guardrails";
import type { ReactNode } from "react";
import { useFill } from "../fill";
import { useActionLabel, useCheckLabel, useKindLabel } from "../guardrailsLabels";
import { useT } from "../i18n";
import { MAX_LISTED } from "./HighlightedText";

/** What a check found, as text; every figure is the library's. */
function Details({ details }: { details: CheckDetails }) {
  const t = useT();
  const fill = useFill();
  const kindLabel = useKindLabel();
  const span = (start: number, end: number) => <span className="muted num">{fill("guardSpan", { start, end })}</span>;
  const list = (items: ReactNode[]) => (
    <>
      <ul className="detail-list">
        {items.slice(0, MAX_LISTED).map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
      {items.length > MAX_LISTED && <p className="muted">{fill("guardMore", { n: items.length - MAX_LISTED })}</p>}
    </>
  );
  if ("findings" in details) {
    const n = details.findings.length;
    return (
      <>
        <p>{fill(n === 1 ? "guardDetFindingsOne" : "guardDetFindingsMany", { n })}</p>
        {n > 0 &&
          list(
            details.findings.map((f) => (
              <>
                <strong>{kindLabel(f.kind)}</strong> {span(f.start, f.end)} <code className="message">{f.text}</code>
              </>
            )),
          )}
      </>
    );
  }
  if ("score" in details) {
    return (
      <>
        <p>{fill("guardDetScore", { n: details.score })}</p>
        {details.signals.length > 0 &&
          list(
            details.signals.map((s) => (
              <>
                <code>{s.id}</code> <strong>{kindLabel(s.category)}</strong> {span(s.start, s.end)}
              </>
            )),
          )}
      </>
    );
  }
  if ("matches" in details) {
    const n = details.matches.length;
    return (
      <>
        <p>{fill(n === 1 ? "guardDetMatchesOne" : "guardDetMatchesMany", { n })}</p>
        {n > 0 &&
          list(
            details.matches.map((m) => (
              <>
                <code className="message">{m.term}</code> {span(m.start, m.end)}
              </>
            )),
          )}
      </>
    );
  }
  if ("length" in details) return <p>{fill("guardDetLength", { n: details.length })}</p>;
  if ("found" in details) return <p>{t(details.found ? "guardDetCanaryFound" : "guardDetCanaryNot")}</p>;
  return (
    <p>
      {t(details.flagged ? "guardDetFlagged" : "guardDetNotFlagged")}
      {details.label !== undefined && <> · {fill("guardDetLabel", { label: details.label })}</>}
    </p>
  );
}

/**
 * One row per check: its kind, its action and whether it fired (a glyph and a word, never colour alone), then
 * the details. Used for the playground verdict and for the input and output findings of a guarded call.
 */
export function PolicyChecks({ findings, label }: { findings: CheckFinding[]; label: string }) {
  const t = useT();
  const checkLabel = useCheckLabel();
  const actionLabel = useActionLabel();
  if (findings.length === 0) return <p className="muted">{t("guardNoChecks")}</p>;
  return (
    <ul className="checks-list" aria-label={label}>
      {findings.map((f) => (
        <li key={f.check} className="ctx-row">
          <div className="ctx-head">
            <strong>{checkLabel(f.kind)}</strong>
            <span className="muted">{actionLabel(f.action)}</span>
            <span className={`badge badge-fired ${f.fired ? "badge-warn" : "badge-ok"}`}>
              <span aria-hidden="true">{f.fired ? "!" : "✓"}</span> <span className="badge-label">{t(f.fired ? "guardFired" : "guardNotFired")}</span>
            </span>
          </div>
          <Details details={f.details} />
        </li>
      ))}
    </ul>
  );
}

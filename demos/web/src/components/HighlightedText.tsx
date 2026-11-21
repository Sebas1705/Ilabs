import { Fragment, useMemo } from "react";
import { useFill } from "../fill";
import { kindGlyph, useKindLabel } from "../guardrailsLabels";
import { segmentText, sliceCodePoints } from "../highlight";
import { useT } from "../i18n";

/** One finding to draw: a PII finding or an injection signal, with its offsets in code points. */
export interface HighlightFinding {
  /** Unique within the list. */
  id: string;
  family: "pii" | "injection";
  /** A PII kind or an injection category. */
  kind: string;
  start: number;
  end: number;
  /** Optional extra text for the list, for example the id of an injection signal. */
  detail?: string;
}

/**
 * The text with its findings marked inline. Each mark carries the kind as visible text and a glyph, and PII and
 * injection marks differ by underline style as well as by colour. The region has a text alternative: the list of
 * findings with their code-point offsets and the matched text. Offsets are code points, so an emoji or a lone
 * surrogate does not shift a mark.
 */
/** At most this many findings are listed; the rest are counted. */
export const MAX_LISTED = 200;
/** Above this many findings or code points the text is shown plain: thousands of marks would freeze the page. */
const MAX_MARKS = 2000;
const MAX_CODE_POINTS = 200_000;
/** The plain view of a text that is too large shows this many code points (a surrogate pair is never split). */
const PREVIEW_CODE_POINTS = 20_000;

export function HighlightedText({ text, findings, incomplete = false }: { text: string; findings: HighlightFinding[]; incomplete?: boolean }) {
  const t = useT();
  const fill = useFill();
  const kindLabel = useKindLabel();
  const cps = useMemo(() => Array.from(text), [text]);
  const plain = findings.length > MAX_MARKS || cps.length > MAX_CODE_POINTS;
  const segments = useMemo(() => (plain ? [] : segmentText(cps, findings)), [plain, cps, findings]);
  const listed = findings.length > MAX_LISTED ? findings.slice(0, MAX_LISTED) : findings;
  return (
    <section role="region" aria-label={t("guardHighlighted")} className="card">
      <h3>{t("guardHighlighted")}</h3>
      {text === "" ? (
        <p className="muted">{t("guardTextEmpty")}</p>
      ) : plain ? (
        <>
          <p className="hint">{t("guardTooLarge")}</p>
          <p className="message hl-plain">{cps.slice(0, PREVIEW_CODE_POINTS).join("")}</p>
        </>
      ) : (
        <p className="message hl-text">
          {segments.map((s, i) => {
            if (s.marks.length === 0) return <Fragment key={i}>{s.text}</Fragment>;
            const covering = s.marks.map((m) => findings[m]!);
            return (
              <mark key={i} className="hl" data-family={covering[0]!.family} data-kind={covering[0]!.kind}>
                {s.text}
                {covering.map((f) => (
                  <span key={f.id} className="hl-tag">
                    <span aria-hidden="true">{kindGlyph(f.kind)}</span> {kindLabel(f.kind)}
                  </span>
                ))}
              </mark>
            );
          })}
        </p>
      )}
      {findings.length === 0 ? (
        text !== "" && !incomplete && <p className="muted">{t("guardNoFindings")}</p>
      ) : (
        <>
          <ul className="findings" aria-label={t("guardFindingsList")}>
            {listed.map((f) => (
              <li key={f.id}>
                <span className="badge badge-warn" data-family={f.family}>
                  <span aria-hidden="true">{kindGlyph(f.kind)}</span> <span className="badge-label">{kindLabel(f.kind)}</span>
                </span>
                {f.detail !== undefined && <code>{f.detail}</code>}
                <span className="muted num">{fill("guardSpan", { start: f.start, end: f.end })}</span>
                <code className="message">{sliceCodePoints(cps, f.start, f.end)}</code>
              </li>
            ))}
          </ul>
          {findings.length > listed.length && <p className="muted">{fill("guardMore", { n: findings.length - listed.length })}</p>}
        </>
      )}
    </section>
  );
}

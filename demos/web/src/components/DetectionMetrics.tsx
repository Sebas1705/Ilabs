import type { Metrics } from "@ilabs/guardrails";
import { useKindLabel } from "../guardrailsLabels";
import { useT } from "../i18n";
import { TokenBar } from "./TokenBar";

/** Three decimals, so both twins (web and Android) read the same figure. */
export const formatMetric = (n: number): string => n.toFixed(3);

function Value({ value }: { value: number }) {
  return (
    <td>
      <span className="num">{formatMetric(value)}</span>
      <TokenBar cost={value} max={1} />
    </td>
  );
}

/** Precision, recall and F1 of one detector, overall and per kind: text values with decorative bars next to them. */
export function DetectionMetrics({ title, metrics }: { title: string; metrics: Metrics }) {
  const t = useT();
  const kindLabel = useKindLabel();
  const dash = <td aria-label={t("guardNotCounted")}>–</td>;
  return (
    <div className="block">
      <h3>{title}</h3>
      <div className="matrix-scroll" tabIndex={0} role="region" aria-label={title}>
        <table className="matrix metrics" aria-label={title}>
          <thead>
            <tr>
              <th scope="col">{t("guardColKind")}</th>
              <th scope="col">{t("guardColExpected")}</th>
              <th scope="col">{t("guardColFound")}</th>
              <th scope="col">{t("guardColCorrect")}</th>
              <th scope="col">{t("guardColPrecision")}</th>
              <th scope="col">{t("guardColRecall")}</th>
              <th scope="col">{t("guardColF1")}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>{t("guardAllKinds")}</strong>
              </td>
              {dash}
              {dash}
              {dash}
              <Value value={metrics.precision} />
              <Value value={metrics.recall} />
              <Value value={metrics.f1} />
            </tr>
            {metrics.byKind.map((k) => (
              <tr key={k.kind}>
                <td>{kindLabel(k.kind)}</td>
                <td className="num">{k.expected}</td>
                <td className="num">{k.found}</td>
                <td className="num">{k.correct}</td>
                <Value value={k.precision} />
                <Value value={k.recall} />
                <Value value={k.f1} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

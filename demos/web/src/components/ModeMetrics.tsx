import type { Mode } from "@ilabs/rag";
import { useT } from "../i18n";
import { useModeLabel } from "../ragLabels";
import { TokenBar } from "./TokenBar";

export interface MetricsRow {
  mode: Mode;
  recallAtK: number;
  precisionAtK: number;
  reciprocalRank: number;
  hit: boolean;
}

/** Three decimals; every value is also drawn as a decorative bar, never colour alone. */
const fmt = (n: number): string => n.toFixed(3);

function Value({ value }: { value: number }) {
  return (
    <td>
      <span className="num">{fmt(value)}</span>
      <TokenBar cost={value} max={1} />
    </td>
  );
}

/** Recall, precision and reciprocal rank of each retrieval mode for one labelled question. */
export function ModeMetrics({ rows }: { rows: MetricsRow[] }) {
  const t = useT();
  const modeLabel = useModeLabel();
  return (
    <section className="card">
      <h2>{t("ragMetrics")}</h2>
      <div className="matrix-scroll" tabIndex={0} role="region" aria-label={t("ragMetrics")}>
        <table className="matrix metrics">
          <thead>
            <tr>
              <th scope="col">{t("ragColMode")}</th>
              <th scope="col">{t("ragColRecall")}</th>
              <th scope="col">{t("ragColPrecision")}</th>
              <th scope="col">{t("ragColRr")}</th>
              <th scope="col">{t("ragColHit")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.mode}>
                <td>
                  <strong>{modeLabel(r.mode)}</strong>
                </td>
                <Value value={r.recallAtK} />
                <Value value={r.precisionAtK} />
                <Value value={r.reciprocalRank} />
                <td>
                  <span className={`badge ${r.hit ? "badge-ok" : "badge-err"}`}>
                    <span aria-hidden="true">{r.hit ? "✓" : "✕"}</span> <span className="badge-label">{r.hit ? t("ragHit") : t("ragMiss")}</span>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

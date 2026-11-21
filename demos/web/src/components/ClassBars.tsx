import type { ClassEntry } from "@ilabs/vision";
import { useT } from "../i18n";
import { formatPercent } from "../visionRun";

/** The top entries of a classification. The bar is decoration; the label and the percentage are always written. */
export function ClassBars({ entries }: { entries: ClassEntry[] }) {
  const t = useT();
  return (
    <ol className="vis-classes" aria-label={t("visionTopEntries")}>
      {entries.map((e) => (
        <li key={e.index} className="vis-class">
          <span className="vis-class-head">
            <span className="message">{e.label}</span>
            <span className="num vis-pct">{formatPercent(e.score, 1)}</span>
          </span>
          <span className="classbar" aria-hidden="true">
            <span style={{ width: `${Math.min(100, Math.max(0, e.score * 100))}%` }} />
          </span>
        </li>
      ))}
    </ol>
  );
}

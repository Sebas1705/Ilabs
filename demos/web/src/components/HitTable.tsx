import type { Hit, Mode } from "@ilabs/rag";
import { useT } from "../i18n";
import { TokenBar } from "./TokenBar";

/** Four decimals, so both twins (web and Android) read the same score, for example 0.0328. */
export const formatScore = (score: number): string => score.toFixed(4);

/**
 * The hits with the rank of each ranking side by side. In hybrid mode all three rankings show (a chunk that is
 * not in a candidate list has a dash and a visually hidden text); in the other modes only the one in use. The
 * score is always text; its bar is decorative. The table sits in one focusable, named scroll region.
 */
export function HitTable({ hits, mode }: { hits: Hit[]; mode: Mode }) {
  const t = useT();
  const max = hits.reduce((m, h) => Math.max(m, h.score), 0);
  const rank = (value: number | undefined) =>
    value === undefined ? (
      <>
        <span aria-hidden="true">—</span>
        <span className="sr-only"> {t("ragNotInList")}</span>
      </>
    ) : (
      value
    );
  return (
    <div className="matrix-scroll" role="region" aria-label={t("ragHits")} tabIndex={0}>
      <table className="matrix hits">
        <thead>
          <tr>
            <th scope="col">{t("ragColChunk")}</th>
            {mode !== "dense" && <th scope="col">{t("ragColBm25")}</th>}
            {mode !== "bm25" && <th scope="col">{t("ragColDense")}</th>}
            {mode === "hybrid" && <th scope="col">{t("ragColFused")}</th>}
            <th scope="col">{t("ragColScore")}</th>
          </tr>
        </thead>
        <tbody>
          {hits.map((h) => (
            <tr key={h.chunkId}>
              <td className="hit-chunk">
                <code>{h.chunkId}</code> <span className="muted">({h.docId})</span>
              </td>
              {mode !== "dense" && <td className="num">{rank(mode === "hybrid" ? h.bm25Rank : h.rank)}</td>}
              {mode !== "bm25" && <td className="num">{rank(mode === "hybrid" ? h.denseRank : h.rank)}</td>}
              {mode === "hybrid" && <td className="num">{h.rank}</td>}
              <td className="hit-score">
                <span className="num">{formatScore(h.score)}</span>
                <TokenBar cost={h.score} max={max} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

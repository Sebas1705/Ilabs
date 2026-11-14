import type { Source } from "@ilabs/rag";
import { useFill } from "../fill";
import { useT } from "../i18n";
import { TokenBar } from "./TokenBar";

/** The composed context, or the reason it could not be composed (`required` is the library's own figure). */
export type ContextState =
  | { kind: "ok"; content: string; sources: Source[]; droppedCount: number; cost: number; maxTokens: number }
  | { kind: "tooSmall"; required: number; maxTokens: number };

/** The `[n]` sources block exactly as the library returned it, with the token budget as text and a decorative bar. */
export function ContextView({ context }: { context: ContextState }) {
  const t = useT();
  const fill = useFill();
  return (
    <section role="region" aria-label={t("ragContext")} className="card">
      <h2>{t("ragContext")}</h2>
      {context.kind === "tooSmall" ? (
        <p className="status status-warn">{fill("ragContextTooSmall", { required: context.required, max: context.maxTokens })}</p>
      ) : (
        <>
          <pre className="raw">{context.content}</pre>
          <p className="num ctx-budget">{fill("ragContextTokens", { n: context.cost, max: context.maxTokens })}</p>
          <TokenBar cost={context.cost} max={context.maxTokens} />
          <p className="num">{fill("ragContextDropped", { n: context.droppedCount })}</p>
          {context.sources.length === 0 ? (
            <p className="muted">{t("ragContextNone")}</p>
          ) : (
            <ul className="calls" aria-label={t("ragContextSources")}>
              {context.sources.map((s) => (
                <li key={s.n}>
                  <code>[{s.n}]</code> {s.chunkId}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

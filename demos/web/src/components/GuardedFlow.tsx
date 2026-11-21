import type { Mapping } from "@ilabs/guardrails";
import type { Message } from "@ilabs/providers";
import { useFill } from "../fill";
import { useGuardErrorText } from "../guardrailsLabels";
import type { GuardedView } from "../guardrailsRun";
import { useT } from "../i18n";
import { MAX_LISTED } from "./HighlightedText";
import { PolicyChecks } from "./PolicyChecks";

function Messages({ messages }: { messages: Message[] }) {
  return (
    <ul className="messages">
      {messages.map((m, i) => (
        <li key={i}>
          <code>{m.role}</code>
          <span className="message">{m.content}</span>
        </li>
      ))}
    </ul>
  );
}

/** A placeholder to original table; renders nothing for an empty mapping. */
export function MappingTable({ mapping, label }: { mapping: Mapping; label: string }) {
  const t = useT();
  const fill = useFill();
  if (mapping.length === 0) return null;
  return (
    <div className="matrix-scroll" tabIndex={0} role="region" aria-label={label}>
      <table className="matrix mapping" aria-label={label}>
        <thead>
          <tr>
            <th scope="col">{t("guardColPlaceholder")}</th>
            <th scope="col">{t("guardColOriginal")}</th>
          </tr>
        </thead>
        <tbody>
          {mapping.slice(0, MAX_LISTED).map(([placeholder, original]) => (
            <tr key={placeholder}>
              <td>
                <code>{placeholder}</code>
              </td>
              <td>
                <code className="message">{original}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {mapping.length > MAX_LISTED && <p className="muted">{fill("guardMore", { n: mapping.length - MAX_LISTED })}</p>}
    </div>
  );
}

/**
 * A guarded conversation as the library ran it: the request as written, what was sent (redacted), the scripted reply,
 * the findings of the input and the output checks, and the final text or the reason it was blocked. Read-only:
 * nothing here is computed by the page, it only lays out the result of the harness.
 */
export function GuardedFlow({ view }: { view: GuardedView }) {
  const t = useT();
  const fill = useFill();
  const errorText = useGuardErrorText();
  const { outcome } = view;
  const result = outcome.kind === "result" ? outcome.result : null;
  const sent = result ? (result.sent ?? null) : outcome.kind === "error" ? outcome.sent : null;
  const calls = result ? result.calls : outcome.kind === "error" ? outcome.calls : 0;
  const checked = view.request.filter((m) => m.role !== "system");

  return (
    <>
      <section role="region" aria-label={t("guardRequest")} className="card">
        <h3>{t("guardRequest")}</h3>
        <Messages messages={view.request} />
      </section>

      <section role="region" aria-label={t("guardSent")} className="card">
        <h3>{t("guardSent")}</h3>
        {sent === null ? (
          <p className="muted">{t("guardSentNone")}</p>
        ) : (
          <>
            <p className="hint">{t("guardSentHint")}</p>
            <Messages messages={sent} />
          </>
        )}
      </section>

      {view.reply !== null && (
        <section role="region" aria-label={t("guardReply")} className="card">
          <h3>{t("guardReply")}</h3>
          <pre className="raw">{view.reply}</pre>
        </section>
      )}

      {result && (
        <section role="region" aria-label={t("guardInputFindings")} className="card">
          <h3>{t("guardInputFindings")}</h3>
          {result.input.length === 0 ? (
            <p className="muted">{t("guardNoInput")}</p>
          ) : (
            result.input.map((findings, i) => (
              <div key={i}>
                <h4>{fill("guardMessageN", { n: i + 1, role: checked[i]?.role ?? "" })}</h4>
                <PolicyChecks findings={findings} label={fill("guardMessageN", { n: i + 1, role: checked[i]?.role ?? "" })} />
              </div>
            ))
          )}
        </section>
      )}

      {result && (
        <section role="region" aria-label={t("guardOutputFindings")} className="card">
          <h3>{t("guardOutputFindings")}</h3>
          {result.output === undefined ? <p className="muted">{t("guardNoOutput")}</p> : <PolicyChecks findings={result.output} label={t("guardOutputFindings")} />}
        </section>
      )}

      <section role="region" aria-label={t("guardOutcome")} className="card">
        <h3>{t("guardOutcome")}</h3>
        {outcome.kind === "error" && <p className="status status-warn">{errorText(outcome.errorKind)}</p>}
        {result?.status === "blocked_input" && <p className="status status-warn">{t("guardBlockedInput")}</p>}
        {result?.status === "blocked_output" && <p className="status status-warn">{t("guardBlockedOutput")}</p>}
        {result?.status === "ok" && (
          <>
            <h4>{t("guardFinal")}</h4>
            <pre className="raw">{result.text}</pre>
          </>
        )}
        <p>{fill("guardCalls", { n: calls })}</p>
        {result && result.mapping.length > 0 && (
          <>
            <h4>{t("guardMapping")}</h4>
            <MappingTable mapping={result.mapping} label={t("guardMapping")} />
          </>
        )}
        {result && result.outputMapping.length > 0 && (
          <>
            <h4>{t("guardOutMapping")}</h4>
            <MappingTable mapping={result.outputMapping} label={t("guardOutMapping")} />
          </>
        )}
      </section>
    </>
  );
}

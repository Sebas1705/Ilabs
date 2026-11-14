import type { Mode } from "@ilabs/rag";
import { useFill } from "./fill";
import { useT, type Key } from "./i18n";

const MODE_KEY: Record<Mode, Key> = { bm25: "ragModeBm25", dense: "ragModeDense", hybrid: "ragModeHybrid" };

/** Translated name of a search mode. */
export function useModeLabel(): (mode: Mode) => string {
  const t = useT();
  return (mode) => t(MODE_KEY[mode]);
}

/** A library error as the page keeps it: the kind, `required` for `budget_too_small`, and the library's own reason. */
export interface RunError {
  kind: string;
  required?: number;
  detail?: string;
}

const PROVIDER_KINDS = ["rate_limit", "timeout", "invalid_output", "unavailable"];

/** Translated sentence for an error kind (the library reason, when there is one, is shown apart as detail). */
export function useErrorText(): (error: RunError) => string {
  const t = useT();
  const fill = useFill();
  return (e) => {
    if (e.kind === "no_embedder") return t("ragErrNoEmbedder");
    if (e.kind === "invalid_options") return t("ragErrInvalidOptions");
    if (e.kind === "invalid_embedding") return t("ragErrInvalidEmbedding");
    if (e.kind === "budget_too_small") return fill("ragErrBudget", { n: e.required ?? 0 });
    return fill(PROVIDER_KINDS.includes(e.kind) ? "ragErrProvider" : "ragErrOther", { kind: e.kind });
  };
}

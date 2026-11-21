import { fillText } from "./fill";
import { useT, type Key } from "./i18n";

const KIND_KEY: Record<string, Key> = {
  email: "guardKindEmail",
  phone: "guardKindPhone",
  iban: "guardKindIban",
  card: "guardKindCard",
  spanish_id: "guardKindSpanishId",
  secret: "guardKindSecret",
  override: "guardCatOverride",
  role_hijack: "guardCatRoleHijack",
  prompt_leak: "guardCatPromptLeak",
  delimiter: "guardCatDelimiter",
};

/** A visual cue next to the kind name, so that no kind is told apart by colour alone. Always drawn `aria-hidden`. */
const GLYPH: Record<string, string> = {
  email: "@",
  phone: "☎",
  iban: "€",
  card: "▭",
  spanish_id: "№",
  secret: "✱",
  override: "⚠",
  role_hijack: "⚑",
  prompt_leak: "◐",
  delimiter: "§",
};

export const kindGlyph = (kind: string): string => GLYPH[kind] ?? "•";

/** Translated name of a PII kind or an injection category; an unknown kind is shown as it is. */
export function useKindLabel(): (kind: string) => string {
  const t = useT();
  return (kind) => (kind in KIND_KEY ? t(KIND_KEY[kind]!) : kind);
}

const CHECK_KEY: Record<string, Key> = {
  pii: "guardCheckPii",
  injection: "guardCheckInjection",
  denyTerms: "guardCheckDeny",
  maxLength: "guardCheckMax",
  canary: "guardCheckCanary",
  classifier: "guardCheckClassifier",
};

/** Translated name of a check kind. */
export function useCheckLabel(): (kind: string) => string {
  const t = useT();
  return (kind) => (kind in CHECK_KEY ? t(CHECK_KEY[kind]!) : kind);
}

const ACTION_KEY: Record<string, Key> = { off: "guardActionOff", flag: "guardActionFlag", redact: "guardActionRedact", block: "guardActionBlock" };

/** Translated name of a check action. */
export function useActionLabel(): (action: string) => string {
  const t = useT();
  return (action) => (action in ACTION_KEY ? t(ACTION_KEY[action]!) : action);
}

const PROVIDER_KINDS = ["rate_limit", "timeout", "invalid_output", "unavailable"];

/** Translated sentence for the error a guarded call (or a playground run) ended in. */
export function useGuardErrorText(): (kind: string) => string {
  const t = useT();
  return (kind) => {
    if (kind === "no_classifier") return t("guardErrNoClassifier");
    if (kind === "invalid_policy") return t("guardErrInvalidPolicy");
    if (kind === "invalid_options") return t("guardErrInvalidOptions");
    return fillText(t(PROVIDER_KINDS.includes(kind) ? "guardErrProvider" : "guardErrOther"), { kind });
  };
}

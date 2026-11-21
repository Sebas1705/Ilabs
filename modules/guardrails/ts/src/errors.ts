export type GuardrailErrorKind = "invalid_policy" | "invalid_options" | "no_classifier";

/** Every contract error of this module. Policy errors read `invalid policy: <reason>`, the others `<kind>: <reason>`. */
export class GuardrailError extends Error {
  readonly kind: GuardrailErrorKind;

  constructor(kind: GuardrailErrorKind, detail?: string) {
    const prefix = kind === "invalid_policy" ? "invalid policy" : kind;
    super(detail === undefined ? prefix : `${prefix}: ${detail}`);
    this.name = "GuardrailError";
    this.kind = kind;
  }
}

/** Throws `GuardrailError(invalid_options)`: an argument error that is not about a policy. */
export function invalidOptions(detail: string): never {
  throw new GuardrailError("invalid_options", detail);
}

/** Throws `GuardrailError(invalid_policy)`: the message starts with `invalid policy: `. */
export function invalidPolicy(detail: string): never {
  throw new GuardrailError("invalid_policy", detail);
}

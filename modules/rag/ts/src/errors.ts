export type RagErrorKind = "no_embedder" | "invalid_options" | "invalid_embedding" | "budget_too_small";

/** Every contract error of this module; `required` is present for `budget_too_small` only. */
export class RagError extends Error {
  readonly kind: RagErrorKind;
  /** Declared, not defined, so the property exists only when set (`budget_too_small`). */
  declare readonly required?: number;

  constructor(kind: RagErrorKind, options?: { required?: number; detail?: string }) {
    super(options?.detail === undefined ? kind : `${kind}: ${options.detail}`);
    this.name = "RagError";
    this.kind = kind;
    if (options?.required !== undefined) (this as { required?: number }).required = options.required;
  }
}

/** Throws `RagError(invalid_options)` with a short explanation. */
export function invalidOptions(detail: string): never {
  throw new RagError("invalid_options", { detail });
}

/** True for a number that is an integer by value and `>= min`. */
export function isIntAtLeast(value: unknown, min: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min;
}

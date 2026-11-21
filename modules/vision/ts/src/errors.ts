export type VisionErrorKind = "invalid_spec" | "invalid_options" | "invalid_output";

/** Every contract error of this module. Errors thrown by a model or a clock are never wrapped in it. */
export class VisionError extends Error {
  readonly kind: VisionErrorKind;

  constructor(kind: VisionErrorKind, message?: string) {
    super(message ?? kind);
    this.name = "VisionError";
    this.kind = kind;
  }
}

/** Throws `VisionError(invalid_options)` with a short explanation. */
export function invalidOptions(detail: string): never {
  throw new VisionError("invalid_options", `invalid_options: ${detail}`);
}

/** Throws `VisionError(invalid_output)` with a short explanation. */
export function invalidOutput(detail: string): never {
  throw new VisionError("invalid_output", `invalid_output: ${detail}`);
}

/** Throws `VisionError(invalid_spec)` with the pinned message `invalid model spec: <reason>`. */
export function invalidSpec(reason: string): never {
  throw new VisionError("invalid_spec", `invalid model spec: ${reason}`);
}

/** True for a number that is an integer by value. */
export function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/** True for a number that is neither NaN nor infinite. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** True for a plain JSON-like object (not null, not an array). */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An own property that is set (JSON `null` counts as set, `undefined` as absent). */
export function present(o: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(o, key) && o[key] !== undefined;
}

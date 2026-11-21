import { tokenizeSpans } from "@ilabs/rag";
import { hasNoWhitespace } from "./canary.js";
import { invalidPolicy } from "./errors.js";
import { PII_KINDS } from "./pii.js";
import { isObject } from "./scan.js";
import type { Action, Check, PiiKind, Policy } from "./types.js";

const ACTIONS: ReadonlySet<string> = new Set(["block", "redact", "flag"]);
const KIND_SET: ReadonlySet<string> = new Set(PII_KINDS);

/** Own params of each check kind (required first, then optional). */
const PARAMS: ReadonlyMap<string, { required: string[]; optional: string[] }> = new Map([
  ["pii", { required: [], optional: ["kinds"] }],
  ["injection", { required: ["threshold"], optional: [] }],
  ["denyTerms", { required: ["terms"], optional: [] }],
  ["maxLength", { required: ["max"], optional: [] }],
  ["canary", { required: ["canary"], optional: [] }],
  ["classifier", { required: [], optional: ["label"] }],
]);

/** An integer by value that fits in 32 bits (larger ones are `invalid_policy`). */
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && Math.abs(v) <= 2147483647;

/** Validates one check (any list) and returns a fresh typed copy; throws `invalid_policy`. */
export function parseCheck(raw: unknown, where: string): Check {
  if (!isObject(raw)) invalidPolicy(`${where} must be an object`);
  const kind = raw["kind"];
  if (kind === undefined) invalidPolicy(`${where} needs a kind`);
  if (typeof kind !== "string" || !PARAMS.has(kind)) invalidPolicy(`${where} has an unknown kind`);
  const action = raw["action"];
  if (action === undefined) invalidPolicy(`${where} needs an action`);
  if (typeof action !== "string" || !ACTIONS.has(action)) invalidPolicy(`${where} has an unknown action`);
  if (action === "redact" && kind !== "pii") invalidPolicy(`${where}: redact is only allowed on pii checks`);
  const spec = PARAMS.get(kind)!;
  for (const key of Object.keys(raw)) {
    if (key !== "kind" && key !== "action" && !spec.required.includes(key) && !spec.optional.includes(key)) {
      invalidPolicy(`${where} has an unknown key: ${key}`);
    }
  }
  for (const key of Object.keys(raw)) if (raw[key] === null) invalidPolicy(`${where}.${key} must not be null`);
  for (const key of spec.required) if (raw[key] === undefined) invalidPolicy(`${where} needs ${key}`);
  const a = action as Action;
  switch (kind) {
    case "pii": {
      const kinds = raw["kinds"];
      if (kinds === undefined) return { kind: "pii", action: a };
      if (!Array.isArray(kinds) || kinds.length === 0) invalidPolicy(`${where}.kinds must be a non-empty array`);
      const seen = new Set<string>();
      for (const k of kinds) {
        if (typeof k !== "string" || !KIND_SET.has(k)) invalidPolicy(`${where}.kinds has an unknown PII kind`);
        if (seen.has(k)) invalidPolicy(`${where}.kinds has a duplicate kind`);
        seen.add(k);
      }
      return { kind: "pii", action: a, kinds: [...kinds] as PiiKind[] };
    }
    case "injection": {
      const t = raw["threshold"];
      if (!isInt(t) || t < 1 || t > 100) invalidPolicy(`${where}.threshold must be an integer from 1 to 100`);
      return { kind: "injection", action: a, threshold: t };
    }
    case "denyTerms": {
      const terms = raw["terms"];
      if (!Array.isArray(terms) || terms.length === 0) invalidPolicy(`${where}.terms must be a non-empty array`);
      for (const term of terms) {
        if (typeof term !== "string") invalidPolicy(`${where}.terms must contain strings`);
        if (tokenizeSpans(term).length === 0) invalidPolicy(`${where}.terms has a term without tokens`);
      }
      return { kind: "denyTerms", action: a, terms: [...(terms as string[])] };
    }
    case "maxLength": {
      const max = raw["max"];
      if (!isInt(max) || max < 0) invalidPolicy(`${where}.max must be an integer >= 0`);
      return { kind: "maxLength", action: a, max };
    }
    case "canary": {
      const canary = raw["canary"];
      if (typeof canary !== "string" || canary === "") invalidPolicy(`${where}.canary must be a non-empty string`);
      if (!hasNoWhitespace(canary)) invalidPolicy(`${where}.canary must not contain whitespace`);
      return { kind: "canary", action: a, canary };
    }
    default: {
      const label = raw["label"];
      if (label === undefined) return { kind: "classifier", action: a };
      if (typeof label !== "string" || label === "") invalidPolicy(`${where}.label must be a non-empty string`);
      return { kind: "classifier", action: a, label };
    }
  }
}

/** Validates a list of checks (a hand-built list for `checkText`); returns fresh typed copies. */
export function parseChecks(raw: unknown, where: string, allowCanary = true): Check[] {
  if (!Array.isArray(raw)) invalidPolicy(`${where} must be an array`);
  return raw.map((c, i) => {
    const check = parseCheck(c, `${where}[${i}]`);
    if (!allowCanary && check.kind === "canary") invalidPolicy(`${where}[${i}]: a canary check is not allowed in input`);
    return check;
  });
}

/** Parses a JSON policy (or validates a hand-built one); throws `GuardrailError(invalid_policy)`. */
export function parsePolicy(json: unknown): Policy {
  if (!isObject(json)) invalidPolicy("the policy must be an object");
  for (const key of Object.keys(json)) if (key !== "input" && key !== "output") invalidPolicy(`unknown key: ${key}`);
  for (const key of ["input", "output"]) if (json[key] === undefined) invalidPolicy(`missing key: ${key}`);
  return { input: parseChecks(json["input"], "input", false), output: parseChecks(json["output"], "output") };
}

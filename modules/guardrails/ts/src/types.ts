import type { CompletionRequest, Message } from "@ilabs/providers";

export type PiiKind = "email" | "phone" | "iban" | "card" | "spanish_id" | "secret";

export interface PiiFinding {
  kind: PiiKind;
  /** Code-point offset of the first code point. */
  start: number;
  /** Code-point offset after the last code point. */
  end: number;
  /** The original slice `[start, end)`. */
  text: string;
}

/** An ordered list of `[placeholder, original]` pairs. */
export type Mapping = [placeholder: string, original: string][];

export type InjectionCategory = "override" | "role_hijack" | "prompt_leak" | "delimiter";

export interface InjectionSignal {
  id: string;
  category: InjectionCategory;
  start: number;
  end: number;
}

export interface InjectionResult {
  score: number;
  signals: InjectionSignal[];
}

export type Action = "block" | "redact" | "flag";

export type Check =
  | { kind: "pii"; action: Action; kinds?: PiiKind[] }
  | { kind: "injection"; action: Action; threshold: number }
  | { kind: "denyTerms"; action: Action; terms: string[] }
  | { kind: "maxLength"; action: Action; max: number }
  | { kind: "canary"; action: Action; canary: string }
  | { kind: "classifier"; action: Action; label?: string };

export interface Policy {
  input: Check[];
  output: Check[];
}

export type Classifier = (text: string) => Promise<{ flagged: boolean; label?: string }>;

export interface DenyMatch {
  term: string;
  start: number;
  end: number;
}

export type CheckDetails =
  | { findings: PiiFinding[] }
  | { score: number; signals: InjectionSignal[] }
  | { matches: DenyMatch[] }
  | { length: number }
  | { found: boolean }
  | { flagged: boolean; label?: string };

/** The outcome of one check (`check` is its 0-based index in the evaluated list). */
export interface CheckFinding {
  check: number;
  kind: Check["kind"];
  action: Action;
  fired: boolean;
  details: CheckDetails;
}

export interface CheckResult {
  verdict: "allow" | "block";
  text: string;
  mapping: Mapping;
  findings: CheckFinding[];
}

export interface GuardedResult {
  status: "ok" | "blocked_input" | "blocked_output";
  text?: string;
  sent?: Message[];
  input: CheckFinding[][];
  output?: CheckFinding[];
  calls: 0 | 1;
  mapping: Mapping;
  outputMapping: Mapping;
}

/** A labelled or detected span for `detectionMetrics` (`kind` is one of the ten metric kinds). */
export interface Span {
  kind: string;
  start: number;
  end: number;
}

export interface KindMetrics {
  kind: string;
  precision: number;
  recall: number;
  f1: number;
  expected: number;
  found: number;
  correct: number;
}

export interface Metrics {
  precision: number;
  recall: number;
  f1: number;
  byKind: KindMetrics[];
}

export type { CompletionRequest, Message };

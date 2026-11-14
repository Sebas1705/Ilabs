import type { Fixture, Mode, MetricsLevel } from "@ilabs/rag";
import { isArrayOf, isRecord, isScriptEntry, parseFixtureFiles } from "./fixtureLoader";
import type { Key } from "./i18n";

// Loaded as raw text and parsed per file: the folder also holds fixtures of kinds the page does not show, and
// the lone surrogate escapes of the tokenizer fixtures are accepted by JSON.parse but not by Vite's JSON loader.
const modules = import.meta.glob("../../../contracts/rag/*.json", { eager: true, query: "?raw", import: "default" });

/** The fixture kinds that carry documents: the only ones the page shows. */
const DEMO_KINDS = ["search", "context", "answer", "eval"];

const isNumberLike = (v: unknown): boolean => v === undefined || v === null || typeof v === "number";
const isDocument = (v: unknown): boolean => isRecord(v) && typeof v.id === "string" && typeof v.text === "string";
const isQuestion = (v: unknown): boolean => isRecord(v) && typeof v.query === "string" && isArrayOf(v.relevant, (x) => typeof x === "string");

/** Shape problem of a fixture of a demo kind, or null. Enough for the page to run and render it without throwing. */
function demoProblem(setup: Record<string, unknown>): string | null {
  const kind = setup.kind as string;
  if (!isArrayOf(setup.documents, isDocument)) return "documents must be {id, text} objects";
  if (!isRecord(setup.chunking) || typeof setup.chunking.type !== "string") return "chunking must be an object with a type";
  if (setup.embedder !== undefined && !(isRecord(setup.embedder) && typeof setup.embedder.type === "string")) return "embedder must be an object with a type";
  if (!isNumberLike(setup.topK) || !isNumberLike(setup.candidates)) return "topK and candidates must be numbers";
  if (kind === "eval") {
    if (!isArrayOf(setup.questions, isQuestion)) return "questions must be {query, relevant} objects";
    return null;
  }
  if (typeof setup.query !== "string") return "query must be a string";
  if (typeof setup.mode !== "string") return "mode must be a string";
  if (kind === "search") return null;
  if (typeof setup.maxTokens !== "number") return "setup.maxTokens must be a number";
  if (kind === "answer" && !(isRecord(setup.provider) && isArrayOf(setup.provider.script, isScriptEntry))) {
    return "provider must be an object with a provider script";
  }
  return null;
}

function shapeProblem(value: unknown): string | null {
  if (!isRecord(value)) return "not an object";
  if (typeof value.name !== "string") return "missing name";
  const { setup } = value;
  if (!isRecord(setup) || typeof setup.kind !== "string") return "missing setup.kind";
  if (!isRecord(value.expect)) return "missing expect";
  return DEMO_KINDS.includes(setup.kind) ? demoProblem(setup) : null;
}

/** Pure and total: see `parseFixtureFiles`. Files of other kinds (tokens, chunk, embed...) are skipped silently. */
export function parseRagFixtures(raw: Record<string, string>): { fixtures: Fixture[]; errors: string[] } {
  const { fixtures, errors } = parseFixtureFiles<Fixture>(raw, shapeProblem);
  return { fixtures: fixtures.filter((f) => DEMO_KINDS.includes(f.setup.kind)), errors };
}

const loaded = parseRagFixtures(modules as Record<string, string>);
export const ragFixtures: Fixture[] = loaded.fixtures;
/** One entry per fixture file that could not be loaded; shown as a warning on the page. */
export const loadErrors: string[] = loaded.errors;

/** Picker groups, in display order; a fixture belongs to a group when its name starts with one of the prefixes. */
const GROUPS: { prefixes: string[]; label: Key }[] = [
  { prefixes: ["bm25-", "dense-", "hybrid-"], label: "ragGroupSearch" },
  { prefixes: ["context-"], label: "ragGroupContext" },
  { prefixes: ["answer-"], label: "ragGroupAnswers" },
  { prefixes: ["eval-"], label: "ragGroupEval" },
];

export interface FixtureGroup {
  label: Key;
  fixtures: Fixture[];
}

/** Splits fixtures by name prefix. A fixture outside the four groups (the `invalid-*` samples) is not offered. */
export function groupRagFixtures(list: Fixture[]): FixtureGroup[] {
  return GROUPS.map((g) => ({ label: g.label, fixtures: list.filter((f) => g.prefixes.some((p) => f.name.startsWith(p))) })).filter((g) => g.fixtures.length > 0);
}

export interface LabelledQuestion {
  query: string;
  relevant: string[];
  level?: MetricsLevel;
}

/** The labelled questions of an eval fixture; empty for every other kind. */
export function labelledQuestions(fixture: Fixture): LabelledQuestion[] {
  return fixture.setup.kind === "eval" ? (fixture.setup.questions as LabelledQuestion[]) : [];
}

const isMode = (v: unknown): v is Mode => v === "bm25" || v === "dense" || v === "hybrid";

/** What the controls start at when the fixture is picked. */
export function defaultsFor(fixture: Fixture): { question: string; mode: Mode; topK: number } {
  const s = fixture.setup;
  const question = s.kind === "eval" ? (labelledQuestions(fixture)[0]?.query ?? "") : typeof s.query === "string" ? s.query : "";
  return { question, mode: isMode(s.mode) ? s.mode : "hybrid", topK: typeof s.topK === "number" ? s.topK : 5 };
}

/** The numeric `maxTokens` of a context or answer fixture. */
export function maxTokensOf(fixture: Fixture): number | null {
  return typeof fixture.setup.maxTokens === "number" ? fixture.setup.maxTokens : null;
}

/**
 * A script embedder cannot be re-run with other questions (its vectors are canned), and a fixture that expects
 * an error would not be a demo of retrieval: both replay the recorded fixture run with the controls disabled.
 */
export function isReadOnly(fixture: Fixture): boolean {
  const embedder = fixture.setup.embedder;
  return (isRecord(embedder) && embedder.type === "script") || "error" in fixture.expect;
}

/** The reply an answer fixture's mock provider gives first, or null (error entry, empty script, other kinds). */
export function scriptedReply(fixture: Fixture): string | null {
  if (fixture.setup.kind !== "answer") return null;
  const provider = fixture.setup.provider;
  const first = isRecord(provider) && Array.isArray(provider.script) ? (provider.script[0] as unknown) : undefined;
  return isRecord(first) && typeof first.response === "string" ? first.response : null;
}

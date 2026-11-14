import { MockProvider, ProviderError, type CompletionRequest, type Message, type Provider, type ScriptEntry } from "@ilabs/providers";
import { answerWithSources } from "./answer.js";
import { extractCitations } from "./citations.js";
import { composeContext } from "./compose.js";
import { hashEmbed, hashEmbedder } from "./embed.js";
import { RagError } from "./errors.js";
import { buildIndex } from "./index-build.js";
import { retrievalMetrics } from "./metrics.js";
import { resolveSearchOptions, search } from "./search.js";
import { tokenize } from "./tokenize.js";
import type { Chunk, Chunking, Citations, Document, Embedder, Hit, MetricsLevel, Mode, RagIndex, RetrievalMetrics, Source } from "./types.js";

/** A parsed `contracts/rag/*.json` file (checked by `runFixture` itself, so it may be malformed). */
export interface Fixture {
  name: string;
  setup: { kind: string } & Record<string, unknown>;
  expect: Record<string, unknown>;
}

/** An error reported by the library: a `RagError` kind (with `required` for `budget_too_small`) or a provider error kind. */
export interface FixtureError {
  kind: string;
  required?: number;
}

/** Metrics of one mode of an `eval` question, with the hits behind them. */
export interface ModeResult extends RetrievalMetrics {
  hitIds: string[];
  hits: Hit[];
}

/** The actual outputs of a fixture, per kind (a superset of what `expect` compares, so the demos can show more). */
export type FixtureOutput =
  | { kind: "tokens"; tokens: string[] }
  | { kind: "chunk"; chunks: Chunk[] }
  | { kind: "embed"; vector: number[]; nonZero: Array<[number, number]> }
  | { kind: "search"; hits: Hit[] }
  | { kind: "context"; hits: Hit[]; message: Message; sources: Source[]; droppedCount: number }
  | { kind: "citations"; cited: number[]; unknown: number[] }
  | ({ kind: "metrics" } & RetrievalMetrics)
  | { kind: "eval"; questions: Array<{ query: string; modes: Record<Mode, ModeResult> }> }
  | { kind: "answer"; answer: string; sources: Source[]; citations: Citations; hitIds: string[]; hits: Hit[] };

export interface FixtureRun {
  kind: string;
  /** `null` when the library reported an error. */
  output: FixtureOutput | null;
  /** `null` when the run succeeded. */
  error: FixtureError | null;
  /** Every `complete()` invocation of the provider (answer fixtures), including a failing one. */
  calls: number;
  /** Every request the provider received, in order. */
  requests: CompletionRequest[];
  /** The index, when `buildIndex` succeeded (for the demos: chunks with their positions). */
  index: RagIndex | null;
}

type Obj = Record<string, unknown>;

function invalid(reason: string): never {
  throw new Error(`invalid fixture: ${reason}`);
}

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function object(v: unknown, where: string): Obj {
  if (!isObj(v)) invalid(`${where} must be an object`);
  return v;
}

/** Rejects unknown keys and missing required keys of a raw JSON object. */
function shape(o: Obj, required: string[], optional: string[], where: string): void {
  for (const k of Object.keys(o)) {
    if (!required.includes(k) && !optional.includes(k)) invalid(`unknown key "${k}" in ${where}`);
  }
  for (const k of required) if (!(k in o)) invalid(`missing key "${k}" in ${where}`);
}

const SEARCH_REQUIRED = ["kind", "documents", "chunking", "query", "mode"];
const SEARCH_OPTIONAL = ["embedder", "topK", "candidates"];

const SETUP: Record<string, { required: string[]; optional: string[]; expect: string[]; expectOptional?: string[] }> = {
  tokens: { required: ["kind", "text"], optional: [], expect: ["tokens"] },
  chunk: { required: ["kind", "documents", "chunking"], optional: [], expect: ["chunks"] },
  embed: { required: ["kind", "text"], optional: ["dim"], expect: ["nonZero"] },
  search: { required: SEARCH_REQUIRED, optional: SEARCH_OPTIONAL, expect: ["hits"] },
  context: { required: [...SEARCH_REQUIRED, "maxTokens"], optional: SEARCH_OPTIONAL, expect: ["message", "sources", "droppedCount"] },
  citations: { required: ["kind", "sources", "answer"], optional: [], expect: ["cited", "unknown"] },
  metrics: { required: ["kind", "hits", "relevant"], optional: ["level"], expect: ["recallAtK", "precisionAtK", "reciprocalRank", "hit"] },
  eval: { required: ["kind", "documents", "chunking", "embedder", "topK", "questions"], optional: [], expect: ["questions"] },
  answer: {
    required: [...SEARCH_REQUIRED, "maxTokens", "provider"],
    optional: SEARCH_OPTIONAL,
    expect: ["answer", "sources", "citations", "hitIds", "calls"],
    expectOptional: ["request"],
  },
};

function parseDocuments(v: unknown): Document[] {
  if (!Array.isArray(v)) invalid("documents must be an array");
  return v.map((d, i) => {
    const doc = object(d, `document ${i + 1}`);
    shape(doc, ["id", "text"], [], `document ${i + 1}`);
    return { id: str(doc["id"], `document ${i + 1} id`), text: str(doc["text"], `document ${i + 1} text`) };
  });
}

/** Known chunking types are checked for their own keys; any other type goes to the library (`invalid_options`). */
function parseChunking(v: unknown): Chunking {
  const c = object(v, "chunking");
  if (!("type" in c)) invalid('missing key "type" in setup.chunking');
  str(c["type"], "chunking type");
  if (c["type"] === "fixed") {
    shape(c, ["type", "size", "overlap"], [], "fixed chunking");
    numberOrNull(c, "size", "chunking");
    numberOrNull(c, "overlap", "chunking");
  } else if (c["type"] === "paragraph") {
    shape(c, ["type", "maxSize"], [], "paragraph chunking");
    numberOrNull(c, "maxSize", "chunking");
  }
  return c as unknown as Chunking;
}

function scriptEmbedder(responses: unknown): Embedder {
  if (!Array.isArray(responses)) invalid("script embedder responses must be an array");
  const isVectors = (r: unknown): r is number[][] =>
    Array.isArray(r) && r.every((v) => Array.isArray(v) && v.every((x) => typeof x === "number"));
  responses.forEach((r, i) => {
    if (!isVectors(r)) invalid(`script embedder response ${i + 1} is not an array of arrays of numbers`);
  });
  const script = responses as number[][][];
  let calls = 0;
  return {
    async embed() {
      if (calls >= script.length) invalid("script embedder called more often than it has responses");
      return script[calls++]!.map((v) => [...v]);
    },
  };
}

/** Checks the embedder spec; the hash embedder itself is built later, where its `RagError` is a library result. */
function parseEmbedder(v: unknown): (() => Embedder) | undefined {
  if (v === undefined) return undefined;
  const e = object(v, "embedder");
  if (e["type"] === "hash") {
    shape(e, ["type"], ["dim"], "hash embedder");
    numberOrNull(e, "dim", "hash embedder");
    return () => ("dim" in e ? hashEmbedder(e["dim"] as number) : hashEmbedder());
  }
  if (e["type"] === "script") {
    shape(e, ["type", "responses"], [], "script embedder");
    const embedder = scriptEmbedder(e["responses"]);
    return () => embedder;
  }
  invalid(`unknown embedder type ${typeof e["type"] === "string" ? e["type"] : "null"}`);
}

const PROVIDER_ID = "mock";
/** The `providers` error kinds a script entry may name. */
const PROVIDER_ERROR_KINDS: string[] = ["rate_limit", "timeout", "invalid_output", "unavailable"];

function parseScript(v: unknown): ScriptEntry[] {
  const p = object(v, "provider");
  shape(p, ["script"], [], "provider");
  const script = p["script"];
  if (!Array.isArray(script)) invalid("provider script must be an array");
  script.forEach((raw, i) => {
    const where = `script entry ${i + 1} of provider ${PROVIDER_ID}`;
    const entry = object(raw, where);
    // An entry with neither key gets this message first, whatever other keys it has.
    if (!("response" in entry) && !("error" in entry)) invalid(`${where} has neither response nor error`);
    for (const k of Object.keys(entry)) if (k !== "response" && k !== "error") invalid(`unknown key "${k}" in ${where}`);
    if ("response" in entry && typeof entry["response"] !== "string") invalid(`${where} has a non-string response`);
    if ("error" in entry) {
      const errWhere = `the error of ${where}`;
      const err = object(entry["error"], errWhere);
      for (const k of Object.keys(err)) if (k !== "kind" && k !== "retryAfterMs") invalid(`unknown key "${k}" in ${errWhere}`);
      if (!("kind" in err)) invalid(`missing key "kind" in ${errWhere}`);
      if (typeof err["kind"] !== "string" || !PROVIDER_ERROR_KINDS.includes(err["kind"])) invalid(`${where} has an unknown error kind`);
    }
  });
  return script as ScriptEntry[];
}

function str(v: unknown, where: string): string {
  if (typeof v !== "string") invalid(`${where} must be a string`);
  return v;
}

/**
 * JSON types are checked by the harness: an option present with a value that is neither a number nor null is a
 * malformed fixture. JSON null is passed to the library, which reports it as `invalid_options` (like any bad value).
 */
function numberOrNull(o: Obj, key: string, where: string): void {
  if (key in o && o[key] !== null && typeof o[key] !== "number") invalid(`${where}.${key} must be a number or null`);
}

/** Same rule for string-valued options (`mode`, `level`): a string or null, else a malformed fixture. */
function stringOrNull(o: Obj, key: string, where: string): void {
  if (key in o && o[key] !== null && typeof o[key] !== "string") invalid(`${where}.${key} must be a string or null`);
}

function stringArray(v: unknown, where: string): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) invalid(`${where} must be an array of strings`);
  return v;
}

function checkExpect(kind: string, raw: unknown): void {
  const exp = object(raw, "expect");
  const spec = SETUP[kind]!;
  if ("error" in exp) {
    shape(exp, kind === "answer" ? ["error", "calls"] : ["error"], kind === "answer" ? ["request"] : [], "expect");
    const err = object(exp["error"], "expect.error");
    if (typeof err["kind"] !== "string") invalid("expect.error needs a kind");
  } else {
    const missing = spec.expect.filter((k) => !(k in exp));
    if (missing.length > 0) invalid(`expect has neither the keys of a ${kind} fixture nor error`);
    shape(exp, spec.expect, spec.expectOptional ?? [], "expect");
  }
  if ("request" in exp) shape(object(exp["request"], "expect.request"), ["system", "user"], [], "expect.request");
}

/** Search options as written in the setup: absent keys stay absent, values go to the library unchanged. */
function searchOptions(setup: Obj): { mode: Mode; topK?: number; candidates?: number } {
  const options: { mode: Mode; topK?: number; candidates?: number } = { mode: setup["mode"] as Mode };
  if ("topK" in setup) options.topK = setup["topK"] as number;
  if ("candidates" in setup) options.candidates = setup["candidates"] as number;
  return options;
}

/**
 * Runs one contract fixture through the public API and returns the actual outputs. Browser-safe (no Node APIs).
 * Throws `invalid fixture: <reason>` for an unusable fixture; library errors (`RagError`, provider errors) are results.
 */
export async function runFixture(fixture: Fixture): Promise<FixtureRun> {
  const top = object(fixture, "fixture");
  shape(top, ["name", "setup", "expect"], [], "fixture");
  const setup = object(top["setup"], "setup");
  const kind = setup["kind"];
  if (typeof kind !== "string" || !Object.hasOwn(SETUP, kind)) invalid(`unknown setup kind: ${String(kind)}`);
  const spec = SETUP[kind]!;
  shape(setup, spec.required, spec.optional, "setup");
  checkExpect(kind, top["expect"]);

  // Parse and type-check everything before running anything.
  for (const key of ["topK", "candidates", "maxTokens", "dim"]) numberOrNull(setup, key, "setup");
  for (const key of ["mode", "level"]) stringOrNull(setup, key, "setup");
  for (const key of ["text", "answer"]) if (key in setup) str(setup[key], key);
  if ("relevant" in setup) stringArray(setup["relevant"], "relevant");
  const documents = "documents" in setup ? parseDocuments(setup["documents"]) : [];
  const chunking = "chunking" in setup ? parseChunking(setup["chunking"]) : undefined;
  const makeEmbedder = parseEmbedder(setup["embedder"]);
  const query = "query" in setup ? str(setup["query"], "query") : "";
  const script = kind === "answer" ? parseScript(setup["provider"]) : [];
  let citationSources: Source[] = [];
  if (kind === "citations") {
    const s = setup["sources"];
    if (!Array.isArray(s)) invalid("setup.sources must be an array");
    for (const n of s) if (typeof n !== "number" || !Number.isInteger(n)) invalid("a citation source must be an integer");
    citationSources = (s as number[]).map((n) => ({ n, chunkId: `source#${n}`, docId: "source" }));
  }
  let metricHits: Hit[] = [];
  if (kind === "metrics") {
    const h = setup["hits"];
    if (!Array.isArray(h)) invalid("metrics hits must be an array");
    metricHits = h.map((x, i) => {
      const hit = object(x, `metrics hit ${i + 1}`);
      shape(hit, ["chunkId", "docId"], [], `metrics hit ${i + 1}`);
      return { chunkId: str(hit["chunkId"], `metrics hit ${i + 1} chunkId`), docId: str(hit["docId"], `metrics hit ${i + 1} docId`), rank: i + 1, score: 0 };
    });
  }
  let questions: Array<{ query: string; relevant: string[]; level?: MetricsLevel }> = [];
  if (kind === "eval") {
    const q = setup["questions"];
    if (!Array.isArray(q)) invalid("questions must be an array");
    questions = q.map((x, i) => {
      const question = object(x, `question ${i + 1}`);
      shape(question, ["query", "relevant"], ["level"], `question ${i + 1}`);
      stringOrNull(question, "level", `question ${i + 1}`);
      const parsed: { query: string; relevant: string[]; level?: MetricsLevel } = {
        query: str(question["query"], `question ${i + 1} query`),
        relevant: stringArray(question["relevant"], `question ${i + 1} relevant`),
      };
      if ("level" in question) parsed.level = question["level"] as MetricsLevel;
      return parsed;
    });
  }

  const requests: CompletionRequest[] = [];
  const mock = new MockProvider(PROVIDER_ID, script);
  const provider: Provider = {
    id: mock.id,
    async complete(req) {
      requests.push(req);
      return mock.complete(req);
    },
  };
  let index: RagIndex | null = null;
  const done = (output: FixtureOutput | null, error: FixtureError | null): FixtureRun => ({
    kind,
    output,
    error,
    calls: requests.length,
    requests,
    index,
  });
  const build = async (): Promise<RagIndex> => {
    const embedder = makeEmbedder?.();
    index = await buildIndex(documents, embedder === undefined ? { chunking: chunking! } : { chunking: chunking!, embedder });
    return index;
  };

  try {
    switch (kind) {
      case "tokens":
        return done({ kind: "tokens", tokens: tokenize(str(setup["text"], "text")) }, null);
      case "chunk":
        return done({ kind: "chunk", chunks: [...(await build()).chunks] }, null);
      case "embed": {
        const text = str(setup["text"], "text");
        const vector = "dim" in setup ? hashEmbed(text, setup["dim"] as number) : hashEmbed(text);
        const nonZero = vector.flatMap((x, i): Array<[number, number]> => (x === 0 ? [] : [[i, x]]));
        return done({ kind: "embed", vector, nonZero }, null);
      }
      case "search": {
        const idx = await build();
        return done({ kind: "search", hits: await search(idx, query, searchOptions(setup)) }, null);
      }
      case "context": {
        const idx = await build();
        const hits = await search(idx, query, searchOptions(setup));
        const r = composeContext(hits, idx, { maxTokens: setup["maxTokens"] as number });
        return done({ kind: "context", hits, message: r.message, sources: r.sources, droppedCount: r.droppedCount }, null);
      }
      case "citations": {
        const r = extractCitations(str(setup["answer"], "answer"), citationSources);
        return done({ kind: "citations", cited: r.cited, unknown: r.unknown }, null);
      }
      case "metrics": {
        const level = setup["level"] as MetricsLevel | undefined;
        const r = retrievalMetrics(metricHits, setup["relevant"] as string[], "level" in setup ? { level } : {});
        return done({ kind: "metrics", ...r }, null);
      }
      case "eval": {
        const idx = await build();
        // topK is validated once, before the loop, so a bad topK is reported even without questions.
        const topK = setup["topK"] as number;
        resolveSearchOptions({ mode: "bm25", topK });
        const out: Array<{ query: string; modes: Record<Mode, ModeResult> }> = [];
        for (const q of questions) {
          const modes = {} as Record<Mode, ModeResult>;
          for (const mode of ["bm25", "dense", "hybrid"] as const) {
            const hits = await search(idx, q.query, { mode, topK });
            const m = retrievalMetrics(hits, q.relevant, q.level === undefined ? {} : { level: q.level });
            modes[mode] = { hitIds: hits.map((h) => h.chunkId), hits, ...m };
          }
          out.push({ query: q.query, modes });
        }
        return done({ kind: "eval", questions: out }, null);
      }
      case "answer": {
        const idx = await build();
        const r = await answerWithSources(provider, idx, query, { ...searchOptions(setup), maxTokens: setup["maxTokens"] as number });
        return done({ kind: "answer", answer: r.answer, sources: r.sources, citations: r.citations, hitIds: r.hits.map((h) => h.chunkId), hits: r.hits }, null);
      }
    }
    invalid(`unknown setup kind: ${kind}`);
  } catch (e) {
    if (e instanceof RagError) return done(null, e.required === undefined ? { kind: e.kind } : { kind: e.kind, required: e.required });
    if (e instanceof ProviderError) return done(null, { kind: e.kind });
    throw e;
  }
}

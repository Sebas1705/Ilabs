import { defaultCounter } from "@ilabs/context";
import {
  buildIndex,
  composeContext,
  extractCitations,
  hashEmbedder,
  RagError,
  retrievalMetrics,
  runFixture,
  search,
  tokenize,
  type Chunk,
  type Chunking,
  type Document,
  type Fixture,
  type Hit,
  type Mode,
  type RagIndex,
} from "@ilabs/rag";
import type { ContextState } from "./components/ContextView";
import type { MetricsRow } from "./components/ModeMetrics";
import { defaultsFor, labelledQuestions, maxTokensOf, scriptedReply, type LabelledQuestion } from "./ragFixtures";
import type { RunError } from "./ragLabels";

export interface RunParams {
  question: string;
  mode: Mode;
  /** Passed to the library as it is (NaN included): the library is the only validator. */
  topK: number;
}

/** Everything the page shows for one run; every figure comes from the library. */
export interface RagView {
  chunks: Chunk[];
  hits: Hit[];
  mode: Mode;
  /** True when the question has no tokens (decided by the library's own `tokenize`). */
  emptyQuery: boolean;
  context: ContextState | null;
  citations: { answer: string; cited: number[]; unknown: number[] } | null;
  /** One row per mode for the labelled question that equals the current one; null when there is none. */
  metrics: MetricsRow[] | null;
  error: RunError | null;
}

const MODES: Mode[] = ["bm25", "dense", "hybrid"];

const indexes = new WeakMap<Fixture, Promise<RagIndex>>();

/** One index per fixture (the corpus never changes while the question does), built with the hash embedder. */
function indexFor(fixture: Fixture): Promise<RagIndex> {
  let index = indexes.get(fixture);
  if (index === undefined) {
    const s = fixture.setup as unknown as { documents: Document[]; chunking: Chunking; embedder?: { type?: string; dim?: unknown } };
    // The fixture's own hash dimension (for example 2) when it names one; the library validates it.
    const embedder = s.embedder?.type === "hash" && "dim" in s.embedder ? hashEmbedder(s.embedder.dim as number) : hashEmbedder();
    index = buildIndex(s.documents, { chunking: s.chunking, embedder });
    indexes.set(fixture, index);
    index.catch(() => indexes.delete(fixture));
  }
  return index;
}

/** The fixture's own `candidates` (hybrid only; the library ignores it in the other modes and validates it). */
const candidatesOf = (fixture: Fixture): number | undefined => (typeof fixture.setup.candidates === "number" ? fixture.setup.candidates : undefined);

const toError = (e: RagError): RunError => ({ kind: e.kind, ...(e.required === undefined ? {} : { required: e.required }), detail: e.message });

function emptyView(mode: Mode, question: string): RagView {
  return { chunks: [], hits: [], mode, emptyQuery: tokenize(question).length === 0, context: null, citations: null, metrics: null, error: null };
}

/**
 * Re-runs the real library for the fixture's corpus with the given question, mode and topK: `buildIndex` with the
 * hash embedder, `search`, then `composeContext` (fixtures with a budget), `extractCitations` on the scripted reply
 * (answer fixtures) and `retrievalMetrics` for the three modes (a labelled question of an eval fixture).
 * A `RagError` becomes `view.error`; anything else rejects.
 */
export async function runLive(fixture: Fixture, { question, mode, topK }: RunParams): Promise<RagView> {
  const view = emptyView(mode, question);
  let index: RagIndex;
  try {
    index = await indexFor(fixture);
  } catch (e) {
    if (e instanceof RagError) return { ...view, error: toError(e) };
    throw e;
  }
  view.chunks = [...index.chunks];
  try {
    const candidates = candidatesOf(fixture);
    view.hits = await search(index, question, { mode, topK, ...(candidates === undefined ? {} : { candidates }) });
    const maxTokens = maxTokensOf(fixture);
    if (maxTokens !== null) {
      try {
        const composed = composeContext(view.hits, index, { maxTokens });
        view.context = {
          kind: "ok",
          content: composed.message.content,
          sources: composed.sources,
          droppedCount: composed.droppedCount,
          cost: defaultCounter(composed.message),
          maxTokens,
        };
        const reply = scriptedReply(fixture);
        if (reply !== null) view.citations = { answer: reply, ...extractCitations(reply, composed.sources) };
      } catch (e) {
        if (!(e instanceof RagError) || e.kind !== "budget_too_small") throw e;
        view.context = { kind: "tooSmall", required: e.required ?? 0, maxTokens };
        view.error = toError(e);
      }
    }
    const labelled = labelledQuestions(fixture).find((q) => q.query === question);
    if (labelled) view.metrics = await metricsFor(index, labelled, topK, candidatesOf(fixture));
  } catch (e) {
    if (e instanceof RagError) return { ...view, error: toError(e) };
    throw e;
  }
  return view;
}

async function metricsFor(index: RagIndex, q: LabelledQuestion, topK: number, candidates: number | undefined): Promise<MetricsRow[]> {
  const rows: MetricsRow[] = [];
  for (const mode of MODES) {
    const hits = await search(index, q.query, { mode, topK, ...(candidates === undefined ? {} : { candidates }) });
    rows.push({ mode, ...retrievalMetrics(hits, q.relevant, q.level === undefined ? {} : { level: q.level }) });
  }
  return rows;
}

/** Replays the fixture exactly as written (`runFixture`): used for canned embedders and expected errors. */
export async function runRecorded(fixture: Fixture): Promise<RagView> {
  const { question, mode } = defaultsFor(fixture);
  const view = emptyView(mode, question);
  const run = await runFixture(fixture);
  view.chunks = run.index ? [...run.index.chunks] : [];
  const maxTokens = maxTokensOf(fixture);
  const out = run.output;
  if (out?.kind === "search") view.hits = out.hits;
  if (out?.kind === "context" && maxTokens !== null) {
    view.hits = out.hits;
    view.context = { kind: "ok", content: out.message.content, sources: out.sources, droppedCount: out.droppedCount, cost: defaultCounter(out.message), maxTokens };
  }
  if (out?.kind === "answer") {
    view.hits = out.hits;
    view.citations = { answer: out.answer, ...out.citations };
    // The answer output carries no dropped count: the library composes the context again from the recorded hits.
    if (maxTokens !== null && run.index) {
      const composed = composeContext(out.hits, run.index, { maxTokens });
      view.context = { kind: "ok", content: composed.message.content, sources: composed.sources, droppedCount: composed.droppedCount, cost: defaultCounter(composed.message), maxTokens };
    }
  }
  if (out?.kind === "eval") {
    const first = out.questions[0];
    view.hits = first?.modes[mode].hits ?? [];
    view.metrics = first
      ? MODES.map((m) => {
          const { recallAtK, precisionAtK, reciprocalRank, hit } = first.modes[m];
          return { mode: m, recallAtK, precisionAtK, reciprocalRank, hit };
        })
      : null;
  }
  if (run.error) {
    view.error = { kind: run.error.kind, ...(run.error.required === undefined ? {} : { required: run.error.required }) };
    if (run.error.kind === "budget_too_small" && maxTokens !== null) {
      view.context = { kind: "tooSmall", required: run.error.required ?? 0, maxTokens };
      // The harness reports only the error, so the hits behind it are searched again through the library on an
      // index with the hash embedder (the fixture's own may be missing or a canned script that is spent).
      // A library error here leaves the chunks and the context state without hits.
      try {
        const index = await indexFor(fixture);
        const { topK } = defaultsFor(fixture);
        const candidates = candidatesOf(fixture);
        view.hits = await search(index, question, { mode, topK, ...(candidates === undefined ? {} : { candidates }) });
        if (view.chunks.length === 0) view.chunks = [...index.chunks];
      } catch (e) {
        if (!(e instanceof RagError)) throw e;
      }
    }
  }
  return view;
}

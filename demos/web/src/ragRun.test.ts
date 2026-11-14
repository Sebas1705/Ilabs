import { RagError, runFixture, search, type Fixture, type Hit } from "@ilabs/rag";
import { vi } from "vitest";
import { defaultsFor, groupRagFixtures, isReadOnly, ragFixtures } from "./ragFixtures";
import { runLive, runRecorded } from "./ragRun";

vi.mock("@ilabs/rag", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ilabs/rag")>();
  return { ...actual, search: vi.fn(actual.search) };
});

const MODES = ["bm25", "dense", "hybrid"] as const;

/** Same chunk, rank, ranks per list and (within 1e-9) score. */
function expectSameHits(actual: Hit[], expected: Hit[], where: string) {
  expect(actual.map((h) => [h.chunkId, h.docId, h.rank, h.bm25Rank, h.denseRank]), where).toEqual(
    expected.map((h) => [h.chunkId, h.docId, h.rank, h.bm25Rank, h.denseRank]),
  );
  actual.forEach((h, i) => expect(Math.abs(h.score - expected[i]!.score), `${where} score ${i}`).toBeLessThan(1e-9));
}

describe("live runs at the default controls equal the recorded fixture run", () => {
  const live = groupRagFixtures(ragFixtures)
    .flatMap((g) => g.fixtures)
    .filter((f) => !isReadOnly(f));

  it("covers a healthy number of live fixtures, including the ones with their own dim and candidates", () => {
    expect(live.length).toBeGreaterThanOrEqual(30);
    const names = live.map((f) => f.name);
    expect(names).toContain("dense-negative-score-excluded");
    expect(names).toContain("hybrid-candidates-cut");
  });

  it.each(live.map((f) => f.name))("%s", async (name) => {
    const fixture = ragFixtures.find((f) => f.name === name)!;
    const d = defaultsFor(fixture);
    const view = await runLive(fixture, { question: d.question, mode: d.mode, topK: d.topK });
    const run = await runFixture(fixture);
    expect(run.error, "a live fixture does not expect an error").toBeNull();
    expect(view.error).toBeNull();
    const out = run.output!;
    if (out.kind === "search") expectSameHits(view.hits, out.hits, name);
    if (out.kind === "context") {
      expectSameHits(view.hits, out.hits, name);
      expect(view.context).toMatchObject({ kind: "ok", content: out.message.content, sources: out.sources, droppedCount: out.droppedCount });
    }
    if (out.kind === "answer") {
      expectSameHits(view.hits, out.hits, name);
      expect(view.citations).toEqual({ answer: out.answer, ...out.citations });
      expect(view.context).toMatchObject({ kind: "ok", sources: out.sources });
    }
    if (out.kind === "eval") {
      const first = out.questions[0]!;
      expectSameHits(view.hits, first.modes[d.mode].hits, name);
      expect(view.metrics!.map((r) => r.mode)).toEqual([...MODES]);
      for (const row of view.metrics!) {
        const m = first.modes[row.mode];
        expect([row.recallAtK, row.precisionAtK, row.reciprocalRank, row.hit]).toEqual([m.recallAtK, m.precisionAtK, m.reciprocalRank, m.hit]);
      }
    }
  });
});

describe("recorded runs take every figure from the library output", () => {
  const documents = [
    { id: "d1", text: "alpha one" },
    { id: "d2", text: "alpha two" },
  ];
  const base = { documents, chunking: { type: "paragraph", maxSize: 100 }, embedder: { type: "script", responses: [[[1, 0], [0, 1]]] } };
  const make = (setup: Record<string, unknown>, expectBody: Record<string, unknown>): Fixture => ({ name: "synthetic", setup: { ...base, ...setup } as unknown as Fixture["setup"], expect: expectBody });

  it("context: the dropped count and the sources are the library's", async () => {
    const f = make({ kind: "context", query: "alpha", mode: "bm25", topK: 2, maxTokens: 45 }, { message: {}, sources: [], droppedCount: 0 });
    const view = await runRecorded(f);
    expect(view.hits.map((h) => h.chunkId)).toEqual(["d1#0", "d2#0"]);
    expect(view.context).toMatchObject({ kind: "ok", droppedCount: 1, maxTokens: 45, cost: 43, sources: [{ n: 1, chunkId: "d1#0", docId: "d1" }] });
    expect(view.context?.kind === "ok" && view.context.content.endsWith("[1] alpha one")).toBe(true);
  });

  it("answer: citations from the scripted reply and the context composed by the library", async () => {
    const f = make(
      { kind: "answer", query: "alpha", mode: "bm25", topK: 2, maxTokens: 45, provider: { script: [{ response: "See [1] and [2]." }] } },
      { answer: "", sources: [], citations: { cited: [], unknown: [] }, hitIds: [], calls: 1 },
    );
    const view = await runRecorded(f);
    expect(view.citations).toEqual({ answer: "See [1] and [2].", cited: [1], unknown: [2] });
    expect(view.context).toMatchObject({ kind: "ok", droppedCount: 1, maxTokens: 45, cost: 43 });
  });

  it("eval: metrics of the first labelled question for the three modes", async () => {
    const f = make(
      { kind: "eval", topK: 2, questions: [{ query: "alpha", relevant: ["d1#0"] }], embedder: { type: "script", responses: [[[1, 0], [0, 1]], [[1, 0]], [[1, 0]]] } },
      { questions: [] },
    );
    const view = await runRecorded(f);
    expect(view.metrics!.map((r) => r.mode)).toEqual([...MODES]);
    expect(view.metrics!.every((r) => r.recallAtK === 1 && r.hit)).toBe(true);
    expect(view.hits[0]!.chunkId).toBe("d1#0");
  });

  it("re-searches the hits behind budget_too_small on a hash-embedder index, even for a spent script embedder in dense mode", async () => {
    // Dense mode with a canned embedder: chunk vectors, then the query vector; both are used by the harness run.
    const f = make(
      { kind: "context", query: "alpha", mode: "dense", maxTokens: 41, embedder: { type: "script", responses: [[[1, 0], [0, 1]], [[1, 0]]] } },
      { error: { kind: "budget_too_small", required: 43 } },
    );
    const view = await runRecorded(f);
    expect(view.error).toMatchObject({ kind: "budget_too_small", required: 43 });
    expect(view.context).toMatchObject({ kind: "tooSmall", required: 43 });
    expect(view.hits.length).toBeGreaterThan(0);
    expect(view.hits.every((h) => h.chunkId.startsWith("d"))).toBe(true);
  });

  it("keeps the chunks and the context state without hits when the re-search fails with a library error", async () => {
    vi.mocked(search).mockRejectedValueOnce(new RagError("no_embedder"));
    const f = make({ kind: "context", query: "alpha", mode: "bm25", maxTokens: 41 }, { error: { kind: "budget_too_small", required: 43 } });
    const view = await runRecorded(f);
    expect(view.hits).toEqual([]);
    expect(view.chunks).toHaveLength(2);
    expect(view.context).toMatchObject({ kind: "tooSmall", required: 43 });
  });

  it("an expected budget_too_small keeps the hits' context state and the required figure", async () => {
    const f = make({ kind: "context", query: "alpha", mode: "bm25", maxTokens: 41 }, { error: { kind: "budget_too_small", required: 47 } });
    const view = await runRecorded(f);
    expect(view.error).toMatchObject({ kind: "budget_too_small" });
    expect(view.error).toMatchObject({ required: 43 });
    expect(view.hits.map((h) => h.chunkId)).toEqual(["d1#0", "d2#0"]);
    expect(view.chunks).toHaveLength(2);
    expect(view.context).toMatchObject({ kind: "tooSmall", required: 43, maxTokens: 41 });
  });
});

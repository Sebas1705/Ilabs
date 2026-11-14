import { describe, expect, it } from "vitest";
import { hashEmbedder } from "./embed.js";
import { RagError } from "./errors.js";
import { buildIndex } from "./index-build.js";
import { search } from "./search.js";
import type { Chunking, Document, Embedder, Hit, Mode } from "./types.js";

const P: Chunking = { type: "paragraph", maxSize: 100 };

async function rejectsWith(p: Promise<unknown>, kind: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(RagError);
    expect((e as RagError).kind).toBe(kind);
    return;
  }
  throw new Error(`expected RagError(${kind})`);
}

/** Test embedder: chunk texts and queries map to fixed vectors; records every call. */
function tableEmbedder(table: Record<string, number[]>): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async embed(texts) {
      calls.push([...texts]);
      return texts.map((t) => {
        const v = table[t];
        if (v === undefined) throw new Error(`no vector for ${t}`);
        return [...v];
      });
    },
  };
}

const ids = (hits: Hit[]): string[] => hits.map((h) => h.chunkId);

describe("buildIndex", () => {
  it("chunks documents in order, then by chunk index", async () => {
    const index = await buildIndex(
      [
        { id: "b", text: "uno\n\ndos" },
        { id: "a", text: "" },
        { id: "c", text: "tres" },
      ],
      { chunking: { type: "paragraph", maxSize: 4 } },
    );
    expect(index.chunks.map((c) => c.id)).toEqual(["b#0", "b#1", "c#0"]);
  });

  it("validates documents and chunking before any work", async () => {
    const e = tableEmbedder({});
    await rejectsWith(buildIndex([{ id: "a", text: "x" }, { id: "a", text: "y" }], { chunking: P, embedder: e }), "invalid_options");
    await rejectsWith(buildIndex([{ id: "", text: "x" }], { chunking: P, embedder: e }), "invalid_options");
    await rejectsWith(buildIndex([{ id: "a", text: "x" }], { chunking: { type: "fixed", size: 2, overlap: 2 }, embedder: e }), "invalid_options");
    await rejectsWith(buildIndex([{ id: "a", text: "x" }], { chunking: { type: "nope" } as unknown as Chunking, embedder: e }), "invalid_options");
    expect(e.calls).toEqual([]);
  });

  it("calls the embedder once with all chunk texts in index order, and never for an index without chunks", async () => {
    const e = tableEmbedder({ uno: [1, 0], dos: [0, 1] });
    await buildIndex([{ id: "a", text: "uno\n\ndos" }], { chunking: { type: "paragraph", maxSize: 3 }, embedder: e });
    expect(e.calls).toEqual([["uno", "dos"]]);
    const empty = tableEmbedder({});
    const index = await buildIndex([{ id: "a", text: "" }], { chunking: P, embedder: empty });
    expect(empty.calls).toEqual([]);
    expect(index.chunks).toEqual([]);
    expect(await search(index, "uno", { mode: "dense" })).toEqual([]);
    expect(empty.calls).toEqual([]);
  });

  it("validates the chunk embeddings eagerly", async () => {
    const docs: Document[] = [{ id: "a", text: "uno" }, { id: "b", text: "dos" }];
    const reply = (vectors: unknown): Embedder => ({ embed: async () => vectors as number[][] });
    await rejectsWith(buildIndex(docs, { chunking: P, embedder: reply([[1, 0]]) }), "invalid_embedding");
    await rejectsWith(buildIndex(docs, { chunking: P, embedder: reply([[1, 0], [1, 0], [0, 1]]) }), "invalid_embedding");
    await rejectsWith(buildIndex(docs, { chunking: P, embedder: reply([[1, 0], [1]]) }), "invalid_embedding");
    await rejectsWith(buildIndex(docs, { chunking: P, embedder: reply("nope") }), "invalid_embedding");
    await rejectsWith(buildIndex(docs, { chunking: P, embedder: reply([[1, 0], "xy"]) }), "invalid_embedding");
  });

  it("rejects NaN, infinite entries and sparse arrays as invalid_embedding (build and query)", async () => {
    const docs: Document[] = [{ id: "a", text: "uno" }, { id: "b", text: "dos" }];
    const reply = (vectors: unknown): Embedder => ({ embed: async () => vectors as number[][] });
    const holeyVector = [1, , 0];
    const holeyList = new Array(2);
    holeyList[0] = [1, 0];
    for (const bad of [[[1, Number.NaN], [0, 1]], [[1, 0], [Number.POSITIVE_INFINITY, 1]], [[1, 0, 0], holeyVector], holeyList]) {
      await rejectsWith(buildIndex(docs, { chunking: P, embedder: reply(bad) }), "invalid_embedding");
    }
    for (const badQuery of [[[Number.NaN, 0]], [[Number.NEGATIVE_INFINITY, 0]], new Array(1)]) {
      const embedder: Embedder = { embed: async (texts) => (texts.length === 2 ? [[1, 0], [0, 1]] : (badQuery as number[][])) };
      const index = await buildIndex(docs, { chunking: P, embedder });
      await rejectsWith(search(index, "uno", { mode: "dense" }), "invalid_embedding");
    }
  });

  it("does not mutate its inputs and accepts frozen ones", async () => {
    const docs = Object.freeze([Object.freeze({ id: "a", text: "Uno dos\n\ntres" })]) as unknown as Document[];
    const chunking = Object.freeze({ type: "paragraph", maxSize: 7 }) as Chunking;
    const index = await buildIndex(docs, { chunking, embedder: hashEmbedder(8) });
    expect(docs).toEqual([{ id: "a", text: "Uno dos\n\ntres" }]);
    expect(index.chunks.map((c) => c.text)).toEqual(["Uno dos", "tres"]);
  });

  it("keeps its state consistent when the caller's embedding vectors change later", async () => {
    const vectors = [[1, 0], [0, 1]];
    const index = await buildIndex([{ id: "a", text: "uno" }, { id: "b", text: "dos" }], {
      chunking: P,
      embedder: { embed: async (texts) => (texts.length === 2 ? vectors : [[1, 0]]) },
    });
    vectors[0]![0] = -5;
    expect(ids(await search(index, "uno", { mode: "dense" }))).toEqual(["a#0"]);
  });
});

describe("search bm25", () => {
  it("scores with the reference formula, summing distinct query tokens in first-appearance order", async () => {
    const index = await buildIndex(
      [
        { id: "x", text: "a b" },
        { id: "y", text: "a" },
        { id: "z", text: "c c c" },
      ],
      { chunking: P },
    );
    const N = 3;
    const avgLen = (2 + 1 + 3) / 3;
    const k1 = 1.2;
    const b = 0.75;
    const term = (n: number, tf: number, len: number) =>
      (Math.log(1 + (N - n + 0.5) / (n + 0.5)) * (tf * (k1 + 1))) / (tf + k1 * (1 - b + (b * len) / avgLen));
    const hits = await search(index, "c a A c", { mode: "bm25" });
    expect(ids(hits)).toEqual(["z#0", "y#0", "x#0"]);
    expect(hits[0]!.score).toBe(0 + term(1, 3, 3));
    expect(hits[1]!.score).toBe(0 + term(2, 1, 1));
    expect(hits[2]!.score).toBe(0 + term(2, 1, 2));
    expect(hits.map((h) => h.rank)).toEqual([1, 2, 3]);
    for (const h of hits) expect(Object.keys(h).sort()).toEqual(["chunkId", "docId", "rank", "score"]);
  });

  it("gives idf ln(4/3) for N = 1 and counts chunks without tokens in N and avgLen", async () => {
    const one = await buildIndex([{ id: "d", text: "rojo verde" }], { chunking: P });
    expect((await search(one, "rojo rojo", { mode: "bm25" }))[0]!.score).toBeCloseTo(Math.log(4 / 3), 15);
    const withEmpty = await buildIndex([{ id: "a", text: "rojo" }, { id: "b", text: "¿?" }], { chunking: P });
    const hits = await search(withEmpty, "rojo", { mode: "bm25" });
    const avgLen = 1 / 2;
    const idf = Math.log(1 + (2 - 1 + 0.5) / (1 + 0.5));
    expect(ids(hits)).toEqual(["a#0"]);
    expect(hits[0]!.score).toBe(0 + (idf * (1 * 2.2)) / (1 + 1.2 * (1 - 0.75 + (0.75 * 1) / avgLen)));
  });

  it("orders exact ties by index order and cuts at topK (default 5)", async () => {
    const docs = ["z", "y", "x", "w", "v", "u", "t"].map((id) => ({ id, text: "rojo verde" }));
    const index = await buildIndex(docs, { chunking: P });
    const hits = await search(index, "rojo", { mode: "bm25" });
    expect(ids(hits)).toEqual(["z#0", "y#0", "x#0", "w#0", "v#0"]);
    expect(ids(await search(index, "rojo", { mode: "bm25", topK: 2 }))).toEqual(["z#0", "y#0"]);
    expect((await search(index, "rojo", { mode: "bm25", topK: 100 })).length).toBe(7);
  });

  it("returns no hits for a query without tokens or an index without chunks", async () => {
    const index = await buildIndex([{ id: "a", text: "rojo" }], { chunking: P });
    expect(await search(index, "¿?", { mode: "bm25" })).toEqual([]);
    expect(await search(index, "azul", { mode: "bm25" })).toEqual([]);
    expect(await search(await buildIndex([], { chunking: P }), "rojo", { mode: "bm25" })).toEqual([]);
  });
});

describe("search dense and hybrid", () => {
  const table = {
    "rojo uno": [1, 0, 0],
    "rojo rojo dos": [0.5, 0.5, 0],
    "verde": [0, 0, 1],
    "neg": [-1, 0, 0],
    rojo: [1, 0.1, 0],
  };
  const docs: Document[] = [
    { id: "a", text: "rojo uno" },
    { id: "b", text: "rojo rojo dos" },
    { id: "c", text: "verde" },
    { id: "d", text: "neg" },
  ];

  it("scores the plain dot product in dimension order and excludes scores <= 0", async () => {
    const e = tableEmbedder(table);
    const index = await buildIndex(docs, { chunking: P, embedder: e });
    const hits = await search(index, "rojo", { mode: "dense" });
    expect(e.calls).toEqual([docs.map((d) => d.text), ["rojo"]]);
    expect(ids(hits)).toEqual(["a#0", "b#0"]);
    expect(hits[0]!.score).toBe(0 + 1 * 1 + 0 * 0.1 + 0 * 0);
    expect(hits[1]!.score).toBe(0 + 0.5 * 1 + 0.5 * 0.1 + 0 * 0);
    for (const h of hits) expect(Object.hasOwn(h, "bm25Rank") || Object.hasOwn(h, "denseRank")).toBe(false);
  });

  it("fuses the two cut rankings with 1 / (60 + rank), BM25 term first", async () => {
    const index = await buildIndex(docs, { chunking: P, embedder: tableEmbedder(table) });
    const bm25 = await search(index, "rojo", { mode: "bm25", topK: 50 });
    const dense = await search(index, "rojo", { mode: "dense", topK: 50 });
    expect(ids(bm25)).toEqual(["b#0", "a#0"]);
    expect(ids(dense)).toEqual(["a#0", "b#0"]);
    const hybrid = await search(index, "rojo", { mode: "hybrid" });
    // a: bm25 2, dense 1; b: bm25 1, dense 2. Same set of terms: exact tie, index order.
    expect(hybrid).toEqual([
      { chunkId: "a#0", docId: "a", rank: 1, score: 1 / 62 + 1 / 61, bm25Rank: 2, denseRank: 1 },
      { chunkId: "b#0", docId: "b", rank: 2, score: 1 / 61 + 1 / 62, bm25Rank: 1, denseRank: 2 },
    ]);
    const cut = await search(index, "rojo", { mode: "hybrid", candidates: 1, topK: 1 });
    expect(cut).toEqual([{ chunkId: "a#0", docId: "a", rank: 1, score: 1 / 61, denseRank: 1 }]);
    expect(Object.hasOwn(cut[0]!, "bm25Rank")).toBe(false);
  });

  it("reports only the rank of the list a chunk is in", async () => {
    const t = { "uno": [0, 1], "dos": [1, 0], q: [1, 0] };
    const index = await buildIndex([{ id: "a", text: "uno" }, { id: "b", text: "dos" }], { chunking: P, embedder: tableEmbedder({ ...t, uno: [0, 1] }) });
    // Query "uno": BM25 finds a only; dense query vector comes from the table entry "uno" = [0, 1] -> a only too.
    const hits = await search(index, "uno", { mode: "hybrid" });
    expect(hits).toEqual([{ chunkId: "a#0", docId: "a", rank: 1, score: 1 / 61 + 1 / 61, bm25Rank: 1, denseRank: 1 }]);
  });

  it("ties identical hash vectors exactly and keeps index order", async () => {
    const index = await buildIndex([{ id: "zeta", text: "faro rojo" }, { id: "alfa", text: "faro rojo" }], { chunking: P, embedder: hashEmbedder() });
    const hits = await search(index, "faro", { mode: "dense" });
    expect(ids(hits)).toEqual(["zeta#0", "alfa#0"]);
    expect(hits[0]!.score).toBe(hits[1]!.score);
  });

  it("validates the query embedding", async () => {
    const two: Embedder = { embed: async (texts) => (texts.length === 2 ? [[1, 0], [0, 1]] : [[1, 0], [0, 1]]) };
    const short: Embedder = { embed: async (texts) => (texts.length === 2 ? [[1, 0], [0, 1]] : [[1]]) };
    const twoDocs: Document[] = [{ id: "a", text: "uno" }, { id: "b", text: "dos" }];
    await rejectsWith(search(await buildIndex(twoDocs, { chunking: P, embedder: two }), "uno", { mode: "dense" }), "invalid_embedding");
    await rejectsWith(search(await buildIndex(twoDocs, { chunking: P, embedder: short }), "uno", { mode: "hybrid" }), "invalid_embedding");
  });

  it("does not call the embedder for bm25 mode or for a query without tokens", async () => {
    const e = tableEmbedder(table);
    const index = await buildIndex(docs, { chunking: P, embedder: e });
    expect(e.calls).toHaveLength(1);
    await search(index, "rojo", { mode: "bm25" });
    expect(await search(index, "¿?", { mode: "dense" })).toEqual([]);
    expect(await search(index, "", { mode: "hybrid" })).toEqual([]);
    expect(e.calls).toHaveLength(1);
  });

  it("fails with no_embedder before the early returns", async () => {
    const index = await buildIndex(docs, { chunking: P });
    await rejectsWith(search(index, "rojo", { mode: "dense" }), "no_embedder");
    await rejectsWith(search(index, "¿?", { mode: "hybrid" }), "no_embedder");
    await rejectsWith(search(await buildIndex([], { chunking: P }), "rojo", { mode: "dense" }), "no_embedder");
  });
});

describe("search options", () => {
  it("validates mode, topK and (hybrid only) candidates before no_embedder", async () => {
    const index = await buildIndex([{ id: "a", text: "rojo" }], { chunking: P });
    await rejectsWith(search(index, "rojo", { mode: "dense", topK: 0 }), "invalid_options");
    await rejectsWith(search(index, "rojo", { mode: "hybrid", topK: 1.5 }), "invalid_options");
    await rejectsWith(search(index, "rojo", { mode: "hybrid", candidates: 3 }), "invalid_options");
    await rejectsWith(search(index, "rojo", { mode: "hybrid", topK: 4, candidates: 3 }), "invalid_options");
    await rejectsWith(search(index, "rojo", { mode: "hybrid", candidates: 0 }), "invalid_options");
    await rejectsWith(search(index, "rojo", { mode: "hybrid", candidates: 5.5 }), "invalid_options");
    await rejectsWith(search(index, "rojo", { mode: "sparse" as Mode }), "invalid_options");
    await rejectsWith(search(index, "¿?", { mode: "bm25", topK: -1 }), "invalid_options");
    await rejectsWith(search(index, "rojo", { mode: "bm25", topK: "2" as unknown as number }), "invalid_options");
  });

  it("treats null as a bad value, not as absent (candidates still ignored outside hybrid)", async () => {
    const index = await buildIndex([{ id: "a", text: "rojo" }], { chunking: P, embedder: hashEmbedder() });
    const nul = null as unknown as number;
    await rejectsWith(search(index, "rojo", { mode: "bm25", topK: nul }), "invalid_options");
    await rejectsWith(search(index, "rojo", { mode: "hybrid", candidates: nul }), "invalid_options");
    await rejectsWith(search(index, "rojo", { mode: null as unknown as Mode }), "invalid_options");
    expect(ids(await search(index, "rojo", { mode: "bm25", candidates: nul }))).toEqual(["a#0"]);
    expect(ids(await search(index, "rojo", { mode: "bm25", topK: undefined }))).toEqual(["a#0"]);
  });

  it("ignores candidates outside hybrid and never compares an absent one with topK", async () => {
    const index = await buildIndex([{ id: "a", text: "rojo" }], { chunking: P, embedder: hashEmbedder() });
    expect(ids(await search(index, "rojo", { mode: "bm25", candidates: 0 }))).toEqual(["a#0"]);
    expect(ids(await search(index, "rojo", { mode: "dense", candidates: -3.5 }))).toEqual(["a#0"]);
    expect(ids(await search(index, "rojo", { mode: "hybrid", topK: 60 }))).toEqual(["a#0"]);
    expect(ids(await search(index, "rojo", { mode: "hybrid", topK: 60, candidates: 60 }))).toEqual(["a#0"]);
    expect(ids(await search(index, "rojo", { mode: "hybrid", candidates: 5 }))).toEqual(["a#0"]);
  });

  it("rejects an index that buildIndex did not make", async () => {
    await expect(search({ chunks: [] }, "rojo", { mode: "bm25" })).rejects.toThrow(TypeError);
  });
});

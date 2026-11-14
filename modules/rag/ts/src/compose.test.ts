import type { Message } from "@ilabs/providers";
import { describe, expect, it } from "vitest";
import { composeContext, RAG_INSTRUCTION } from "./compose.js";
import { RagError } from "./errors.js";
import { buildIndex } from "./index-build.js";
import type { Hit } from "./types.js";

const index = await buildIndex(
  [
    { id: "a", text: "Faro." },
    { id: "b", text: "Un faro rojo en la costa norte." },
    { id: "c", text: "Hola 😀😀😀😀" },
  ],
  { chunking: { type: "paragraph", maxSize: 100 } },
);
const hit = (chunkId: string, rank: number): Hit => ({ chunkId, docId: chunkId.slice(0, chunkId.indexOf("#")), rank, score: 1 });
const cost = (content: string): number => 4 + Math.ceil([...content].length / 4);

function budgetError(f: () => unknown): RagError {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(RagError);
    return e as RagError;
  }
  throw new Error("expected a RagError");
}

describe("RAG_INSTRUCTION", () => {
  it("is the pinned 141-code-point ASCII text", () => {
    expect(RAG_INSTRUCTION).toBe(
      "Answer the question using only the numbered sources below. Cite the sources you use as [n]. If the sources do not contain the answer, say so.",
    );
    expect([...RAG_INSTRUCTION]).toHaveLength(141);
  });
});

describe("composeContext", () => {
  it("lays out the instruction, a blank line and [n] sources separated by blank lines, without a trailing newline", () => {
    const r = composeContext([hit("a#0", 1), hit("b#0", 2)], index, { maxTokens: 1000 });
    expect(r.message).toEqual({ role: "system", content: `${RAG_INSTRUCTION}\n\n[1] Faro.\n\n[2] Un faro rojo en la costa norte.` });
    expect(Object.keys(r.message).sort()).toEqual(["content", "role"]);
    expect(r.sources).toEqual([
      { n: 1, chunkId: "a#0", docId: "a" },
      { n: 2, chunkId: "b#0", docId: "b" },
    ]);
    expect(r.droppedCount).toBe(0);
  });

  it("walks the hits in array order, never by rank", () => {
    const r = composeContext([hit("b#0", 1), hit("a#0", 7), hit("c#0", 2)], index, { maxTokens: 1000 });
    expect(r.sources.map((s) => [s.n, s.chunkId])).toEqual([[1, "b#0"], [2, "a#0"], [3, "c#0"]]);
    expect(r.message.content).toBe(`${RAG_INSTRUCTION}\n\n[1] Un faro rojo en la costa norte.\n\n[2] Faro.\n\n[3] Hola 😀😀😀😀`);
  });

  it("stops at the first source that does not fit, even if a later one would", () => {
    const one = `${RAG_INSTRUCTION}\n\n[1] Faro.`;
    const budget = cost(`${one}\n\n[2] Faro.`); // a second "Faro." would fit, the long source does not
    expect(cost(`${one}\n\n[2] Un faro rojo en la costa norte.`)).toBeGreaterThan(budget);
    const r = composeContext([hit("a#0", 1), hit("b#0", 2), hit("a#0", 3)], index, { maxTokens: budget });
    expect(r.sources.map((s) => s.chunkId)).toEqual(["a#0"]);
    expect(r.message.content).toBe(one);
    expect(r.droppedCount).toBe(2);
  });

  it("keeps a message whose cost equals maxTokens", () => {
    const content = `${RAG_INSTRUCTION}\n\n[1] Hola 😀😀😀😀`;
    const r = composeContext([hit("c#0", 1)], index, { maxTokens: cost(content) });
    expect(r.message.content).toBe(content);
    // Code points, not UTF-16 units.
    expect(cost(content)).toBeLessThan(4 + Math.ceil(content.length / 4));
  });

  it("throws budget_too_small with the cost of the message with the first source", () => {
    const required = cost(`${RAG_INSTRUCTION}\n\n[1] Un faro rojo en la costa norte.`);
    const e = budgetError(() => composeContext([hit("b#0", 1), hit("a#0", 2)], index, { maxTokens: required - 1 }));
    expect(e.kind).toBe("budget_too_small");
    expect(e.required).toBe(required);
  });

  it("gives the instruction alone for empty hits when it fits, budget_too_small otherwise", () => {
    expect(composeContext([], index, { maxTokens: 40 })).toEqual({
      message: { role: "system", content: RAG_INSTRUCTION },
      sources: [],
      droppedCount: 0,
    });
    const e = budgetError(() => composeContext([], index, { maxTokens: 39 }));
    expect(e.kind).toBe("budget_too_small");
    expect(e.required).toBe(40);
  });

  it("uses a custom counter for every cost, including required", () => {
    const seen: Message[] = [];
    const counter = (m: Message) => {
      seen.push(m);
      return [...m.content].length;
    };
    const one = `${RAG_INSTRUCTION}\n\n[1] Faro.`;
    const r = composeContext([hit("a#0", 1), hit("b#0", 2)], index, { maxTokens: [...one].length, counter });
    expect(r.sources).toHaveLength(1);
    expect(seen.every((m) => m.role === "system")).toBe(true);
    expect(seen.map((m) => m.content)).toEqual([one, `${one}\n\n[2] Un faro rojo en la costa norte.`]);
    const e = budgetError(() => composeContext([hit("b#0", 1)], index, { maxTokens: 10, counter }));
    expect(e.required).toBe([...`${RAG_INSTRUCTION}\n\n[1] Un faro rojo en la costa norte.`].length);
    const e2 = budgetError(() => composeContext([], index, { maxTokens: 10, counter: () => 11 }));
    expect(e2.required).toBe(11);
  });

  it("validates maxTokens", () => {
    for (const maxTokens of [0, -1, 2.5, Number.NaN]) {
      expect(budgetError(() => composeContext([], index, { maxTokens })).kind).toBe("invalid_options");
    }
  });

  it("does not mutate the hits", () => {
    const hits = [hit("b#0", 2), hit("a#0", 1)];
    const copy = structuredClone(hits);
    composeContext(Object.freeze(hits) as Hit[], index, { maxTokens: 1000 });
    expect(hits).toEqual(copy);
  });

  it("takes the source docId from the index chunk, not from the hit", () => {
    const r = composeContext([{ chunkId: "b#0", docId: "someone-else", rank: 1, score: 1 }], index, { maxTokens: 1000 });
    expect(r.sources).toStrictEqual([{ n: 1, chunkId: "b#0", docId: "b" }]);
  });

  it("treats a null maxTokens as invalid_options", () => {
    expect(budgetError(() => composeContext([], index, { maxTokens: null as unknown as number })).kind).toBe("invalid_options");
  });

  it("rejects a hit whose chunk is not in the index", () => {
    expect(() => composeContext([hit("zz#0", 1)], index, { maxTokens: 1000 })).toThrow(RangeError);
  });

  it("resolves every hit before the walk, so an unknown chunkId wins over a budget error or a stop", () => {
    // The first hit does not fit: still a RangeError, not budget_too_small.
    expect(() => composeContext([hit("b#0", 1), hit("zz#0", 2)], index, { maxTokens: 41 })).toThrow(RangeError);
    // fits, misfit, unknown: the walk would stop at the misfit, but the unknown hit is reported first.
    const one = `${RAG_INSTRUCTION}\n\n[1] Faro.`;
    const budget = cost(one);
    expect(composeContext([hit("a#0", 1), hit("b#0", 2)], index, { maxTokens: budget }).sources).toHaveLength(1);
    expect(() => composeContext([hit("a#0", 1), hit("b#0", 2), hit("zz#0", 3)], index, { maxTokens: budget })).toThrow(RangeError);
  });
});

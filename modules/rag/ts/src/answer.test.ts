import { MockProvider, ProviderError, type CompletionRequest, type Provider, type ScriptEntry } from "@ilabs/providers";
import { describe, expect, it } from "vitest";
import { answerWithSources } from "./answer.js";
import { RAG_INSTRUCTION } from "./compose.js";
import { hashEmbedder } from "./embed.js";
import { RagError } from "./errors.js";
import { buildIndex } from "./index-build.js";
import type { Mode } from "./types.js";

const docs = [
  { id: "lib", text: "The library opens at nine.\n\nA loan lasts three weeks." },
  { id: "bike", text: "The bike workshop fixes brakes." },
];
const index = await buildIndex(docs, { chunking: { type: "paragraph", maxSize: 40 } });
const denseIndex = await buildIndex(docs, { chunking: { type: "paragraph", maxSize: 40 }, embedder: hashEmbedder() });

function recording(inner: Provider): Provider & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  return {
    id: inner.id,
    requests,
    complete(req) {
      requests.push(structuredClone(req));
      return inner.complete(req);
    },
  };
}
const scripted = (...script: ScriptEntry[]) => recording(new MockProvider("mock", script));

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

describe("answerWithSources", () => {
  it("searches, composes and makes exactly one call with [system, user] and no other field", async () => {
    const provider = scripted({ response: "  It lasts three weeks [1] [4].\n" });
    const r = await answerWithSources(provider, index, "loan weeks", { mode: "bm25", maxTokens: 500 });
    expect(provider.requests).toEqual([
      {
        messages: [
          { role: "system", content: `${RAG_INSTRUCTION}\n\n[1] A loan lasts three weeks.` },
          { role: "user", content: "loan weeks" },
        ],
      },
    ]);
    const req = provider.requests[0]!;
    expect(Object.keys(req)).toEqual(["messages"]);
    for (const m of req.messages) expect(Object.keys(m).sort()).toEqual(["content", "role"]);
    expect(r.answer).toBe("  It lasts three weeks [1] [4].\n");
    expect(r.sources).toEqual([{ n: 1, chunkId: "lib#1", docId: "lib" }]);
    expect(r.citations).toEqual({ cited: [1], unknown: [4] });
    expect(r.hits.map((h) => h.chunkId)).toEqual(["lib#1"]);
  });

  it("returns only the kept sources when the budget drops hits", async () => {
    const provider = scripted({ response: "[1][2]" });
    const one = `${RAG_INSTRUCTION}\n\n[1] The library opens at nine.`;
    const maxTokens = 4 + Math.ceil([...one].length / 4);
    const r = await answerWithSources(provider, index, "the", { mode: "bm25", maxTokens });
    expect(r.hits.length).toBeGreaterThan(1);
    expect(r.sources).toHaveLength(1);
    expect(r.citations).toEqual({ cited: [1], unknown: [2] });
  });

  it("still calls the provider with the instruction alone when there are no hits", async () => {
    const provider = scripted({ response: "I do not know." });
    const r = await answerWithSources(provider, index, "zebra", { mode: "bm25", maxTokens: 40 });
    expect(provider.requests[0]!.messages[0]).toEqual({ role: "system", content: RAG_INSTRUCTION });
    expect(r).toEqual({ answer: "I do not know.", sources: [], citations: { cited: [], unknown: [] }, hits: [] });
  });

  it("validates every option before any work and makes zero calls on a RagError", async () => {
    const cases: Array<[Parameters<typeof answerWithSources>[3], string, typeof index]> = [
      [{ mode: "bm25", topK: 0, maxTokens: 100 }, "invalid_options", index],
      [{ mode: "bm25", maxTokens: 0 }, "invalid_options", index],
      [{ mode: "bm25", maxTokens: 2.5 }, "invalid_options", index],
      [{ mode: "nope" as Mode, maxTokens: 100 }, "invalid_options", index],
      [{ mode: "hybrid", candidates: 2, maxTokens: 100 }, "invalid_options", denseIndex],
      [{ mode: "dense", topK: 0, maxTokens: 100 }, "invalid_options", index],
      [{ mode: "dense", maxTokens: 0 }, "invalid_options", index],
      [{ mode: "dense", maxTokens: 100 }, "no_embedder", index],
      [{ mode: "bm25", maxTokens: 39 }, "budget_too_small", index],
      [{ mode: "bm25", maxTokens: 41 }, "budget_too_small", index],
    ];
    for (const [options, kind, idx] of cases) {
      const provider = scripted({ response: "x" });
      const query = kind === "budget_too_small" && options.maxTokens === 39 ? "zebra" : "library";
      const e = await caught(answerWithSources(provider, idx, query, options));
      expect(e, JSON.stringify(options)).toBeInstanceOf(RagError);
      expect((e as RagError).kind, JSON.stringify(options)).toBe(kind);
      expect(provider.requests, JSON.stringify(options)).toEqual([]);
    }
  });

  it("propagates a provider error unchanged after one call, without retries", async () => {
    for (const kind of ["rate_limit", "timeout", "invalid_output", "unavailable"] as const) {
      const provider = scripted({ error: { kind, retryAfterMs: 5 } }, { response: "never" });
      const e = await caught(answerWithSources(provider, index, "library", { mode: "bm25", maxTokens: 500 }));
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as ProviderError).kind).toBe(kind);
      expect(provider.requests).toHaveLength(1);
    }
    const exhausted = scripted();
    const e = await caught(answerWithSources(exhausted, index, "library", { mode: "bm25", maxTokens: 500 }));
    expect((e as ProviderError).kind).toBe("unavailable");
    expect(exhausted.requests).toHaveLength(1);
  });

  it("propagates the very same error object, provider or not", async () => {
    const providerError = new ProviderError("timeout");
    const other = new TypeError("boom");
    const abort = new DOMException("aborted", "AbortError");
    for (const thrown of [providerError, other, abort]) {
      let calls = 0;
      const provider: Provider = {
        id: "p",
        async complete() {
          calls++;
          throw thrown;
        },
      };
      expect(await caught(answerWithSources(provider, index, "library", { mode: "bm25", maxTokens: 500 }))).toBe(thrown);
      expect(calls).toBe(1);
    }
  });

  it("does not mutate its inputs", async () => {
    const options = Object.freeze({ mode: "bm25" as const, topK: 2, maxTokens: 500 });
    const before = index.chunks.map((c) => ({ ...c }));
    await answerWithSources(scripted({ response: "ok" }), index, "library", options);
    expect(options).toEqual({ mode: "bm25", topK: 2, maxTokens: 500 });
    expect(index.chunks).toEqual(before);
  });
});

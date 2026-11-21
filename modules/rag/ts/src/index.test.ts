import { describe, expect, it } from "vitest";
import * as api from "./index.js";

describe("public API", () => {
  it("exports only the documented runtime values", () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        "RAG_INSTRUCTION",
        "RagError",
        "answerWithSources",
        "buildIndex",
        "chunkDocument",
        "composeContext",
        "extractCitations",
        "hashEmbed",
        "hashEmbedder",
        "retrievalMetrics",
        "runFixture",
        "search",
        "tokenize",
        "tokenizeSpans",
      ].sort(),
    );
  });

  it("runs the whole pipeline through the public entry point", async () => {
    const index = await api.buildIndex(
      [
        { id: "es", text: "El préstamo dura tres semanas.\n\nLa biblioteca abre a las nueve." },
        { id: "en", text: "A loan lasts three weeks." },
      ],
      { chunking: { type: "paragraph", maxSize: 40 }, embedder: api.hashEmbedder() },
    );
    for (const mode of ["bm25", "dense", "hybrid"] as const) {
      const hits = await api.search(index, "PRESTAMO", { mode, topK: 2 });
      expect(hits[0]?.chunkId, mode).toBe("es#0");
    }
    const error = new api.RagError("budget_too_small", { required: 40 });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("RagError");
    expect(error.required).toBe(40);
    expect(Object.hasOwn(new api.RagError("no_embedder"), "required")).toBe(false);
  });
});

import type { Hit } from "@ilabs/rag";
import { render, screen, within } from "@testing-library/react";
import { LangContext, type Lang } from "../i18n";
import { HitTable } from "./HitTable";

const hybrid: Hit[] = [
  { chunkId: "a#1", docId: "a", rank: 1, score: 0.03278688524590164, bm25Rank: 1, denseRank: 1 },
  { chunkId: "b#0", docId: "b", rank: 2, score: 0.031754032258064516, bm25Rank: 2 },
  { chunkId: "c#0", docId: "c", rank: 3, score: 0.016, denseRank: 4 },
];

function mount(hits: Hit[], mode: "bm25" | "dense" | "hybrid", lang: Lang = "en") {
  return render(
    <LangContext.Provider value={lang}>
      <HitTable hits={hits} mode={mode} />
    </LangContext.Provider>,
  );
}

const headers = () => screen.getAllByRole("columnheader").map((h) => h.textContent);
const cells = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((r) => within(r).getAllByRole("cell").map((c) => c.textContent));

describe("HitTable", () => {
  it("shows the three rankings side by side in hybrid mode, with a dash and a text for a missing rank", () => {
    mount(hybrid, "hybrid");
    expect(headers()).toEqual(["Chunk", "BM25 rank", "Dense rank", "Fused rank", "Score"]);
    const rows = cells();
    expect(rows[0]).toEqual(["a#1 (a)", "1", "1", "1", "0.0328"]);
    expect(rows[1]![1]).toBe("2");
    expect(rows[1]![2]).toBe("— (not in the list)");
    expect(rows[2]![1]).toBe("— (not in the list)");
    expect(rows[2]![2]).toBe("4");
    expect(rows[2]![3]).toBe("3");
  });

  it("shows only the used ranking in the other modes", () => {
    mount(hybrid.map(({ bm25Rank: _b, denseRank: _d, ...h }) => h), "bm25");
    expect(headers()).toEqual(["Chunk", "BM25 rank", "Score"]);
    expect(cells()[0]).toEqual(["a#1 (a)", "1", "0.0328"]);
  });

  it("shows the dense column alone in dense mode", () => {
    mount([{ chunkId: "x#0", docId: "x", rank: 1, score: 2 }], "dense");
    expect(headers()).toEqual(["Chunk", "Dense rank", "Score"]);
    expect(cells()[0]).toEqual(["x#0 (x)", "1", "2.0000"]);
  });

  it("draws a decorative bar per score and names the region once", () => {
    mount(hybrid, "hybrid");
    expect(screen.getAllByRole("region", { name: "Hits" })).toHaveLength(1);
    expect(screen.getByRole("table")).not.toHaveAccessibleName();
    expect(screen.getByRole("table").querySelectorAll('.tokenbar[aria-hidden="true"]')).toHaveLength(3);
  });

  it("is localized", () => {
    mount(hybrid, "hybrid", "es");
    expect(headers()).toEqual(["Fragmento", "Posición BM25", "Posición densa", "Posición fusionada", "Puntuación"]);
    expect(screen.getByRole("region", { name: "Resultados" })).toBeInTheDocument();
  });
});

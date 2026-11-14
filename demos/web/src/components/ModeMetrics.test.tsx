import { render, screen, within } from "@testing-library/react";
import { LangContext, type Lang } from "../i18n";
import { ModeMetrics, type MetricsRow } from "./ModeMetrics";

const rows: MetricsRow[] = [
  { mode: "bm25", recallAtK: 1, precisionAtK: 1 / 3, reciprocalRank: 1, hit: true },
  { mode: "dense", recallAtK: 0, precisionAtK: 0, reciprocalRank: 0, hit: false },
  { mode: "hybrid", recallAtK: 0.5, precisionAtK: 0.5, reciprocalRank: 0.5, hit: true },
];

function mount(lang: Lang = "en") {
  return render(
    <LangContext.Provider value={lang}>
      <ModeMetrics rows={rows} />
    </LangContext.Provider>,
  );
}

describe("ModeMetrics", () => {
  it("shows recall, precision and reciprocal rank of each mode as text, with glyph + word for the hit", () => {
    mount();
    const text = screen
      .getAllByRole("row")
      .slice(1)
      .map((r) => within(r).getAllByRole("cell").map((c) => c.textContent));
    expect(text).toEqual([
      ["BM25", "1.000", "0.333", "1.000", "✓ Hit"],
      ["Dense", "0.000", "0.000", "0.000", "✕ Miss"],
      ["Hybrid", "0.500", "0.500", "0.500", "✓ Hit"],
    ]);
    expect(screen.getByRole("table").querySelectorAll('.tokenbar[aria-hidden="true"]').length).toBeGreaterThanOrEqual(3);
  });

  it("is localized", () => {
    mount("es");
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Modo", "Recall", "Precisión", "Rango recíproco", "Acierto"]);
  });
});

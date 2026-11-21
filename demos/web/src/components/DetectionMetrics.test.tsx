import type { Metrics } from "@ilabs/guardrails";
import { render, screen, within } from "@testing-library/react";
import { LangContext, type Lang } from "../i18n";
import { DetectionMetrics } from "./DetectionMetrics";

const metrics: Metrics = {
  precision: 2 / 3,
  recall: 0.5,
  f1: 4 / 7,
  byKind: [
    { kind: "email", precision: 1, recall: 1, f1: 1, expected: 2, found: 2, correct: 2 },
    { kind: "phone", precision: 0, recall: 0, f1: 0, expected: 2, found: 1, correct: 0 },
  ],
};

function mount(m: Metrics = metrics, lang: Lang = "en") {
  return render(
    <LangContext.Provider value={lang}>
      <DetectionMetrics title="PII detector" metrics={m} />
    </LangContext.Provider>,
  );
}

const rows = () =>
  within(screen.getByRole("table", { name: "PII detector" }))
    .getAllByRole("row")
    .slice(1)
    .map((r) => within(r).getAllByRole("cell").map((c) => c.textContent));

describe("DetectionMetrics", () => {
  it("shows precision, recall and F1 as text with three decimals, overall and per kind", () => {
    mount();
    expect(rows()).toEqual([
      ["All kinds", "–", "–", "–", "0.667", "0.500", "0.571"],
      ["Email", "2", "2", "2", "1.000", "1.000", "1.000"],
      ["Phone", "2", "1", "0", "0.000", "0.000", "0.000"],
    ]);
  });

  it("draws a decorative bar for every value", () => {
    mount();
    const bars = screen.getByRole("table", { name: "PII detector" }).querySelectorAll(".tokenbar");
    expect(bars).toHaveLength(9);
    for (const bar of bars) expect(bar).toHaveAttribute("aria-hidden", "true");
  });

  it("shows only the overall row for a detector without any span", () => {
    mount({ precision: 1, recall: 1, f1: 1, byKind: [] });
    expect(rows()).toEqual([["All kinds", "–", "–", "–", "1.000", "1.000", "1.000"]]);
  });

  it("translates the headers and the kinds", () => {
    mount(metrics, "es");
    const table = screen.getByRole("table", { name: "PII detector" });
    expect(within(table).getByRole("columnheader", { name: "Precisión" })).toBeInTheDocument();
    expect(within(table).getByText("Correo electrónico")).toBeInTheDocument();
    expect(within(table).getByText("Todos los tipos")).toBeInTheDocument();
  });
});

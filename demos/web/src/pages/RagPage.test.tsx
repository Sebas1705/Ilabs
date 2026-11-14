import * as rag from "@ilabs/rag";
import { RagError, type Hit } from "@ilabs/rag";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { App } from "../App";
import { LangContext, type Lang } from "../i18n";
import { groupRagFixtures, ragFixtures } from "../ragFixtures";
import { RagPage } from "./RagPage";

vi.mock("@ilabs/rag", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ilabs/rag")>();
  return {
    ...actual,
    search: vi.fn(actual.search),
    composeContext: vi.fn(actual.composeContext),
    runFixture: vi.fn(actual.runFixture),
  };
});

function mount(lang: Lang = "en") {
  return render(
    <LangContext.Provider value={lang}>
      <RagPage />
    </LangContext.Provider>,
  );
}

const settled = () => waitFor(() => expect(screen.getByRole("main")).not.toHaveAttribute("aria-busy", "true"));

async function pick(name: string) {
  fireEvent.change(screen.getByLabelText(/^(Fixture|Escenario)$/), { target: { value: name } });
  await settled();
}

const by = (name: string) => ragFixtures.find((f) => f.name === name)!;

/** The hits the contract harness (`runFixture`, not the page's own code path) returns for the fixture with other controls. */
async function libraryHits(name: string, query: string, mode: "bm25" | "dense" | "hybrid", topK: number): Promise<Hit[]> {
  const f = by(name);
  const run = await rag.runFixture({ ...f, setup: { ...f.setup, query, mode, topK } });
  return run.output?.kind === "search" ? run.output.hits : [];
}

const hitRows = () => within(screen.getByRole("region", { name: "Hits" })).getAllByRole("row").slice(1);
const hitIds = () => hitRows().map((r) => within(r).getAllByRole("cell")[0]!.querySelector("code")!.textContent);
const headers = () => within(screen.getByRole("region", { name: "Hits" })).getAllByRole("columnheader").map((h) => h.textContent);
const question = () => screen.getByLabelText("Question") as HTMLInputElement;
const status = () => screen.getByRole("status");

describe("RagPage", () => {
  it("is reachable from the nav through the registry", async () => {
    window.location.hash = "";
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("link", { name: "RAG" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Retrieval (RAG)" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "RAG" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Evals" })).not.toHaveAttribute("aria-current");
    expect(window.location.hash).toBe("#/rag");
  });

  it("offers the corpora grouped as Search, Context, Answers and Evaluation", () => {
    mount();
    const selector = screen.getByLabelText("Fixture");
    const groups = within(selector).getAllByRole("group");
    expect(groups.map((g) => g.getAttribute("label"))).toEqual(["Search", "Context", "Answers", "Evaluation"]);
    const expected = groupRagFixtures(ragFixtures).reduce((n, g) => n + g.fixtures.length, 0);
    expect(expected).toBeGreaterThanOrEqual(40);
    expect(within(selector).getAllByRole("option")).toHaveLength(expected);
    expect(within(selector).queryByRole("option", { name: /^invalid-/ })).toBeNull();
  });

  it("renders every fixture of the picker without an alert, with its chunks and a status line", async () => {
    mount();
    const options = within(screen.getByLabelText("Fixture")).getAllByRole("option").map((o) => (o as HTMLOptionElement).value);
    for (const name of options) {
      await pick(name);
      expect(screen.queryByRole("alert"), name).toBeNull();
      expect(screen.getByRole("heading", { name: "Chunks" }), name).toBeInTheDocument();
      expect(status().textContent, name).not.toBe("");
    }
  });

  it("starts on hybrid-fusion-order with the three rankings and the fused order of the library", async () => {
    mount();
    await settled();
    expect(screen.getByLabelText(/^Fixture$/)).toHaveValue("hybrid-fusion-order");
    expect(question()).toHaveValue("carné de lector");
    expect(screen.getByRole("radio", { name: "Hybrid" })).toBeChecked();
    expect(screen.getByLabelText("Results (top K)")).toHaveValue(4);
    expect(headers()).toEqual(["Chunk", "BM25 rank", "Dense rank", "Fused rank", "Score"]);
    expect(hitIds()).toEqual(["es-biblioteca#1", "es-biblioteca#2", "es-taller#0", "es-biblioteca#0"]);
    const rows = hitRows().map((r) => within(r).getAllByRole("cell").map((c) => c.textContent));
    expect(rows.map((r) => r.slice(1, 4))).toEqual([["1", "1", "1"], ["3", "2", "2"], ["2", "4", "3"], ["4", "3", "4"]]);
    expect(rows[0]![4]).toBe("0.0328");
    expect(status()).toHaveTextContent("4 hits in mode Hybrid");
  });

  it("lists the chunks of the corpus with document id and span", async () => {
    mount();
    await settled();
    const list = screen.getByRole("list", { name: "Chunks" });
    const items = within(list).getAllByRole("listitem");
    expect(items.length).toBeGreaterThan(8);
    expect(items[0]).toHaveTextContent("es-biblioteca#0");
    expect(items[0]).toHaveTextContent("Document es-biblioteca");
    expect(items[0]).toHaveTextContent(/Code points 0–\d+/);
    expect(items[0]).toHaveTextContent("La biblioteca municipal abre de lunes a viernes");
    expect(within(items[1]!).getByText(/Hit 1/)).toBeInTheDocument();
  });

  it("re-runs the library when the mode changes, and shows only the used ranking", async () => {
    mount();
    await settled();
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "BM25" }));
    await waitFor(() => expect(headers()).toEqual(["Chunk", "BM25 rank", "Score"]));
    const expected = await libraryHits("hybrid-fusion-order", "carné de lector", "bm25", 4);
    expect(hitIds()).toEqual(expected.map((h) => h.chunkId));
    expect(status()).toHaveTextContent(`${expected.length} hits in mode BM25`);
    await user.click(screen.getByRole("radio", { name: "Dense" }));
    await waitFor(() => expect(headers()).toEqual(["Chunk", "Dense rank", "Score"]));
    const dense = await libraryHits("hybrid-fusion-order", "carné de lector", "dense", 4);
    expect(hitIds()).toEqual(dense.map((h) => h.chunkId));
  });

  it("re-runs the library when the question and topK change", async () => {
    mount();
    await settled();
    fireEvent.change(question(), { target: { value: "bicicleta frenos" } });
    await waitFor(async () => {
      const expected = await libraryHits("hybrid-fusion-order", "bicicleta frenos", "hybrid", 4);
      expect(hitIds()).toEqual(expected.map((h) => h.chunkId));
    });
    expect(hitIds()[0]).toBe("es-taller#0");
    fireEvent.change(screen.getByLabelText("Results (top K)"), { target: { value: "2" } });
    await waitFor(() => expect(hitIds()).toHaveLength(2));
    expect(status()).toHaveTextContent("2 hits in mode Hybrid");
  });

  it("shows an empty state for a question without tokens, decided by the library", async () => {
    mount();
    await settled();
    fireEvent.change(question(), { target: { value: "¿? !!" } });
    expect(await screen.findByText("The question has no searchable words, so nothing was retrieved.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Hits" })).toBeNull();
    expect(status()).toHaveTextContent("0 hits in mode Hybrid");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says when words matched nothing", async () => {
    mount();
    await pick("bm25-basic-ranking");
    fireEvent.change(question(), { target: { value: "zzzqqq" } });
    expect(await screen.findByText("No chunk matched the question.")).toBeInTheDocument();
  });

  it("shows the budget bar with text values and the dropped count for context-budget-exact", async () => {
    mount();
    await pick("context-budget-exact");
    const region = screen.getByRole("region", { name: "Composed context" });
    expect(region).toHaveTextContent("Tokens: 62 of 62");
    expect(region).toHaveTextContent("Dropped sources: 1");
    expect(region.querySelector('.tokenbar[aria-hidden="true"]')).not.toBeNull();
    const f = by("context-budget-exact").expect as { message: { content: string } };
    expect(region.querySelector("pre")!.textContent).toBe(f.message.content);
  });

  it("keeps the live context in step with the question", async () => {
    mount();
    await pick("context-basic");
    const before = screen.getByRole("region", { name: "Composed context" }).querySelector("pre")!.textContent;
    fireEvent.change(question(), { target: { value: "wifi" } });
    await waitFor(() => expect(screen.getByRole("region", { name: "Composed context" }).querySelector("pre")!.textContent).not.toBe(before));
  });

  it("shows the budget-too-small state of a live run when the library reports it", async () => {
    mount();
    await pick("context-basic");
    vi.mocked(rag.composeContext).mockImplementationOnce(() => {
      throw new RagError("budget_too_small", { required: 99 });
    });
    fireEvent.change(question(), { target: { value: "tren ocho" } });
    const region = await screen.findByRole("region", { name: "Composed context" });
    await waitFor(() => expect(region).toHaveTextContent("the context needs at least 99 tokens"));
    expect(status()).toHaveTextContent("Budget too small: the context needs at least 99 tokens.");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the hit table when the live budget is too small for the first source", async () => {
    mount();
    await pick("context-stops-at-first-misfit");
    fireEvent.change(question(), { target: { value: "puerto anochecer" } });
    const region = await screen.findByRole("region", { name: "Composed context" });
    await waitFor(() => expect(region).toHaveTextContent("Budget too small"));
    expect(region.querySelector("pre")).toBeNull();
    expect(hitRows().length).toBeGreaterThan(0);
    expect(status()).toHaveTextContent("Budget too small");
    expect(screen.queryByRole("region", { name: "Error" })).toBeNull();
  });

  it("does not cap topK in the control: the library validates it", async () => {
    mount();
    await settled();
    const topK = screen.getByLabelText("Results (top K)");
    expect(topK).toHaveAttribute("min", "1");
    expect(topK).not.toHaveAttribute("max");
    fireEvent.change(topK, { target: { value: "60" } });
    await waitFor(() => expect(status()).toHaveTextContent(/hits? in mode Hybrid/));
    expect(topK).not.toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("A whole number from 1; the library validates it.")).toBeInTheDocument();
  });

  it("uses the fixture's candidates: raising topK above them is a translated library error", async () => {
    mount();
    await pick("hybrid-candidates-cut");
    expect(hitRows().length).toBe(2);
    fireEvent.change(screen.getByLabelText("Results (top K)"), { target: { value: "3" } });
    expect(await screen.findByRole("region", { name: "Error" })).toHaveTextContent("Some option is not valid.");
  });

  it("shows cited and unknown markers of an answer sample as glyph + text badges", async () => {
    mount();
    await pick("answer-unknown-citation");
    const region = screen.getByRole("region", { name: "Citation check" });
    expect(region).toHaveTextContent("Ask at the front desk [1]; see also [3] and [2].");
    const cited = within(region).getAllByText(/^Cited \[\d\]$/);
    expect(cited.map((e) => e.textContent)).toEqual(["Cited [1]", "Cited [2]"]);
    expect(within(region).getByText("Unknown [3]")).toBeInTheDocument();
    for (const badge of region.querySelectorAll(".badge")) expect(badge.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it("shows the metrics of the three modes for a labelled eval question, and follows another one", async () => {
    mount();
    await pick("eval-three-modes");
    expect(question()).toHaveValue("¿Cuánto cuesta cambiar la cadena?");
    const fx = by("eval-three-modes").expect as { questions: { modes: Record<string, { recallAtK: number; precisionAtK: number; reciprocalRank: number; hit: boolean }> }[] };
    const rowsFor = () =>
      within(screen.getByRole("region", { name: "Retrieval metrics" }))
        .getAllByRole("row")
        .slice(1)
        .map((r) => within(r).getAllByRole("cell").map((c) => c.textContent));
    const expected = (i: number) =>
      (["bm25", "dense", "hybrid"] as const).map((m) => {
        const e = fx.questions[i]!.modes[m]!;
        return [m === "bm25" ? "BM25" : m === "dense" ? "Dense" : "Hybrid", e.recallAtK.toFixed(3), e.precisionAtK.toFixed(3), e.reciprocalRank.toFixed(3), e.hit ? "✓ Hit" : "✕ Miss"];
      });
    await waitFor(() => expect(rowsFor()).toEqual(expected(0)));

    const list = screen.getByRole("list", { name: "Labelled questions" });
    expect(within(list).getAllByRole("button")).toHaveLength(5);
    await userEvent.setup().click(within(list).getByRole("button", { name: /^bicicleta/ }));
    expect(question()).toHaveValue("bicicleta");
    await waitFor(() => expect(rowsFor()).toEqual(expected(2)));
    expect(rowsFor()[0]![4]).toBe("✕ Miss");
  });

  it("says no labelled question matches an edited question of an eval fixture", async () => {
    mount();
    await pick("eval-three-modes");
    fireEvent.change(question(), { target: { value: "something else" } });
    expect(await screen.findByText("This question is not one of the labelled questions, so there are no metrics for it.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Retrieval metrics" })).toBeNull();
  });

  it("replays a script-embedder fixture as recorded and disables the controls with a hint", async () => {
    mount();
    await pick("dense-custom-embedder-dot-product");
    expect(question()).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Dense" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "BM25" })).toBeDisabled();
    expect(screen.getByLabelText("Results (top K)")).toBeDisabled();
    expect(screen.getByText(/recorded run of the fixture/i)).toBeInTheDocument();
    expect(hitIds()).toEqual(["a#0", "b#0"]);
    expect(hitRows()[0]).toHaveTextContent("2.0000");
    expect(hitRows()[1]).toHaveTextContent("0.7500");
  });

  it("replays a fixture that expects an error as recorded, with the translated message", async () => {
    mount();
    await pick("dense-no-embedder-error");
    expect(question()).toBeDisabled();
    expect(screen.getByRole("region", { name: "Error" })).toHaveTextContent("This index has no embedder, so dense and hybrid search are not available.");
    expect(status()).toHaveTextContent("This index has no embedder");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the budget-too-small state of a recorded context fixture", async () => {
    mount();
    await pick("context-first-source-too-big");
    expect(screen.getByRole("region", { name: "Composed context" })).toHaveTextContent("the context needs at least 68 tokens");
    expect(screen.queryByRole("region", { name: "Error" })).toBeNull();
    // The hits behind the error are searched again through the library and shown with the chunks.
    expect(hitRows().length).toBeGreaterThan(0);
    expect(screen.queryByText("No chunk matched the question.")).toBeNull();
    expect(screen.getAllByText(/^Hit \d+$/).length).toBeGreaterThan(0);
  });

  it("shows a recorded provider error of an answer fixture", async () => {
    mount();
    await pick("answer-provider-error");
    expect(screen.getByRole("region", { name: "Error" })).toHaveTextContent("The provider failed with rate_limit.");
  });

  it("translates a parameter error of the library and marks the field", async () => {
    mount();
    await settled();
    fireEvent.change(screen.getByLabelText("Results (top K)"), { target: { value: "0" } });
    const region = await screen.findByRole("region", { name: "Error" });
    expect(region).toHaveTextContent("Some option is not valid.");
    expect(region).toHaveTextContent("Reason:");
    expect(region).toHaveTextContent("invalid_options");
    expect(screen.getByLabelText("Results (top K)")).toHaveAttribute("aria-invalid", "true");
    expect(status()).toHaveTextContent("Some option is not valid.");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(screen.getByLabelText("Results (top K)"), { target: { value: "3" } });
    await waitFor(() => expect(hitRows()).toHaveLength(3));
    expect(screen.getByLabelText("Results (top K)")).not.toHaveAttribute("aria-invalid", "true");
  });

  it("shows an alert when a run is rejected unexpectedly", async () => {
    mount();
    await settled();
    vi.mocked(rag.search).mockRejectedValueOnce(new Error("boom"));
    fireEvent.change(question(), { target: { value: "otra pregunta" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not run the fixture: boom");
  });

  it("ignores a stale result when the question changes quickly", async () => {
    mount();
    await settled();
    let release: (hits: Hit[]) => void = () => {};
    vi.mocked(rag.search).mockImplementationOnce(() => new Promise<Hit[]>((resolve) => (release = resolve)));
    fireEvent.change(question(), { target: { value: "carné" } });
    fireEvent.change(question(), { target: { value: "bicicleta" } });
    await waitFor(() => expect(hitIds()[0]).toBe("es-taller#0"));
    release([{ chunkId: "stale#0", docId: "stale", rank: 1, score: 1 }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("stale#0")).toBeNull();
    expect(hitIds()[0]).toBe("es-taller#0");
  });

  it("never pairs the results of one fixture with another after a fast switch", async () => {
    mount();
    await settled();
    await pick("bm25-basic-ranking");
    const mode = by("bm25-basic-ranking").setup.mode as "bm25";
    const expected = await libraryHits("bm25-basic-ranking", question().value, mode, 5);
    expect(hitIds()).toEqual(expected.map((h) => h.chunkId));
    expect(headers()).toEqual(["Chunk", "BM25 rank", "Score"]);
  });

  it("explains that the dense side is the built-in hashing embedder, not a model", async () => {
    mount();
    await settled();
    expect(screen.getByText("The dense side is the built-in character n-gram hashing embedder, not a model.")).toBeInTheDocument();
  });

  it("renders in Spanish with a polite status line", async () => {
    mount("es");
    await settled();
    expect(screen.getByRole("heading", { level: 1, name: "Recuperación (RAG)" })).toBeInTheDocument();
    expect(screen.getByLabelText("Pregunta")).toHaveValue("carné de lector");
    expect(screen.getByRole("radio", { name: "Híbrido" })).toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent("4 resultados en modo Híbrido");
  });
});

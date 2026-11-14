import { render, screen, within } from "@testing-library/react";
import { LangContext, type Lang } from "../i18n";
import { ContextView, type ContextState } from "./ContextView";

function mount(context: ContextState, lang: Lang = "en") {
  return render(
    <LangContext.Provider value={lang}>
      <ContextView context={context} />
    </LangContext.Provider>,
  );
}

const content = "Answer using the sources.\n\n[1] First chunk.\n\n[2] Second chunk.";
const ok: Extract<ContextState, { kind: "ok" }> = {
  kind: "ok",
  content,
  sources: [
    { n: 1, chunkId: "a#0", docId: "a" },
    { n: 2, chunkId: "b#0", docId: "b" },
  ],
  droppedCount: 1,
  cost: 62,
  maxTokens: 62,
};

describe("ContextView", () => {
  it("prints the sources block exactly as returned", () => {
    mount(ok);
    const region = screen.getByRole("region", { name: "Composed context" });
    expect(region.querySelector("pre")!.textContent).toBe(content);
  });

  it("shows the budget as text with a decorative bar, and the dropped count", () => {
    mount(ok);
    const region = screen.getByRole("region", { name: "Composed context" });
    expect(region).toHaveTextContent("Tokens: 62 of 62");
    expect(region).toHaveTextContent("Dropped sources: 1");
    expect(region.querySelector('.tokenbar[aria-hidden="true"]')).not.toBeNull();
    const list = within(region).getByRole("list", { name: "Kept sources" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["[1] a#0", "[2] b#0"]);
  });

  it("shows the budget-too-small state with the required tokens", () => {
    mount({ kind: "tooSmall", required: 68, maxTokens: 50 });
    const region = screen.getByRole("region", { name: "Composed context" });
    expect(region).toHaveTextContent("Budget too small: the context needs at least 68 tokens but the budget is 50.");
    expect(region.querySelector("pre")).toBeNull();
  });

  it("says when no source was kept", () => {
    mount({ ...ok, sources: [], droppedCount: 0 });
    expect(screen.getByText("No source was kept.")).toBeInTheDocument();
  });

  it("is localized", () => {
    mount(ok, "es");
    const region = screen.getByRole("region", { name: "Contexto compuesto" });
    expect(region).toHaveTextContent("Tokens: 62 de 62");
    expect(region).toHaveTextContent("Fuentes descartadas: 1");
  });
});

import { render, screen, within } from "@testing-library/react";
import { LangContext, type Lang } from "../i18n";
import { HighlightedText, type HighlightFinding } from "./HighlightedText";

function mount(text: string, findings: HighlightFinding[], lang: Lang = "en") {
  return render(
    <LangContext.Provider value={lang}>
      <HighlightedText text={text} findings={findings} />
    </LangContext.Provider>,
  );
}

const region = () => screen.getByRole("region", { name: "Text with findings" });
const marks = () => Array.from(region().querySelectorAll("mark"));

describe("HighlightedText", () => {
  it("highlights each finding with its kind as text and an aria-hidden glyph, inside one named region", () => {
    mount("Escríbeme a ana@example.com mañana.", [{ id: "a", family: "pii", kind: "email", start: 12, end: 27 }]);
    expect(marks()).toHaveLength(1);
    const mark = marks()[0]!;
    expect(mark).toHaveTextContent("ana@example.com");
    expect(mark).toHaveTextContent("Email");
    expect(mark.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(mark.getAttribute("data-family")).toBe("pii");
    expect(region().textContent).toContain("Escríbeme a ");
    expect(region().textContent).toContain(" mañana.");
  });

  it("lists the findings as a text alternative with kind, code points and the matched text", () => {
    mount("Escríbeme a ana@example.com mañana.", [{ id: "a", family: "pii", kind: "email", start: 12, end: 27 }]);
    const list = within(region()).getByRole("list", { name: "Findings" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("Email");
    expect(items[0]).toHaveTextContent("Code points 12–27");
    expect(items[0]).toHaveTextContent("ana@example.com");
  });

  it("reads offsets as code points after an astral character", () => {
    mount("😀 [INST] hola", [{ id: "d", family: "injection", kind: "delimiter", start: 2, end: 8 }]);
    expect(marks()).toHaveLength(1);
    expect(marks()[0]).toHaveTextContent("[INST]");
    expect(marks()[0]!.getAttribute("data-family")).toBe("injection");
    expect(region().textContent).toContain("😀 ");
    expect(within(region()).getByRole("list", { name: "Findings" })).toHaveTextContent("Code points 2–8");
  });

  it("keeps a lone surrogate as its own code point", () => {
    mount("\ud800ab\udc00c", [
      { id: "s1", family: "pii", kind: "secret", start: 0, end: 1 },
      { id: "s2", family: "pii", kind: "phone", start: 3, end: 4 },
    ]);
    expect(marks()).toHaveLength(2);
    expect(marks()[0]!.textContent).toContain("\ud800");
    expect(marks()[0]!.textContent).not.toContain("a");
    expect(marks()[1]!.textContent).toContain("\udc00");
    expect(marks()[1]!.textContent).not.toContain("c");
  });

  it("shows the plain text and says so when nothing was found", () => {
    mount("Nothing to see", []);
    expect(marks()).toHaveLength(0);
    expect(region()).toHaveTextContent("Nothing to see");
    expect(region()).toHaveTextContent("Nothing was found in this text.");
    expect(within(region()).queryByRole("list")).toBeNull();
  });

  it("names every kind in Spanish", () => {
    mount("a@b.co", [{ id: "a", family: "pii", kind: "email", start: 0, end: 6 }], "es");
    expect(screen.getByRole("region", { name: "Texto con hallazgos" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Texto con hallazgos" }).querySelector("mark")).toHaveTextContent("Correo");
  });

  it("shows an empty text as a placeholder, not as a blank region", () => {
    mount("", []);
    expect(region()).toHaveTextContent("The text is empty.");
  });
});

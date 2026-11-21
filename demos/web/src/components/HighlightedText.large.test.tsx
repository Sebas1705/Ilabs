import { render, screen, within } from "@testing-library/react";
import { LangContext } from "../i18n";
import { HighlightedText, type HighlightFinding } from "./HighlightedText";

const region = () => screen.getByRole("region", { name: "Text with findings" });
const marks = () => Array.from(region().querySelectorAll("mark"));

function many(n: number) {
  const text = Array.from({ length: n }, (_, i) => `u${i}@example.com`).join(" ");
  let at = 0;
  const findings: HighlightFinding[] = Array.from({ length: n }, (_, i) => {
    const len = `u${i}@example.com`.length;
    const f: HighlightFinding = { id: `p${i}`, family: "pii", kind: "email", start: at, end: at + len };
    at += len + 1;
    return f;
  });
  return { text, findings };
}

function mount(text: string, findings: HighlightFinding[]) {
  return render(
    <LangContext.Provider value="en">
      <HighlightedText text={text} findings={findings} />
    </LangContext.Provider>,
  );
}

describe("HighlightedText with many findings", () => {
  it("lists the first 200 findings and says how many more there are, while every span is still marked", () => {
    const { text, findings } = many(1500);
    mount(text, findings);
    expect(marks()).toHaveLength(1500);
    const list = within(region()).getByRole("list", { name: "Findings" });
    expect(list.querySelectorAll(":scope > li")).toHaveLength(200);
    expect(region()).toHaveTextContent("+1300 more");
  });

  it("shows plain text with a note above 2,000 findings", () => {
    const { text, findings } = many(2100);
    mount(text, findings);
    expect(marks()).toHaveLength(0);
    expect(region()).toHaveTextContent("too large to highlight inline");
    expect(region().textContent).toContain("u0@example.com");
    expect(region()).toHaveTextContent("+1900 more");
  });

  it("shows plain text with a note above 200,000 code points", () => {
    mount("x".repeat(200_001), [{ id: "a", family: "pii", kind: "email", start: 0, end: 1 }]);
    expect(marks()).toHaveLength(0);
    expect(region()).toHaveTextContent("too large to highlight inline");
  });

  it("says the scan was incomplete instead of claiming nothing was found", () => {
    render(
      <LangContext.Provider value="en">
        <HighlightedText text="abc" findings={[]} incomplete />
      </LangContext.Provider>,
    );
    expect(region()).not.toHaveTextContent("Nothing was found");
  });
});

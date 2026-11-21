import { render, screen } from "@testing-library/react";
import { LangContext } from "../i18n";
import { HighlightedText } from "./HighlightedText";

const region = () => screen.getByRole("region", { name: "Text with findings" });

describe("the plain view of a text that is too large", () => {
  it("shows only the first 20,000 characters and the note that says so", () => {
    render(
      <LangContext.Provider value="en">
        <HighlightedText text={"a".repeat(150_000) + "b".repeat(60_000)} findings={[]} />
      </LangContext.Provider>,
    );
    const plain = region().querySelector(".hl-plain")!;
    expect(plain.textContent).toBe("a".repeat(20_000));
    expect(region()).toHaveTextContent("first 20,000 characters");
    expect(region()).toHaveTextContent("first 200");
  });

  it("never splits a surrogate pair at the cut", () => {
    render(
      <LangContext.Provider value="en">
        <HighlightedText text={"😀".repeat(210_000)} findings={[]} />
      </LangContext.Provider>,
    );
    const shown = region().querySelector(".hl-plain")!.textContent!;
    expect(Array.from(shown)).toHaveLength(20_000);
    expect(shown).toBe("😀".repeat(20_000));
  });
});

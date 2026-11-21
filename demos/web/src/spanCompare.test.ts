import { markSpans } from "./spanCompare";

describe("markSpans", () => {
  it("marks a span in both lists correct, an expected-only span missed and a found-only span extra", () => {
    const expected = [
      { kind: "email", start: 0, end: 5 },
      { kind: "phone", start: 10, end: 20 },
    ];
    const found = [
      { kind: "email", start: 0, end: 5 },
      { kind: "iban", start: 30, end: 40 },
    ];
    expect(markSpans(expected, found)).toEqual([
      { kind: "email", start: 0, end: 5, mark: "correct" },
      { kind: "phone", start: 10, end: 20, mark: "miss" },
      { kind: "iban", start: 30, end: 40, mark: "extra" },
    ]);
  });

  it("needs the same kind and the same offsets: a different kind or offset is a miss plus an extra", () => {
    const marked = markSpans(
      [{ kind: "email", start: 0, end: 5 }],
      [
        { kind: "phone", start: 0, end: 5 },
        { kind: "email", start: 0, end: 6 },
      ],
    );
    expect(marked.map((m) => [m.kind, m.start, m.end, m.mark])).toEqual([
      ["email", 0, 5, "miss"],
      ["phone", 0, 5, "extra"],
      ["email", 0, 6, "extra"],
    ]);
  });

  it("counts duplicates once, like the library", () => {
    const span = { kind: "secret", start: 1, end: 4 };
    expect(markSpans([span, span], [span, span, span])).toEqual([{ ...span, mark: "correct" }]);
  });

  it("orders by start, then end, then kind", () => {
    const marked = markSpans(
      [
        { kind: "phone", start: 5, end: 9 },
        { kind: "email", start: 5, end: 9 },
        { kind: "iban", start: 1, end: 2 },
      ],
      [],
    );
    expect(marked.map((m) => m.kind)).toEqual(["iban", "email", "phone"]);
  });

  it("returns nothing for two empty lists", () => {
    expect(markSpans([], [])).toEqual([]);
  });
});

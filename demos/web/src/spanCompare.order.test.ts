import { markSpans } from "./spanCompare";

describe("markSpans ordering of equal offsets", () => {
  it("follows the library's metric-kind order, not the kind string", () => {
    // By string "card" < "iban"; by METRIC_KINDS order iban (2) comes before card (3).
    const marked = markSpans(
      [
        { kind: "card", start: 0, end: 9 },
        { kind: "iban", start: 0, end: 9 },
        { kind: "delimiter", start: 0, end: 9 },
        { kind: "email", start: 0, end: 9 },
      ],
      [],
    );
    expect(marked.map((m) => m.kind)).toEqual(["email", "iban", "card", "delimiter"]);
  });
});

import { segmentText, sliceCodePoints } from "./highlight";

const texts = (s: { text: string }[]) => s.map((x) => x.text);

describe("sliceCodePoints", () => {
  it("counts code points, not UTF-16 units", () => {
    expect(sliceCodePoints("😀 [INST] hola", 2, 8)).toBe("[INST]");
    expect(sliceCodePoints("a😀b", 1, 2)).toBe("😀");
  });

  it("counts a lone surrogate as one code point", () => {
    expect(sliceCodePoints("\ud800ab", 0, 1)).toBe("\ud800");
    expect(sliceCodePoints("a\udc00b", 1, 2)).toBe("\udc00");
    expect(sliceCodePoints("😀\ud83d", 1, 2)).toBe("\ud83d");
  });

  it("clamps offsets that fall outside the text", () => {
    expect(sliceCodePoints("abc", -4, 2)).toBe("ab");
    expect(sliceCodePoints("abc", 1, 99)).toBe("bc");
    expect(sliceCodePoints("abc", 3, 1)).toBe("");
  });
});

describe("segmentText", () => {
  it("returns the whole text as one plain segment when there are no spans", () => {
    expect(segmentText("hello", [])).toEqual([{ text: "hello", marks: [] }]);
    expect(segmentText("", [])).toEqual([]);
  });

  it("splits around one span", () => {
    const s = segmentText("Escríbeme a ana@example.com mañana.", [{ start: 12, end: 27 }]);
    expect(texts(s)).toEqual(["Escríbeme a ", "ana@example.com", " mañana."]);
    expect(s.map((x) => x.marks)).toEqual([[], [0], []]);
  });

  it("reads offsets in code points after an emoji", () => {
    const s = segmentText("😀 [INST] hola", [{ start: 2, end: 8 }]);
    expect(texts(s)).toEqual(["😀 ", "[INST]", " hola"]);
  });

  it("never splits a surrogate pair and keeps a lone surrogate apart", () => {
    const s = segmentText("😀x\ud800yz", [
      { start: 0, end: 1 },
      { start: 2, end: 4 },
    ]);
    expect(texts(s)).toEqual(["😀", "x", "\ud800y", "z"]);
    expect(s.map((x) => x.marks)).toEqual([[0], [], [1], []]);
    expect(texts(s).join("")).toBe("😀x\ud800yz");
  });

  it("covers overlapping spans with every span that reaches the segment", () => {
    const s = segmentText("abcdef", [
      { start: 0, end: 4 },
      { start: 2, end: 6 },
    ]);
    expect(texts(s)).toEqual(["ab", "cd", "ef"]);
    expect(s.map((x) => x.marks)).toEqual([[0], [0, 1], [1]]);
  });

  it("ignores empty spans and clamps spans outside the text", () => {
    expect(segmentText("abc", [{ start: 1, end: 1 }])).toEqual([{ text: "abc", marks: [] }]);
    const s = segmentText("abc", [
      { start: 2, end: 9 },
      { start: -3, end: 1 },
    ]);
    expect(texts(s)).toEqual(["a", "b", "c"]);
    expect(s.map((x) => x.marks)).toEqual([[1], [], [0]]);
  });

  it("is lossless for any text", () => {
    const text = "a😀b𐀀c\ud83dd";
    expect(
      texts(
        segmentText(text, [
          { start: 1, end: 3 },
          { start: 2, end: 6 },
        ]),
      ).join(""),
    ).toBe(text);
  });
});

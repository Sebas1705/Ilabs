import { describe, expect, it } from "vitest";
import { extractCitations } from "./citations.js";
import type { Source } from "./types.js";

const sources = (...ns: number[]): Source[] => ns.map((n) => ({ n, chunkId: `c${n}#0`, docId: `c${n}` }));

describe("extractCitations", () => {
  it("splits markers into cited and unknown, in first-appearance order, deduplicated", () => {
    expect(extractCitations("a [2] b [1] c [2] d [3] [9] [4] [9]", sources(1, 2, 3))).toEqual({ cited: [2, 1, 3], unknown: [9, 4] });
  });

  it("decides cited by membership in the sources' n, not by count", () => {
    expect(extractCitations("[1] [2] [3]", sources(2, 3))).toEqual({ cited: [2, 3], unknown: [1] });
    expect(extractCitations("[1]", [])).toEqual({ cited: [], unknown: [1] });
  });

  it("accepts only [ + 1 to 9 ASCII digits without a leading zero + ]", () => {
    const notMarkers = "[1,2] [ 1 ] [1 ] [ 1] [01] [0] [] [-1] [+1] [1a] [a1] [1.5] (1) {1} 1] [1 [٢] [３] [1234567890] [ ]";
    expect(extractCitations(notMarkers, sources(1, 2))).toEqual({ cited: [], unknown: [] });
    expect(extractCitations("[123456789]", sources(1))).toEqual({ cited: [], unknown: [123456789] });
    expect(extractCitations("[10] [100]", sources(10))).toEqual({ cited: [10], unknown: [100] });
  });

  it("tries a marker at every [ and treats adjacent markers separately", () => {
    expect(extractCitations("[[2]] [3[1]] [1][2]", sources(1, 2))).toEqual({ cited: [2, 1], unknown: [] });
    expect(extractCitations("x[1][2]y", sources(1, 2))).toEqual({ cited: [1, 2], unknown: [] });
    expect(extractCitations("[[[7]", sources(1))).toEqual({ cited: [], unknown: [7] });
  });

  it("scans code points around astral characters and lone surrogates", () => {
    expect(extractCitations("😀[1]\ud800[2]\udc00", sources(1, 2))).toEqual({ cited: [1, 2], unknown: [] });
  });

  it("returns nothing for an answer without markers and does not mutate the sources", () => {
    const s = Object.freeze(sources(1)) as Source[];
    expect(extractCitations("", s)).toEqual({ cited: [], unknown: [] });
    expect(s).toEqual(sources(1));
  });
});

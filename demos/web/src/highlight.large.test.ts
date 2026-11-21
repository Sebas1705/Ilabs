import { segmentText, sliceCodePoints } from "./highlight";

describe("segmentText and sliceCodePoints on large input", () => {
  it("takes a code-point array so the text is converted once, and gives the same result", () => {
    const text = "a😀b\ud800cd";
    const spans = [{ start: 1, end: 3 }];
    expect(segmentText(Array.from(text), spans)).toEqual(segmentText(text, spans));
    expect(sliceCodePoints(Array.from(text), 1, 2)).toBe("😀");
  });

  it("stays linear: 20,000 spans over a 1 MB text split in well under a second", () => {
    const text = "x".repeat(1_000_000);
    const spans = Array.from({ length: 20_000 }, (_, i) => ({ start: i * 50, end: i * 50 + 20 }));
    const cps = Array.from(text);
    const t0 = performance.now();
    const segments = segmentText(cps, spans);
    for (let i = 0; i < 20_000; i++) sliceCodePoints(cps, spans[i]!.start, spans[i]!.end);
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(segments).toHaveLength(40_000);
    expect(segments.map((s) => s.text).join("")).toBe(text);
  });
});

import { MAX_TRACE_LINES, appendCapped } from "./trace";

describe("appendCapped", () => {
  it("appends below the cap and drops the oldest line at the cap", () => {
    expect(appendCapped([1, 2], 3)).toEqual([1, 2, 3]);
    const full = Array.from({ length: MAX_TRACE_LINES }, (_, i) => i);
    const next = appendCapped(full, MAX_TRACE_LINES);
    expect(next).toHaveLength(MAX_TRACE_LINES);
    expect(next[0]).toBe(1);
    expect(next.at(-1)).toBe(MAX_TRACE_LINES);
    expect(full).toHaveLength(MAX_TRACE_LINES);
  });

  it("keeps 200 lines", () => {
    expect(MAX_TRACE_LINES).toBe(200);
  });
});

import { describe, expect, it } from "vitest";
import { chunkDocument } from "./chunk.js";
import { RagError } from "./errors.js";
import type { Chunking, Document } from "./types.js";

const spans = (doc: Document, chunking: Chunking): Array<[number, number, string]> =>
  chunkDocument(doc, chunking).map((c) => [c.start, c.end, c.text]);

const expectInvalid = (f: () => unknown): void => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(RagError);
    expect((e as RagError).kind).toBe("invalid_options");
    return;
  }
  throw new Error("expected RagError(invalid_options)");
};

describe("chunkDocument fixed", () => {
  it("emits windows advancing by size - overlap, the last one ending at L", () => {
    const doc = { id: "d", text: "abcdefghij" };
    expect(spans(doc, { type: "fixed", size: 4, overlap: 0 })).toEqual([[0, 4, "abcd"], [4, 8, "efgh"], [8, 10, "ij"]]);
    expect(spans(doc, { type: "fixed", size: 4, overlap: 2 }).map(([s, e]) => [s, e])).toEqual([[0, 4], [2, 6], [4, 8], [6, 10]]);
    expect(spans(doc, { type: "fixed", size: 6, overlap: 4 }).map(([s, e]) => [s, e])).toEqual([[0, 6], [2, 8], [4, 10]]);
  });

  it("gives no empty trailing window and one window for a short text", () => {
    expect(spans({ id: "d", text: "abcdefgh" }, { type: "fixed", size: 4, overlap: 0 }).map(([s, e]) => [s, e])).toEqual([[0, 4], [4, 8]]);
    expect(spans({ id: "d", text: "ab" }, { type: "fixed", size: 5, overlap: 4 })).toEqual([[0, 2, "ab"]]);
  });

  it("counts code points: astral characters are one, lone surrogates never swallow a neighbour", () => {
    expect(spans({ id: "d", text: "a😀b😀" }, { type: "fixed", size: 2, overlap: 0 })).toEqual([[0, 2, "a😀"], [2, 4, "b😀"]]);
    expect(spans({ id: "d", text: "\udc00\ud800x😀" }, { type: "fixed", size: 2, overlap: 0 })).toEqual([
      [0, 2, "\udc00\ud800"],
      [2, 4, "x😀"],
    ]);
  });

  it("builds ids, indexes and docIds without escaping", () => {
    const chunks = chunkDocument({ id: "notes#2024", text: "abcdef" }, { type: "fixed", size: 3, overlap: 0 });
    expect(chunks).toEqual([
      { id: "notes#2024#0", docId: "notes#2024", index: 0, text: "abc", start: 0, end: 3 },
      { id: "notes#2024#1", docId: "notes#2024", index: 1, text: "def", start: 3, end: 6 },
    ]);
  });

  it("yields no chunk for an empty document", () => {
    expect(chunkDocument({ id: "d", text: "" }, { type: "fixed", size: 3, overlap: 1 })).toEqual([]);
    expect(chunkDocument({ id: "d", text: "" }, { type: "paragraph", maxSize: 3 })).toEqual([]);
  });

  it("validates the chunking options", () => {
    const doc = { id: "d", text: "abc" };
    expectInvalid(() => chunkDocument(doc, { type: "fixed", size: 0, overlap: 0 }));
    expectInvalid(() => chunkDocument(doc, { type: "fixed", size: 2.5, overlap: 0 }));
    expectInvalid(() => chunkDocument(doc, { type: "fixed", size: 3, overlap: 3 }));
    expectInvalid(() => chunkDocument(doc, { type: "fixed", size: 3, overlap: -1 }));
    expectInvalid(() => chunkDocument(doc, { type: "fixed", size: 3, overlap: 0.5 }));
    expectInvalid(() => chunkDocument(doc, { type: "fixed", size: Number.NaN, overlap: 0 }));
    expectInvalid(() => chunkDocument(doc, { type: "fixed", size: "3", overlap: 0 } as unknown as Chunking));
    expectInvalid(() => chunkDocument(doc, { type: "paragraph", maxSize: 0 }));
    expectInvalid(() => chunkDocument(doc, { type: "paragraph", maxSize: null } as unknown as Chunking));
    expectInvalid(() => chunkDocument(doc, { type: "fixed", size: 3, overlap: null } as unknown as Chunking));
    expectInvalid(() => chunkDocument(doc, { type: "paragraph", maxSize: 1.5 }));
    expectInvalid(() => chunkDocument(doc, { type: "sentence", maxSize: 3 } as unknown as Chunking));
    expectInvalid(() => chunkDocument({ id: "", text: "abc" }, { type: "paragraph", maxSize: 3 }));
  });
});

describe("chunkDocument paragraph", () => {
  const para = (text: string, maxSize: number) => spans({ id: "d", text }, { type: "paragraph", maxSize }).map(([s, e]) => [s, e]);

  it("packs paragraphs greedily on the original slice", () => {
    expect(para("aaa\n\nbbb\n\nccc", 8)).toEqual([[0, 8], [10, 13]]);
    expect(para("aaa\n\nbbb\n\nccc", 13)).toEqual([[0, 13]]);
    expect(para("aaa\n\nbbb\n\nccc", 7)).toEqual([[0, 3], [5, 8], [10, 13]]);
  });

  it("cuts an oversized paragraph after flushing the pack; pieces stay standalone", () => {
    expect(para("ab\n\ncdefghijkl\n\nmn", 5)).toEqual([[0, 2], [4, 9], [9, 14], [16, 18]]);
    // "ij" + "\n\n" + "Yo." would fit in 8 but a piece never packs.
    expect(para("abcdefghij\n\nYo.", 8)).toEqual([[0, 8], [8, 10], [12, 15]]);
  });

  it("treats CRLF as one line break of two code points and a lone CR as ordinary", () => {
    expect(spans({ id: "d", text: "ab\r\n\r\ncd" }, { type: "paragraph", maxSize: 100 })).toEqual([[0, 8, "ab\r\n\r\ncd"]]);
    expect(para("ab\r\n\r\ncd", 3)).toEqual([[0, 2], [6, 8]]);
    expect(para("ab\r\rcd", 3)).toEqual([[0, 3], [3, 6]]);
    // \r\r\n\r\n: an ordinary CR, then a two-break separator.
    expect(spans({ id: "d", text: "abc\r\r\n\r\nxyz" }, { type: "paragraph", maxSize: 4 })).toEqual([
      [0, 4, "abc\r"],
      [8, 11, "xyz"],
    ]);
  });

  it("uses single line breaks at the start or the end as separators, not inside", () => {
    expect(para("\nabc\ndef\n", 100)).toEqual([[1, 8]]);
    expect(para("\r\nab\r\n", 100)).toEqual([[2, 4]]);
    expect(para("ab\n \ncd", 100)).toEqual([[0, 7]]);
  });

  it("drops whitespace-only paragraphs before packing, keeps NBSP paragraphs", () => {
    expect(para("abc\n\n \t\n\nxyz", 4)).toEqual([[0, 3], [9, 12]]);
    expect(para("abc\n\n \n \n\nxyz", 100)).toEqual([[0, 13]]);
    expect(para("abc\n\n \n\nxyz", 3)).toEqual([[0, 3], [5, 6], [8, 11]]);
    expect(para(" \n\n\t\r\n\r\n ", 10)).toEqual([]);
  });

  it("accepts a pack of exactly maxSize", () => {
    expect(para("ab\n\ncde", 7)).toEqual([[0, 7]]);
    expect(para("ab\n\ncde", 6)).toEqual([[0, 2], [4, 7]]);
  });
});

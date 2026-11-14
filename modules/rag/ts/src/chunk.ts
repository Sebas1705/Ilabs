import { invalidOptions, isIntAtLeast } from "./errors.js";
import type { Chunk, Chunking, Document } from "./types.js";

/** Validates a chunking: a known `type`; `size`, `maxSize` integers `>= 1`; `overlap` an integer with `0 <= overlap < size`. */
export function validateChunking(chunking: Chunking): void {
  if (typeof chunking !== "object" || chunking === null) invalidOptions("chunking must be an object");
  const c = chunking as { type?: unknown; size?: unknown; overlap?: unknown; maxSize?: unknown };
  if (c.type === "fixed") {
    if (!isIntAtLeast(c.size, 1)) invalidOptions("size must be an integer >= 1");
    if (!isIntAtLeast(c.overlap, 0)) invalidOptions("overlap must be an integer >= 0");
    if (c.overlap >= c.size) invalidOptions("overlap must be < size");
    return;
  }
  if (c.type === "paragraph") {
    if (!isIntAtLeast(c.maxSize, 1)) invalidOptions("maxSize must be an integer >= 1");
    return;
  }
  invalidOptions(`unknown chunking type: ${String(c.type)}`);
}

/** Validates one document's shape: `id` a non-empty string, `text` a string. */
export function validateDocument(doc: Document): void {
  if (typeof doc !== "object" || doc === null) invalidOptions("a document must be an object");
  if (typeof doc.id !== "string" || doc.id.length === 0) invalidOptions("document ids must be non-empty strings");
  if (typeof doc.text !== "string") invalidOptions(`document ${doc.id}: text must be a string`);
}

/** Fixed windows `[s, min(s + size, end))` from `from`, stepping `size - overlap`, stopping after the window that reaches `end`. */
function fixedSpans(from: number, end: number, size: number, overlap: number): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  if (end <= from) return spans;
  let s = from;
  for (;;) {
    const e = Math.min(s + size, end);
    spans.push([s, e]);
    if (e === end) return spans;
    s += size - overlap;
  }
}

const isWhitespace = (ch: string): boolean => ch === " " || ch === "\t" || ch === "\r" || ch === "\n";

/** Paragraph chunking over the code points `cps` (see the contract's four steps). */
function paragraphSpans(cps: string[], maxSize: number): Array<[number, number]> {
  const L = cps.length;
  // 1. Line breaks, CRLF recognised greedily from the left; a CR not followed by LF is ordinary.
  const breaks: Array<[number, number]> = [];
  for (let i = 0; i < L; ) {
    if (cps[i] === "\r" && cps[i + 1] === "\n") {
      breaks.push([i, i + 2]);
      i += 2;
    } else if (cps[i] === "\n") {
      breaks.push([i, i + 1]);
      i += 1;
    } else {
      i += 1;
    }
  }
  // 2. Runs of directly adjacent breaks; a run is a separator with 2+ breaks or when it touches offset 0 or L.
  const separators: Array<[number, number]> = [];
  for (let i = 0; i < breaks.length; ) {
    let j = i;
    while (j + 1 < breaks.length && breaks[j + 1]![0] === breaks[j]![1]) j++;
    const start = breaks[i]![0];
    const end = breaks[j]![1];
    if (j > i || start === 0 || end === L) separators.push([start, end]);
    i = j + 1;
  }
  // 3. Paragraphs between separators; whitespace-only paragraphs (space, tab, CR, LF) are dropped before packing.
  const paragraphs: Array<[number, number]> = [];
  const addParagraph = (a: number, b: number) => {
    if (b <= a) return;
    for (let k = a; k < b; k++) {
      if (!isWhitespace(cps[k]!)) {
        paragraphs.push([a, b]);
        return;
      }
    }
  };
  let pos = 0;
  for (const [s, e] of separators) {
    addParagraph(pos, s);
    pos = e;
  }
  addParagraph(pos, L);
  // 4. Packing on the original slice.
  const out: Array<[number, number]> = [];
  let pack: [number, number] | null = null;
  for (const [a, b] of paragraphs) {
    if (b - a > maxSize) {
      if (pack !== null) out.push(pack);
      pack = null;
      for (const piece of fixedSpans(a, b, maxSize, 0)) out.push(piece);
    } else if (pack !== null && b - pack[0] <= maxSize) {
      pack = [pack[0], b];
    } else {
      if (pack !== null) out.push(pack);
      pack = [a, b];
    }
  }
  if (pack !== null) out.push(pack);
  return out;
}

/** Splits one document into chunks; offsets and lengths are code points of the original text. */
export function chunkDocument(doc: Document, chunking: Chunking): Chunk[] {
  validateDocument(doc);
  validateChunking(chunking);
  return chunkValidated(doc, chunking);
}

/** `chunkDocument` without validation (the caller validated already). */
export function chunkValidated(doc: Document, chunking: Chunking): Chunk[] {
  const cps: string[] = [];
  for (const ch of doc.text) cps.push(ch);
  const spans = chunking.type === "fixed" ? fixedSpans(0, cps.length, chunking.size, chunking.overlap) : paragraphSpans(cps, chunking.maxSize);
  return spans.map(([start, end], index) => ({
    id: `${doc.id}#${index}`,
    docId: doc.id,
    index,
    text: cps.slice(start, end).join(""),
    start,
    end,
  }));
}

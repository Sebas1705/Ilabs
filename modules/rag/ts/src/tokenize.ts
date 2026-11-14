/**
 * The pinned Latin-1 folding table of contracts/rag/README.md (62 letters, U+00C0 to U+00FF without U+00D7 and U+00F7).
 * Copied verbatim; every other code point is kept as is.
 */
const FOLD = new Map<number, string>([
  [0xc0, "a"], [0xc1, "a"], [0xc2, "a"], [0xc3, "a"], [0xc4, "a"], [0xc5, "a"],
  [0xc6, "ae"],
  [0xc7, "c"],
  [0xc8, "e"], [0xc9, "e"], [0xca, "e"], [0xcb, "e"],
  [0xcc, "i"], [0xcd, "i"], [0xce, "i"], [0xcf, "i"],
  [0xd0, "d"],
  [0xd1, "n"],
  [0xd2, "o"], [0xd3, "o"], [0xd4, "o"], [0xd5, "o"], [0xd6, "o"], [0xd8, "o"],
  [0xd9, "u"], [0xda, "u"], [0xdb, "u"], [0xdc, "u"],
  [0xdd, "y"],
  [0xde, "th"],
  [0xdf, "ss"],
  [0xe0, "a"], [0xe1, "a"], [0xe2, "a"], [0xe3, "a"], [0xe4, "a"], [0xe5, "a"],
  [0xe6, "ae"],
  [0xe7, "c"],
  [0xe8, "e"], [0xe9, "e"], [0xea, "e"], [0xeb, "e"],
  [0xec, "i"], [0xed, "i"], [0xee, "i"], [0xef, "i"],
  [0xf0, "d"],
  [0xf1, "n"],
  [0xf2, "o"], [0xf3, "o"], [0xf4, "o"], [0xf5, "o"], [0xf6, "o"], [0xf8, "o"],
  [0xf9, "u"], [0xfa, "u"], [0xfb, "u"], [0xfc, "u"],
  [0xfd, "y"], [0xff, "y"],
  [0xfe, "th"],
]);

/** Separator test on the ORIGINAL code point: ASCII other than [0-9A-Za-z], and the pinned ranges beyond ASCII. */
function isSeparator(cp: number): boolean {
  if (cp < 0x80) {
    const word = (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
    return !word;
  }
  return (cp >= 0xa0 && cp <= 0xbf) || cp === 0xd7 || cp === 0xf7 || (cp >= 0x2000 && cp <= 0x206f);
}

/** A token as its folded text and its folded code points (a lone surrogate is one code point). */
export interface Token {
  text: string;
  codePoints: number[];
}

/**
 * Tokens of `text`: maximal runs of word code points, each folded independently (ASCII A-Z to a-z, then the table).
 * Iterates code points with `for...of` (a valid surrogate pair is one code point; any other surrogate is one on its own).
 */
export function tokenizeDetailed(text: string): Token[] {
  const out: Token[] = [];
  let curText = "";
  let curCps: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (isSeparator(cp)) {
      if (curCps.length > 0) {
        out.push({ text: curText, codePoints: curCps });
        curText = "";
        curCps = [];
      }
      continue;
    }
    if (cp >= 0x41 && cp <= 0x5a) {
      curText += String.fromCharCode(cp + 0x20);
      curCps.push(cp + 0x20);
      continue;
    }
    const rep = FOLD.get(cp);
    if (rep === undefined) {
      curText += ch;
      curCps.push(cp);
      continue;
    }
    curText += rep;
    for (let i = 0; i < rep.length; i++) curCps.push(rep.charCodeAt(i));
  }
  if (curCps.length > 0) out.push({ text: curText, codePoints: curCps });
  return out;
}

/** Tokenization shared by BM25, the hash embedder and the "query without tokens" rule. */
export function tokenize(text: string): string[] {
  return tokenizeDetailed(text).map((t) => t.text);
}

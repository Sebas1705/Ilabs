/**
 * A small strict RFC 8259 parser for the gateway contract.
 *
 * `JSON.parse` cannot be used for the gateway bodies: it hides duplicate keys and turns number literals into
 * doubles, while the contract reads integers by their exact decimal value. This parser keeps every number as its
 * literal text, keeps objects as `Map`s (so `__proto__` is an ordinary key; the last duplicate wins), allows only
 * the four JSON whitespace characters around values and is iterative, so deep nesting cannot overflow the stack.
 */

export class JsonNumber {
  constructor(readonly literal: string) {}
}

export type JsonValue = null | boolean | string | JsonNumber | JsonValue[] | Map<string, JsonValue>;

type Frame = { kind: "array"; items: JsonValue[] } | { kind: "object"; map: Map<string, JsonValue>; key: string };

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const NUMBER_PARTS = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/;
const HEX4 = /^[0-9a-fA-F]{4}$/;
const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/** Parses exactly one JSON value; returns `undefined` when `text` is not strictly valid JSON. */
export function parseStrictJson(text: string): JsonValue | undefined {
  const n = text.length;
  let i = 0;
  const fail = Symbol("not json");

  const skipWhitespace = (): void => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
  };

  const readString = (): string => {
    // text[i] is the opening quote
    i++;
    let out = "";
    let start = i;
    for (;;) {
      if (i >= n) throw fail;
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        out += text.slice(start, i);
        i++;
        return out;
      }
      if (c < 0x20) throw fail;
      if (c === 0x5c) {
        out += text.slice(start, i);
        const e = text[i + 1];
        if (e === undefined) throw fail;
        if (e === "u") {
          const hex = text.slice(i + 2, i + 6);
          if (!HEX4.test(hex)) throw fail;
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
        } else {
          const mapped = Object.hasOwn(ESCAPES, e) ? ESCAPES[e] : undefined;
          if (mapped === undefined) throw fail;
          out += mapped;
          i += 2;
        }
        start = i;
      } else {
        i++;
      }
    }
  };

  const readKey = (): string => {
    skipWhitespace();
    if (text[i] !== '"') throw fail;
    const key = readString();
    skipWhitespace();
    if (text[i] !== ":") throw fail;
    i++;
    return key;
  };

  try {
    const stack: Frame[] = [];
    for (;;) {
      // Parse the start of a value.
      skipWhitespace();
      const c = text[i];
      let value: JsonValue;
      if (c === "{") {
        i++;
        skipWhitespace();
        if (text[i] === "}") {
          i++;
          value = new Map();
        } else {
          stack.push({ kind: "object", map: new Map(), key: readKey() });
          continue;
        }
      } else if (c === "[") {
        i++;
        skipWhitespace();
        if (text[i] === "]") {
          i++;
          value = [];
        } else {
          stack.push({ kind: "array", items: [] });
          continue;
        }
      } else if (c === '"') {
        value = readString();
      } else if (c === "t" && text.startsWith("true", i)) {
        i += 4;
        value = true;
      } else if (c === "f" && text.startsWith("false", i)) {
        i += 5;
        value = false;
      } else if (c === "n" && text.startsWith("null", i)) {
        i += 4;
        value = null;
      } else {
        NUMBER.lastIndex = i;
        const m = NUMBER.exec(text);
        if (m === null) throw fail;
        i += m[0].length;
        value = new JsonNumber(m[0]);
      }

      // Attach the value to its container, closing containers as long as they end.
      for (;;) {
        const top = stack[stack.length - 1];
        skipWhitespace();
        if (top === undefined) {
          if (i !== n) throw fail;
          return value;
        }
        const d = text[i];
        if (top.kind === "array") {
          top.items.push(value);
          if (d === ",") {
            i++;
            break;
          }
          if (d !== "]") throw fail;
          i++;
          stack.pop();
          value = top.items;
        } else {
          top.map.set(top.key, value);
          if (d === ",") {
            i++;
            top.key = readKey();
            break;
          }
          if (d !== "}") throw fail;
          i++;
          stack.pop();
          value = top.map;
        }
      }
    }
  } catch (e) {
    if (e === fail) return undefined;
    throw e;
  }
}

/**
 * Reads a JSON number as an integer by its exact decimal value (never through a double) and applies a cap.
 * Returns `undefined` when the number is not an integer or is negative (`-0` is `0`); otherwise `min(value, cap)`.
 * `cap` must be a safe integer below 10^15.
 */
export function readCappedNonNegativeInteger(num: JsonNumber, cap: number): number | undefined {
  const m = NUMBER_PARTS.exec(num.literal);
  if (m === null) return undefined;
  const sign = m[1] as string;
  const intPart = m[2] as string;
  const frac = m[3] ?? "";
  const exp = m[4] ?? "0";
  const all = intPart + frac;
  let start = 0;
  while (start < all.length && all.charCodeAt(start) === 48) start++; // loops, not regexes: linear on any input
  let digits = all.slice(start);
  if (digits === "") return 0;
  if (sign === "-") return undefined;
  let e = BigInt(exp) - BigInt(frac.length);
  let end = digits.length;
  while (end > 0 && digits.charCodeAt(end - 1) === 48) end--;
  e += BigInt(digits.length - end);
  digits = digits.slice(0, end);
  if (e < 0n) return undefined;
  if (BigInt(digits.length) + e > 16n) return cap;
  const value = BigInt(digits) * 10n ** e;
  return value > BigInt(cap) ? cap : Number(value);
}

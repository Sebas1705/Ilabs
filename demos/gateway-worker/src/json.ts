// Strict RFC 8259 JSON reading that keeps the literal text of every number.
//
// `JSON.parse` turns numbers into doubles, so it cannot tell `256.00000000000000001` from `256`,
// and the contract reads integers by their exact decimal value. This parser is iterative (a
// 64 KiB body of `[` must not overflow the stack), keeps objects as `Map`s (`__proto__` is an
// ordinary key; the last duplicate wins) and rejects everything the RFC rejects.

export class JsonNumber {
  readonly literal: string;

  constructor(literal: string) {
    this.literal = literal;
  }
}

export type JsonObject = Map<string, JsonValue>;
export type JsonValue = null | boolean | string | JsonNumber | JsonValue[] | JsonObject;

export type JsonResult = { ok: true; value: JsonValue } | { ok: false };

class Invalid extends Error {}

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const HEX4 = /^[0-9a-fA-F]{4}$/;
const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

type ObjectFrame = { object: JsonObject; key: string };
type Frame = { array: JsonValue[] } | ObjectFrame;

export function parseJson(text: string): JsonResult {
  try {
    return { ok: true, value: parse(text) };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false };
    throw e;
  }
}

function parse(text: string): JsonValue {
  const n = text.length;
  let i = 0;
  const stack: Frame[] = [];

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
    let run = i;
    for (;;) {
      if (i >= n) throw new Invalid();
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        out += text.slice(run, i);
        i++;
        return out;
      }
      if (c < 0x20) throw new Invalid();
      if (c === 0x5c) {
        out += text.slice(run, i);
        const e = text[i + 1];
        if (e === undefined) throw new Invalid();
        if (e === "u") {
          const hex = text.slice(i + 2, i + 6);
          if (!HEX4.test(hex)) throw new Invalid();
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
        } else {
          const simple = SIMPLE_ESCAPES[e];
          if (simple === undefined) throw new Invalid();
          out += simple;
          i += 2;
        }
        run = i;
      } else {
        i++;
      }
    }
  };

  // Reads `"key" :` into the object frame.
  const readKey = (frame: ObjectFrame): void => {
    if (text[i] !== '"') throw new Invalid();
    frame.key = readString();
    skipWhitespace();
    if (text[i] !== ":") throw new Invalid();
    i++;
  };

  for (;;) {
    // A value starts here.
    skipWhitespace();
    if (i >= n) throw new Invalid();
    const c = text[i];
    let value: JsonValue;
    if (c === "{") {
      i++;
      skipWhitespace();
      if (text[i] === "}") {
        i++;
        value = new Map();
      } else {
        const frame: ObjectFrame = { object: new Map<string, JsonValue>(), key: "" };
        readKey(frame);
        stack.push(frame);
        continue;
      }
    } else if (c === "[") {
      i++;
      skipWhitespace();
      if (text[i] === "]") {
        i++;
        value = [];
      } else {
        stack.push({ array: [] });
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
      if (m === null) throw new Invalid();
      i += m[0].length;
      value = new JsonNumber(m[0]);
    }

    // The value is complete: attach it to its parent, closing containers as long as they end here.
    for (;;) {
      const top = stack[stack.length - 1];
      if (top === undefined) {
        skipWhitespace();
        if (i !== n) throw new Invalid();
        return value;
      }
      skipWhitespace();
      const next = text[i];
      if ("array" in top) {
        top.array.push(value);
        if (next === ",") {
          i++;
          break; // parse the next element
        }
        if (next !== "]") throw new Invalid();
        i++;
        stack.pop();
        value = top.array;
      } else {
        top.object.set(top.key, value);
        if (next === ",") {
          i++;
          skipWhitespace();
          readKey(top);
          break; // parse the next member value
        }
        if (next !== "}") throw new Invalid();
        i++;
        stack.pop();
        value = top.object;
      }
    }
  }
}

export function isObject(value: JsonValue | undefined): value is JsonObject {
  return value instanceof Map;
}

const HUGE = 10n ** 40n;
const DECIMAL = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?)([0-9]+))?$/;

/**
 * The exact integer value of a JSON number literal, or null when its exact decimal value has a
 * fractional part. No floating point is involved. A value beyond 10^40 in magnitude is returned
 * clamped to plus or minus 10^40 (every limit of the contract is far below it), so a literal such
 * as `1e999999999` neither allocates nor takes time.
 */
export function integerValue(literal: string): bigint | null {
  const m = DECIMAL.exec(literal);
  if (m === null) return null;
  const negative = m[1] === "-";
  const intDigits = m[2] ?? "";
  const fracDigits = m[3] ?? "";
  let mantissa = (intDigits + fracDigits).replace(/^0+/, "");
  if (mantissa === "") return 0n; // zero (and -0) whatever the exponent
  // A loop, not /0+$/: that regex is quadratic on a long run of zeros followed by a non-zero digit.
  let end = mantissa.length;
  while (end > 0 && mantissa.charCodeAt(end - 1) === 0x30) end--;
  const trailing = mantissa.length - end;
  mantissa = mantissa.slice(0, end);

  const expDigits = (m[5] ?? "").replace(/^0+/, "");
  let exponent = 0;
  if (expDigits.length > 9) {
    // Beyond +-10^9 any non-zero mantissa is either astronomically large or not an integer.
    if (m[4] === "-") return null;
    return negative ? -HUGE : HUGE;
  }
  if (expDigits !== "") exponent = (m[4] === "-" ? -1 : 1) * Number(expDigits);

  const scale = exponent - fracDigits.length + trailing;
  if (scale < 0) return null;
  if (mantissa.length + scale > 40) return negative ? -HUGE : HUGE;
  const magnitude = BigInt(mantissa) * 10n ** BigInt(scale);
  return negative ? -magnitude : magnitude;
}

import { describe, expect, it } from "vitest";
import { integerValue, isObject, JsonNumber, parseJson, type JsonValue } from "./json.js";

function ok(text: string): JsonValue {
  const r = parseJson(text);
  if (!r.ok) throw new Error(`expected valid JSON: ${text}`);
  return r.value;
}

describe("parseJson", () => {
  it("reads every kind of value", () => {
    expect(ok("null")).toBeNull();
    expect(ok(" true\n")).toBe(true);
    expect(ok("false")).toBe(false);
    expect(ok('"a\\n\\u00e9\\ud83d\\ude00\\/"')).toBe("a\né😀/");
    expect(ok("[1, [2], {}]")).toEqual([new JsonNumber("1"), [new JsonNumber("2")], new Map()]);
    const value = ok('{"a": {"b": [true]}}');
    expect(isObject(value) && isObject(value.get("a")) && (value.get("a") as Map<string, JsonValue>).get("b")).toEqual([true]);
  });

  it("keeps the literal of numbers", () => {
    expect(ok("256.00000000000000001")).toEqual(new JsonNumber("256.00000000000000001"));
    expect(ok("-0")).toEqual(new JsonNumber("-0"));
    expect(ok("1E+3")).toEqual(new JsonNumber("1E+3"));
  });

  it("keeps a lone surrogate escape as one code unit", () => {
    expect(ok('"\\ud800"')).toBe("\ud800");
  });

  it("treats __proto__ as an ordinary key and lets the last duplicate win", () => {
    const value = ok('{"__proto__": 1, "a": 1, "a": 2}');
    expect(isObject(value) && value.get("__proto__")).toEqual(new JsonNumber("1"));
    expect(isObject(value) && value.get("a")).toEqual(new JsonNumber("2"));
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it.each([
    "",
    " ",
    "{",
    "[1,]",
    '{"a":1,}',
    "[1 2]",
    "{'a':1}",
    "{a:1}",
    '{"a" 1}',
    "01",
    "+1",
    "1.",
    ".5",
    "0x10",
    "1e",
    "-",
    "NaN",
    "Infinity",
    "tru",
    "nul",
    '"a\nb"',
    '"\\x"',
    '"\\u12"',
    '"\\u12G4"',
    '"abc',
    "/* c */ 1",
    "1 // c",
    "1 2",
    "\u00a01",
    "1\u00a0",
    "\ufeff1",
    "\f1",
    "\v1",
    "\u30001",
  ])("rejects %j", (text) => {
    expect(parseJson(text).ok).toBe(false);
  });

  it("reads 200,000 levels of nesting without overflowing the stack", () => {
    const depth = 200_000;
    expect(parseJson("[".repeat(depth) + "]".repeat(depth)).ok).toBe(true);
    expect(parseJson("[".repeat(depth)).ok).toBe(false);
    expect(parseJson('{"a":'.repeat(depth) + "1" + "}".repeat(depth)).ok).toBe(true);
  });
});

describe("integerValue (exact decimal, no floating point)", () => {
  it.each([
    ["256", 256n],
    ["256.0", 256n],
    ["1e2", 100n],
    ["1E2", 100n],
    ["25.6e1", 256n],
    ["2560e-1", 256n],
    ["1.024e3", 1024n],
    ["1500.0", 1500n],
    ["-0", 0n],
    ["0.0", 0n],
    ["0e999999999999", 0n],
    ["-5", -5n],
    ["1e0", 1n],
    ["100e-2", 1n],
    ["0.5e1", 5n],
  ])("%s is the integer %s", (literal, want) => {
    expect(integerValue(literal)).toBe(want);
  });

  it.each([
    "1.5",
    "5e-1",
    "1e-400",
    "256.00000000000000001",
    "1024.000001",
    "1e-999999999999",
    "1.5e-3",
    "1000.0000000000000000000000001",
  ])("%s is not an integer", (literal) => {
    expect(integerValue(literal)).toBeNull();
  });

  it("clamps astronomically large integers without allocating them", () => {
    const huge = 10n ** 40n;
    expect(integerValue("1e400")).toBe(huge);
    expect(integerValue("-1e400")).toBe(-huge);
    expect(integerValue("1e999999999")).toBe(huge);
    expect(integerValue("1e99999999999999999999")).toBe(huge);
    expect(integerValue("4294967297")).toBe(4_294_967_297n);
    expect(integerValue("9".repeat(1000))).toBe(huge);
  });

  it("reads a literal with a 200,000-zero run in linear time (no quadratic trailing-zero strip)", () => {
    const zeros = "0".repeat(200_000);
    const started = performance.now();
    expect(integerValue(`1${zeros}1`)).toBe(10n ** 40n); // 200,002 digits: clamped
    expect(integerValue(`-1${zeros}1`)).toBe(-(10n ** 40n));
    expect(integerValue(`1${zeros}`)).toBe(10n ** 40n); // only trailing zeros
    expect(integerValue(`1.${zeros}`)).toBe(1n); // fraction of zeros only
    expect(integerValue(`1${zeros}e-200000`)).toBe(1n);
    expect(integerValue(`0.${zeros}1`)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

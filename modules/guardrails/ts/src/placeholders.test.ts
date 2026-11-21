import { describe, expect, it } from "vitest";
import { GuardrailError } from "./errors.js";
import { detectPii } from "./pii.js";
import { PLACEHOLDER_NAMES, placeholderNumber, redact, restore } from "./placeholders.js";
import type { Mapping, PiiFinding } from "./types.js";

const red = (text: string, mapping?: Mapping) => redact(text, detectPii(text), mapping);

describe("placeholder names and shape", () => {
  it("pins the names in kind order", () => {
    expect(PLACEHOLDER_NAMES).toEqual([
      ["email", "EMAIL"],
      ["phone", "PHONE"],
      ["iban", "IBAN"],
      ["card", "CARD"],
      ["spanish_id", "SPANISH_ID"],
      ["secret", "SECRET"],
    ]);
  });

  it("placeholderNumber accepts only <NAME_n> with n >= 1 and no leading zeros", () => {
    expect(placeholderNumber("<EMAIL_1>", "EMAIL")).toBe(1);
    expect(placeholderNumber("<EMAIL_12>", "EMAIL")).toBe(12);
    for (const bad of ["<EMAIL_0>", "<EMAIL_01>", "<EMAIL_>", "<EMAIL_1", "EMAIL_1>", "<EMAIL_1 >", "<EMAIL_a>", "<PHONE_1>", "<EMAIL_ID_1>", "<EMAIL_-1>", "<EMAIL_１>", ""]) {
      expect(placeholderNumber(bad, "EMAIL"), bad).toBe(-1);
    }
    expect(placeholderNumber("<SPANISH_ID_3>", "SPANISH_ID")).toBe(3);
  });

  it("numbers of more than 9 digits are ignored like foreign shapes (not counted, not reused)", () => {
    expect(placeholderNumber("<EMAIL_999999999>", "EMAIL")).toBe(999999999);
    expect(placeholderNumber("<EMAIL_1000000000>", "EMAIL")).toBe(-1);
    expect(placeholderNumber("<EMAIL_99999999999999999999>", "EMAIL")).toBe(-1);
    const given: Mapping = [["<EMAIL_1000000000>", "ana@example.com"], ["<EMAIL_2>", "x@example.com"]];
    const r = redact("ana@example.com", detectPii("ana@example.com"), given);
    expect(r.text).toBe("<EMAIL_3>");
    expect(r.mapping.slice(-1)).toEqual([["<EMAIL_3>", "ana@example.com"]]);
  });
});

describe("redact", () => {
  it("numbers per kind from 1 in order of first appearance and builds the mapping in creation order", () => {
    const r = red("a ana@example.com b 612345678 c bob@example.org d 600000000");
    expect(r.text).toBe("a <EMAIL_1> b <PHONE_1> c <EMAIL_2> d <PHONE_2>");
    expect(r.mapping).toEqual([
      ["<EMAIL_1>", "ana@example.com"],
      ["<PHONE_1>", "612345678"],
      ["<EMAIL_2>", "bob@example.org"],
      ["<PHONE_2>", "600000000"],
    ]);
  });

  it("reuses the placeholder for the same kind and exact same text, also through a given mapping", () => {
    const r = red("ana@example.com and ana@example.com", [["<EMAIL_7>", "ana@example.com"]]);
    expect(r.text).toBe("<EMAIL_7> and <EMAIL_7>");
    expect(r.mapping).toEqual([["<EMAIL_7>", "ana@example.com"]]);
  });

  it("an equal original of another kind, or another spelling, gets its own placeholder", () => {
    const r = red("612 345 678 and 612-345-678", [["<EMAIL_1>", "612 345 678"]]);
    expect(r.text).toBe("<PHONE_1> and <PHONE_2>");
    expect(r.mapping).toEqual([
      ["<EMAIL_1>", "612 345 678"],
      ["<PHONE_1>", "612 345 678"],
      ["<PHONE_2>", "612-345-678"],
    ]);
  });

  it("continues after the largest n of the kind, ignoring foreign entries", () => {
    const given: Mapping = [
      ["<EMAIL_3>", "x@example.com"],
      ["<PHONE_01>", "foo"],
      ["<PHONE_0>", "bar"],
      ["weird", "ana@example.com"],
      ["<EMAIL_1>", "y@example.com"],
    ];
    const r = redact("ana@example.com", detectPii("ana@example.com"), given);
    expect(r.text).toBe("<EMAIL_4>");
    expect(r.mapping.slice(-1)).toEqual([["<EMAIL_4>", "ana@example.com"]]);
    expect(r.mapping).toHaveLength(6);
    const p = redact("612345678", detectPii("612345678"), given);
    expect(p.text).toBe("<PHONE_1>");
  });

  it("a foreign entry with the same original is never reused", () => {
    const r = redact("ana@example.com", detectPii("ana@example.com"), [["weird", "ana@example.com"]]);
    expect(r.text).toBe("<EMAIL_1>");
  });

  it("uses the FIRST entry when several have the same original", () => {
    const r = red("ana@example.com", [
      ["<EMAIL_5>", "ana@example.com"],
      ["<EMAIL_2>", "ana@example.com"],
    ]);
    expect(r.text).toBe("<EMAIL_5>");
  });

  it("replaces finding spans only, never every occurrence, and does not special-case placeholder-shaped text", () => {
    const text = "ana@example.com <EMAIL_1> 612345678";
    const r = red(text);
    expect(r.text).toBe("<EMAIL_1> <EMAIL_1> <PHONE_1>");
    const partial = redact(text, detectPii(text, { kinds: ["phone"] }));
    expect(partial.text).toBe("ana@example.com <EMAIL_1> <PHONE_1>");
  });

  it("copies the text outside the findings, code points included", () => {
    const text = "😀 ana@example.com \ud800 x";
    expect(red(text).text).toBe("😀 <EMAIL_1> \ud800 x");
  });

  it("returns the text and a copy of the mapping when there are no findings", () => {
    const given: Mapping = [["<EMAIL_1>", "a@example.com"]];
    const r = redact("hello", [], given);
    expect(r.text).toBe("hello");
    expect(r.mapping).toEqual(given);
    expect(r.mapping).not.toBe(given);
    expect(r.mapping[0]).not.toBe(given[0]);
  });

  it("uses every placeholder name", () => {
    const text = "ES28 0000 0000 0012 3456 7890 | 4111 1111 1111 1111 | 12345678Z | sk-aaaaaaaaaaaaaaaaaaaa";
    expect(red(text).text).toBe("<IBAN_1> | <CARD_1> | <SPANISH_ID_1> | <SECRET_1>");
  });

  it("does not mutate the given mapping or findings", () => {
    const given: Mapping = [["<EMAIL_1>", "a@example.com"]];
    const frozen = structuredClone(given);
    const findings = detectPii("b@example.com");
    const fCopy = structuredClone(findings);
    redact("b@example.com", findings, given);
    expect(given).toEqual(frozen);
    expect(findings).toEqual(fCopy);
  });

  it("rejects unsorted, overlapping, out of range or mismatching findings with invalid_options", () => {
    const text = "ana@example.com 612345678";
    const [a, b] = detectPii(text) as [PiiFinding, PiiFinding];
    const bad: Array<[string, PiiFinding[]]> = [
      ["unsorted", [b, a]],
      ["overlapping", [a, { ...b, start: a.end - 1, text: text.slice(a.end - 1, b.end) }]],
      ["negative start", [{ ...a, start: -1 }]],
      ["past the end", [{ ...b, end: 99, text: b.text }]],
      ["wrong text", [{ ...a, text: "other@example.com" }]],
      ["reversed", [{ ...a, start: 5, end: 3, text: "" }]],
      ["unknown kind", [{ ...a, kind: "nope" as never }]],
      ["non-integer", [{ ...a, start: 0.5 }]],
      ["not an object", [null as never]],
      ["text not a string", [{ ...a, text: 5 as never }]],
    ];
    for (const [name, findings] of bad) {
      try {
        redact(text, findings);
        expect.unreachable(name);
      } catch (e) {
        expect(e, name).toBeInstanceOf(GuardrailError);
        expect((e as GuardrailError).kind, name).toBe("invalid_options");
      }
    }
    expect(() => redact(text, null as never)).toThrow(GuardrailError);
    expect(() => redact(5 as never, [])).toThrow(GuardrailError);
  });

  it("rejects a bad mapping (null is a bad value) with invalid_options", () => {
    for (const mapping of [null, "x", [["a"]], [["a", 1]], [["a", "b", "c"]], [5], {}]) {
      expect(() => redact("x", [], mapping as never), JSON.stringify(mapping)).toThrow(GuardrailError);
    }
    expect(redact("x", [], undefined).mapping).toEqual([]);
  });

  it("accepts findings built by hand when they match the text", () => {
    const r = redact("ab cd", [{ kind: "secret", start: 3, end: 5, text: "cd" }]);
    expect(r).toEqual({ text: "ab <SECRET_1>", mapping: [["<SECRET_1>", "cd"]] });
  });
});

describe("restore", () => {
  it("replaces every occurrence, adjacent ones included, and leaves unknown placeholders", () => {
    expect(restore("<A><A> <B> <C>", [["<A>", "x"], ["<B>", "yy"]])).toBe("xx yy <C>");
  });

  it("is a single left-to-right pass: no re-scan, swaps do not cascade", () => {
    expect(restore("<A>", [["<A>", "<B>"], ["<B>", "z"]])).toBe("<B>");
    expect(restore("<A><B>", [["<A>", "<B>"], ["<B>", "<A>"]])).toBe("<B><A>");
  });

  it("the longest mapped placeholder at a position wins; equal placeholders use the first entry", () => {
    expect(restore("<E_1>2", [["<E_1>", "short"], ["<E_1>2", "long"]])).toBe("long");
    expect(restore("<E_1>", [["<E_1>", "first"], ["<E_1>", "second"]])).toBe("first");
  });

  it("ignores an empty placeholder", () => {
    expect(restore("abc", [["", "X"]])).toBe("abc");
    expect(restore("abc", [])).toBe("abc");
  });

  it("matches code point by code point (lone surrogates included)", () => {
    expect(restore("😀<A>\ud800", [["<A>", "😀"], ["\ud800", "L"]])).toBe("😀😀L");
  });

  it("rejects bad arguments with invalid_options and does not mutate the mapping", () => {
    expect(() => restore(5 as never, [])).toThrow(GuardrailError);
    expect(() => restore("x", null as never)).toThrow(GuardrailError);
    expect(() => restore("x", [["a"]] as never)).toThrow(GuardrailError);
    const m: Mapping = [["<A>", "x"]];
    restore("<A>", m);
    expect(m).toEqual([["<A>", "x"]]);
  });
});

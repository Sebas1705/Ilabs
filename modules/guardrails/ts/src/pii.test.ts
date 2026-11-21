import { describe, expect, it } from "vitest";
import { GuardrailError } from "./errors.js";
import { DNI_LETTERS, PII_KINDS, SECRET_PREFIXES, detectPii, ibanMod97Valid, luhnValid, resolveOverlaps } from "./pii.js";
import { fromCodePoints, isAlnum, isDigit, isLetter, isLower, isUpper, toCodePoints } from "./scan.js";

const digits = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const found = (text: string, kinds?: string[]): Array<[string, string]> =>
  detectPii(text, kinds === undefined ? undefined : { kinds: kinds as never }).map((f) => [f.kind, f.text]);

describe("ASCII helpers", () => {
  it("are explicit ranges: accents and non-ASCII digits are none of the classes", () => {
    for (const ch of ["é", "ñ", "٣", "５", "Ａ", "ａ", "_", "-", " "]) {
      const cp = ch.codePointAt(0)!;
      expect([isDigit(cp), isUpper(cp), isLower(cp), isLetter(cp), isAlnum(cp)], ch).toEqual([false, false, false, false, false]);
    }
    expect([isDigit(0x30), isDigit(0x39), isDigit(0x2f), isDigit(0x3a)]).toEqual([true, true, false, false]);
    expect([isUpper(0x41), isUpper(0x5a), isUpper(0x40), isUpper(0x5b)]).toEqual([true, true, false, false]);
    expect([isLower(0x61), isLower(0x7a), isLower(0x60), isLower(0x7b)]).toEqual([true, true, false, false]);
    expect(isAlnum(0x35) && isAlnum(0x71) && isAlnum(0x51)).toBe(true);
  });

  it("toCodePoints splits surrogate pairs only when valid", () => {
    expect(toCodePoints("a😀b")).toEqual([0x61, 0x1f600, 0x62]);
    expect(toCodePoints("\udc00\ud800")).toEqual([0xdc00, 0xd800]);
    expect(fromCodePoints(toCodePoints("a😀b\ud800"), 1, 4)).toBe("😀b\ud800");
    expect(fromCodePoints([], 0, 0)).toBe("");
  });
});

describe("pinned constants", () => {
  it("has the pinned kind order, prefixes and DNI table", () => {
    expect(PII_KINDS).toEqual(["email", "phone", "iban", "card", "spanish_id", "secret"]);
    expect(SECRET_PREFIXES).toEqual(["sk-", "pk-", "ghp_", "gho_", "github_pat_", "AKIA", "AIza", "xoxb-", "xoxp-"]);
    expect(DNI_LETTERS).toBe("TRWAGMYFPDXBNJZSQVHLCKE");
    expect(DNI_LETTERS).toHaveLength(23);
  });
});

describe("checksums (hand values)", () => {
  it("Luhn: published numbers pass, one wrong digit or wrong parity fails", () => {
    for (const ok of ["4111111111111111", "5555555555554444", "4222222222222", "378282246310005", "4000000000000000006"]) {
      expect(luhnValid(digits(ok)), ok).toBe(true);
    }
    expect(luhnValid(digits("4111111111111112"))).toBe(false);
    expect(luhnValid(digits("0000000000000"))).toBe(true);
  });

  it("IBAN mod 97 digit by digit: hand-computed remainders", () => {
    expect(ibanMod97Valid(digits("ES2800000000001234567890"))).toBe(true);
    expect(ibanMod97Valid(digits("ES2900000000001234567890"))).toBe(false);
    expect(ibanMod97Valid(digits("GB31TEST4111111111111111"))).toBe(true);
    expect(ibanMod97Valid(digits("GB32TEST4111111111111111"))).toBe(false);
    expect(ibanMod97Valid(digits("ES5500000000001"))).toBe(true);
  });

  it("IBAN: letters count as two decimal digits (GB31 TEST 4111 1111 1111 1111)", () => {
    expect(found("GB31 TEST 4111 1111 1111 1111")).toEqual([["iban", "GB31 TEST 4111 1111 1111 1111"]]);
  });
});

describe("email", () => {
  it("finds an address with plus, underscore and dotted parts", () => {
    expect(found("a ana.perez+x_y@mail.example.org.")).toEqual([["email", "ana.perez+x_y@mail.example.org"]]);
  });
  it("requires >= 2 labels and a letters-only last label of at least two", () => {
    expect(found("ana@example")).toEqual([]);
    expect(found("ana@example.c")).toEqual([]);
    expect(found("ana@example.c0m")).toEqual([]);
    expect(found("ana@example.com-")).toEqual([]);
    expect(found("ana@example.co")).toEqual([["email", "ana@example.co"]]);
  });
  it("never starts after . _ % + - @ nor ASCII alnum, and stops on dot rules", () => {
    expect(found("x@ana@example.com")).toEqual([]);
    expect(found("..ana@example.org")).toEqual([]);
    expect(found("x@example.org@example.com")).toEqual([["email", "x@example.org"]]);
    expect(found("a..b@example.com")).toEqual([]);
    expect(found("ana.@example.com")).toEqual([]);
    expect(found(" -ana@example.com")).toEqual([["email", "-ana@example.com"]]);
  });
  it("a trailing dot is not consumed", () => {
    expect(detectPii("ana@example.com.")[0]!.end).toBe(15);
  });
});

describe("phone", () => {
  it("accepts 9 digits starting 6-9, with mixed single separators", () => {
    expect(found("612 345 678")).toEqual([["phone", "612 345 678"]]);
    expect(found("612-345.678")).toEqual([["phone", "612-345.678"]]);
    expect(found("512345678")).toEqual([]);
    expect(found("612345678")).toEqual([["phone", "612345678"]]);
  });
  it("+ numbers need 8 to 15 digits and + directly before a digit", () => {
    expect(found("+34 600 000 000")).toEqual([["phone", "+34 600 000 000"]]);
    expect(found("+1111 1111")).toEqual([["phone", "+1111 1111"]]);
    expect(found("+111 1111")).toEqual([]);
    expect(found("+ 34 600 000 000")).toEqual([["phone", "600 000 000"]]);
    expect(found("+123456789012345")).toEqual([["phone", "+123456789012345"]]);
    expect(found("+1234567890123456")).toEqual([]);
  });
  it("no backtracking, but every offset is its own start", () => {
    expect(found("612 345 678 90")).toEqual([]);
    expect(found("91 612 345 678")).toEqual([["phone", "612 345 678"]]);
    expect(found("612  345 678")).toEqual([]);
    expect(found("612 345 678.")).toEqual([["phone", "612 345 678"]]);
  });
  it("the glue test is ASCII only", () => {
    expect(found("aquí612345678")).toEqual([["phone", "612345678"]]);
    expect(found("teléfono612345678")).toEqual([]);
    expect(found("612345678x")).toEqual([]);
    expect(found("tel+34600000000")).toEqual([]);
  });
});

describe("iban", () => {
  it("validates shape, length bounds and mod 97", () => {
    expect(found("ES28 0000 0000 0012 3456 7890")).toEqual([["iban", "ES28 0000 0000 0012 3456 7890"]]);
    expect(found("ES2800000000001234567890")).toEqual([["iban", "ES2800000000001234567890"]]);
    expect(found("ES29 0000 0000 0012 3456 7890")).toEqual([]);
    expect(found("es2800000000001234567890")).toEqual([]);
    expect(found("ES5500000000001")).toEqual([["iban", "ES5500000000001"]]);
  });
  it("swallows a following upper-case word and fails as a whole (documented miss)", () => {
    expect(found("ES28 0000 0000 0012 3456 7890 BIC")).toEqual([]);
  });
  it("characters 3 and 4 must be digits", () => {
    expect(found("ESX8 0000 0000 0012 3456 7890")).toEqual([]);
  });
});

describe("card", () => {
  it("Luhn and 13 to 19 digits, space and hyphen separators only", () => {
    expect(found("4111 1111 1111 1111")).toEqual([["card", "4111 1111 1111 1111"]]);
    expect(found("4111-1111 1111-1111")).toEqual([["card", "4111-1111 1111-1111"]]);
    expect(found("4111.1111.1111.1111")).toEqual([]);
    expect(found("4111 1111 1111 1112")).toEqual([]);
    expect(found("4222 2222 2222 2")).toEqual([["card", "4222 2222 2222 2"]]);
    expect(found("4000 0000 0000 0000 006")).toEqual([["card", "4000 0000 0000 0000 006"]]);
  });
  it("12 digits are too short; a CVV group makes a failing 19-digit run", () => {
    expect(found("424242424242")).toEqual([]);
    expect(found("4111 1111 1111 1111 123")).toEqual([]);
  });
});

describe("spanish_id", () => {
  it("DNI: exactly 8 digits and the table letter (either case, optional hyphen)", () => {
    expect(found("12345678Z")).toEqual([["spanish_id", "12345678Z"]]);
    expect(found("12345678z")).toEqual([["spanish_id", "12345678z"]]);
    expect(found("12345678-Z")).toEqual([["spanish_id", "12345678-Z"]]);
    expect(found("12345678 Z")).toEqual([]);
    expect(found("12345678A")).toEqual([]);
    expect(found("112345678Z")).toEqual([]);
    expect(found("00000000T")).toEqual([["spanish_id", "00000000T"]]);
    expect(found("87654321X")).toEqual([["spanish_id", "87654321X"]]);
    expect(found("DNI12345678Z")).toEqual([]);
  });
  it("NIE: X/Y/Z, exactly 7 digits and the letter of the 8-digit number", () => {
    expect(found("X1234567L")).toEqual([["spanish_id", "X1234567L"]]);
    expect(found("x1234567l")).toEqual([["spanish_id", "x1234567l"]]);
    expect(found("Y0000000Z")).toEqual([["spanish_id", "Y0000000Z"]]);
    expect(found("Z0000000M")).toEqual([["spanish_id", "Z0000000M"]]);
    expect(found("X12345678Z")).toEqual([]);
  });
});

describe("secret", () => {
  it("needs one of the nine case-sensitive prefixes and a body of at least 16 characters", () => {
    for (const p of SECRET_PREFIXES) {
      const text = `k ${p}${"a".repeat(16)} z`;
      expect(found(text), p).toEqual([["secret", `${p}${"a".repeat(16)}`]]);
      expect(found(`k ${p}${"a".repeat(15)} z`), p).toEqual([]);
    }
    expect(found("Sk-aaaaaaaaaaaaaaaaaaaa")).toEqual([]);
  });
  it("_ and - are body characters, a dot ends the body", () => {
    expect(found("sk-aaaa_aaaa-aaaa_aaaa-")).toEqual([["secret", "sk-aaaa_aaaa-aaaa_aaaa-"]]);
    expect(found("sk-aaaaaaaa.aaaaaaaaaaaa")).toEqual([]);
  });
});

describe("bounded runs (results of the linear scan equal the maximal-run rules)", () => {
  it("phone: the 10th national digit or the 16th digit with + invalidates the run", () => {
    expect(found("612 345 678 9")).toEqual([]);
    expect(found("+1 234 567 890 123 456")).toEqual([["phone", "890 123 456"]]);
    expect(found("+1 234 567 890 123 45")).toEqual([["phone", "+1 234 567 890 123 45"]]);
  });
  it("card: 19 digits pass the bound, 20 do not (the inner 16 digits still can)", () => {
    expect(found("4000 0000 0000 0000 006")).toEqual([["card", "4000 0000 0000 0000 006"]]);
    expect(found("0 4000 0000 0000 0000 006")).toEqual([["card", "4000 0000 0000 0000 006"]]);
  });
  it("iban: 34 characters pass the bound, 35 do not", () => {
    expect(found("GB82 WEST 1234 5698 7654 32")).toEqual([["iban", "GB82 WEST 1234 5698 7654 32"]]);
    expect(found("AA00 ".repeat(8) + "AA")).toEqual([]);
  });
  it("secret: a body is one run however many prefixes follow", () => {
    const body = "a".repeat(20);
    expect(found(`sk-${body}-sk-${body}`)).toEqual([["secret", `sk-${body}-sk-${body}`]]);
    expect(found(`x sk-${body}. pk-${body}`)).toEqual([["secret", `sk-${body}`], ["secret", `pk-${body}`]]);
  });
});

describe("offsets and options", () => {
  it("counts code points, not UTF-16 units", () => {
    const f = detectPii("😀 ana@example.com");
    expect(f).toEqual([{ kind: "email", start: 2, end: 17, text: "ana@example.com" }]);
    const g = detectPii("\udc00\ud800 612345678");
    expect(g).toEqual([{ kind: "phone", start: 3, end: 12, text: "612345678" }]);
  });

  it("orders findings by start", () => {
    expect(found("612345678 ana@example.com")).toEqual([
      ["phone", "612345678"],
      ["email", "ana@example.com"],
    ]);
  });

  it("an empty text has no findings", () => {
    expect(detectPii("")).toEqual([]);
  });

  it("kinds restricts the scan AND the resolution", () => {
    const iban = "ES28 0000 0000 0012 3456 7890";
    expect(found(`x ${iban}`)).toEqual([["iban", iban]]);
    expect(found("pay 4111 1111 1111 1111 now", ["card"])).toEqual([["card", "4111 1111 1111 1111"]]);
    expect(found("612345678 ana@example.com", ["email"])).toEqual([["email", "ana@example.com"]]);
  });

  it("rejects bad kinds with invalid_options", () => {
    for (const kinds of [[], ["nope"], ["card", "card"], null, "card", [1], ["constructor"], ["__proto__"]]) {
      const run = (): unknown => detectPii("x", { kinds } as never);
      expect(run, JSON.stringify(kinds)).toThrow(GuardrailError);
      try {
        run();
      } catch (e) {
        expect((e as GuardrailError).kind).toBe("invalid_options");
        expect((e as GuardrailError).message.startsWith("invalid_options: ")).toBe(true);
      }
    }
  });

  it("rejects non-object options and non-string text with invalid_options; undefined options are absent", () => {
    for (const options of [null, "x", 5, [], true]) {
      expect(() => detectPii("x", options as never), String(options)).toThrow(GuardrailError);
    }
    expect(() => detectPii(5 as never)).toThrow(GuardrailError);
    expect(detectPii("612345678", {})).toHaveLength(1);
    expect(detectPii("612345678", { kinds: undefined })).toHaveLength(1);
  });

  it("does not mutate its inputs and returns fresh arrays", () => {
    const kinds: never[] = ["email", "phone"] as never[];
    const copy = [...kinds];
    detectPii("x", { kinds });
    expect(kinds).toEqual(copy);
    expect(detectPii("")).not.toBe(detectPii(""));
  });
});

describe("overlap resolution", () => {
  const c = (kind: string, start: number, end: number) => ({ kind, start, end });
  it("earliest start wins, then the longest, then the kind order", () => {
    expect(resolveOverlaps([c("card", 5, 9), c("iban", 3, 6)])).toEqual([c("iban", 3, 6)]);
    expect(resolveOverlaps([c("email", 0, 4), c("secret", 0, 8)])).toEqual([c("secret", 0, 8)]);
    expect(resolveOverlaps([c("secret", 0, 5), c("email", 0, 5)])).toEqual([c("email", 0, 5)]);
    expect(resolveOverlaps([c("card", 0, 5), c("phone", 0, 5), c("iban", 0, 5)])).toEqual([c("phone", 0, 5)]);
  });
  it("a rejected candidate never blocks a later one; touching spans are both kept", () => {
    expect(resolveOverlaps([c("secret", 0, 10), c("iban", 4, 30), c("card", 12, 20)])).toEqual([c("secret", 0, 10), c("card", 12, 20)]);
    expect(resolveOverlaps([c("phone", 0, 5), c("card", 5, 9)])).toEqual([c("phone", 0, 5), c("card", 5, 9)]);
  });
  it("drops exact duplicates and keeps extra fields of the accepted candidate", () => {
    const a = { kind: "email", start: 0, end: 3, text: "abc" };
    expect(resolveOverlaps([a, { ...a }])).toEqual([a]);
    expect(resolveOverlaps([])).toEqual([]);
  });
  it("does not mutate the input list", () => {
    const list = [c("card", 5, 9), c("iban", 3, 6)];
    resolveOverlaps(list);
    expect(list).toEqual([c("card", 5, 9), c("iban", 3, 6)]);
  });
});

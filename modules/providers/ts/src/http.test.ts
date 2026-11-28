import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HttpProvider, TransportTimeoutError, type HttpRequest, type HttpResponse, type HttpTransport } from "./http.js";
import { runClientFixture, type ClientFixture } from "./http-contract.js";
import { JsonNumber, parseStrictJson, readCappedNonNegativeInteger, type JsonValue } from "./strict-json.js";
import { ProviderError } from "./types.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../../contracts/gateway");
const files = readdirSync(dir)
  .filter((f) => f.startsWith("client-") && f.endsWith(".json"))
  .sort();
const fixtures = files.map((f) => ({ file: f, fx: JSON.parse(readFileSync(join(dir, f), "utf8")) as ClientFixture }));

describe("gateway contract: client fixtures", () => {
  it("loads all client fixtures", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(149);
  });

  for (const { file, fx } of fixtures) {
    it(fx.name, async () => {
      expect(fx.name).toBe(file.replace(/\.json$/, ""));
      const run = await runClientFixture(fx);
      const want = fx.expect.result;
      if ("error" in want) {
        expect("error" in run.result, "expected an error").toBe(true);
        const got = (run.result as { error: { kind: string; retryAfterMs?: number } }).error;
        expect(got.kind).toBe(want.error.kind);
        if (want.error.retryAfterMs !== undefined) expect(got.retryAfterMs).toBe(want.error.retryAfterMs);
        else expect("retryAfterMs" in got).toBe(false);
      } else {
        expect(run.result).toEqual(want);
      }
      expect(run.requests.length).toBe(fx.expect.requests.length);
      fx.expect.requests.forEach((wantReq, i) => {
        const got = run.requests[i] as HttpRequest;
        expect(got.url).toBe(wantReq.url);
        expect(got.method).toBe(wantReq.method);
        expect(got.headers).toEqual(wantReq.headers);
        expect(JSON.parse(got.body)).toEqual(wantReq.body);
        expect(got.timeoutMs).toBe(wantReq.timeoutMs);
      });
    });
  }
});

describe("runClientFixture rejects malformed fixtures", () => {
  const base = (): Record<string, unknown> => ({
    kind: "client",
    name: "client-x",
    endpoint: "https://gw.example.test",
    request: { messages: [{ role: "user", content: "hi" }] },
    transport: [{ status: 200, body: { text: "ok" } }],
    expect: { result: { text: "ok", provider: "gateway" }, requests: [] },
  });
  const reason = async (fx: unknown): Promise<string> => {
    try {
      await runClientFixture(fx);
    } catch (e) {
      return (e as Error).message;
    }
    return "no error";
  };

  it("accepts the baseline", async () => {
    expect(await reason(base())).toBe("no error");
  });
  it("unknown kind", async () => {
    expect(await reason({ ...base(), kind: "weird" })).toBe("invalid fixture: unknown fixture kind: weird");
  });
  it("unknown key at several levels", async () => {
    expect(await reason({ ...base(), extra: 1 })).toBe("invalid fixture: unknown key: extra");
    expect(await reason({ ...base(), request: { messages: [], extra: 1 } })).toBe("invalid fixture: unknown key: extra");
    expect(await reason({ ...base(), transport: [{ status: 200, bogus: 1 }] })).toBe("invalid fixture: unknown key: bogus");
    expect(await reason({ ...base(), expect: { result: { text: "a", provider: "b" }, requests: [], more: 1 } })).toBe(
      "invalid fixture: unknown key: more",
    );
    expect(await reason({ ...base(), expect: { result: { error: { kind: "timeout", why: 1 } }, requests: [] } })).toBe(
      "invalid fixture: unknown key: why",
    );
  });
  it("missing key", async () => {
    const { endpoint: _e, ...rest } = base();
    expect(await reason(rest)).toBe("invalid fixture: missing key: endpoint");
    expect(await reason({ ...base(), expect: { result: { text: "a" }, requests: [] } })).toBe("invalid fixture: missing key: provider");
  });
  it("wrong type", async () => {
    expect(await reason({ ...base(), timeoutMs: "5" })).toBe("invalid fixture: wrong type: timeoutMs");
    expect(await reason({ ...base(), transport: [{ status: "200" }] })).toBe("invalid fixture: wrong type: status");
    expect(await reason({ ...base(), transport: [{ status: 200, headers: { a: 1 } }] })).toBe("invalid fixture: wrong type: headers");
  });
  it("transport needs exactly one entry", async () => {
    expect(await reason({ ...base(), transport: [] })).toBe("invalid fixture: transport needs exactly one entry");
    expect(await reason({ ...base(), transport: [{ status: 200 }, { status: 200 }] })).toBe(
      "invalid fixture: transport needs exactly one entry",
    );
  });
  it("unknown throw kind", async () => {
    expect(await reason({ ...base(), transport: [{ throws: "boom" }] })).toBe("invalid fixture: unknown throw kind: boom");
  });
});

function recorder(res: Partial<HttpResponse> = {}): { transport: HttpTransport; calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  return {
    calls,
    transport: async (req) => {
      calls.push(req);
      return { status: 200, headers: {}, body: JSON.stringify({ text: "ok", provider: "gateway" }), ...res };
    },
  };
}

const hello = { messages: [{ role: "user" as const, content: "hello" }] };

async function errorOf(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ProviderError) return e;
    throw e;
  }
  throw new Error("expected a ProviderError");
}

describe("HttpProvider construction", () => {
  const { transport } = recorder();
  it("defaults the id to gateway", () => {
    expect(new HttpProvider({ endpoint: "https://gw.example.test", transport }).id).toBe("gateway");
    expect(new HttpProvider({ id: "mine", endpoint: "https://gw.example.test", transport }).id).toBe("mine");
  });
  it("rejects an empty id", () => {
    expect(() => new HttpProvider({ id: "", endpoint: "https://gw.example.test", transport })).toThrow(RangeError);
  });
  it("rejects an empty endpoint or one with only slashes", () => {
    expect(() => new HttpProvider({ endpoint: "", transport })).toThrow(RangeError);
    expect(() => new HttpProvider({ endpoint: "///", transport })).toThrow(RangeError);
  });
  it("rejects a timeout that is not positive", () => {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5, 1.5, 1e300, 2 ** 53, -Infinity]) {
      expect(() => new HttpProvider({ endpoint: "https://gw.example.test", transport, timeoutMs })).toThrow(RangeError);
    }
    expect(() => new HttpProvider({ endpoint: "https://gw.example.test", transport, timeoutMs: 1 })).not.toThrow();
    expect(() => new HttpProvider({ endpoint: "https://gw.example.test", transport, timeoutMs: 2 ** 53 - 1 })).not.toThrow();
  });
  it("treats a null apiKey as no key", async () => {
    const r = recorder();
    await new HttpProvider({ endpoint: "https://gw.example.test", transport: r.transport, apiKey: null }).complete(hello);
    expect(Object.keys(r.calls[0]?.headers ?? {})).toEqual(["content-type"]);
  });
  it("counts a no-break space, a form feed and an ideographic space as visible characters of a key", async () => {
    for (const apiKey of [" ", "", "　", "", "   "]) {
      const r = recorder();
      await new HttpProvider({ endpoint: "https://gw.example.test", transport: r.transport, apiKey }).complete(hello);
      expect(r.calls[0]?.headers["x-ilabs-api-key"], JSON.stringify(apiKey)).toBe(apiKey);
    }
  });
  it("trims a huge run of trailing slashes in linear time", () => {
    const { transport } = recorder();
    const started = performance.now();
    const p = new HttpProvider({ endpoint: `${"/".repeat(200_000)}x`, transport });
    new HttpProvider({ endpoint: `https://gw.example.test${"/".repeat(200_000)}`, transport });
    expect(() => new HttpProvider({ endpoint: "/".repeat(200_000), transport })).toThrow(RangeError);
    expect(p.id).toBe("gateway");
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("HttpProvider request", () => {
  it("normalizes the endpoint", async () => {
    for (const [endpoint, url] of [
      ["https://gw.example.test", "https://gw.example.test/v1/complete"],
      ["https://gw.example.test/", "https://gw.example.test/v1/complete"],
      ["https://gw.example.test///", "https://gw.example.test/v1/complete"],
      ["https://gw.example.test/api/", "https://gw.example.test/api/v1/complete"],
    ] as const) {
      const r = recorder();
      await new HttpProvider({ endpoint, transport: r.transport }).complete(hello);
      expect(r.calls[0]?.url).toBe(url);
    }
  });

  it("sends the api key header only when the key has a visible character, never trimmed", async () => {
    const cases: [string | undefined, string | undefined][] = [
      [undefined, undefined],
      ["", undefined],
      [" \t\r\n", undefined],
      ["k", "k"],
      [" k ", " k "],
    ];
    for (const [apiKey, sent] of cases) {
      const r = recorder();
      await new HttpProvider({
        endpoint: "https://gw.example.test",
        transport: r.transport,
        ...(apiKey !== undefined ? { apiKey } : {}),
      }).complete(hello);
      const headers = r.calls[0]?.headers;
      expect(headers?.["content-type"]).toBe("application/json");
      expect(headers?.["x-ilabs-api-key"]).toBe(sent);
      expect(Object.keys(headers ?? {}).length).toBe(sent === undefined ? 1 : 2);
      expect(r.calls[0]?.body).not.toContain("k");
    }
  });

  it("sends exactly the JSON of the request, with no other key", async () => {
    const r = recorder();
    const p = new HttpProvider({ endpoint: "https://gw.example.test", transport: r.transport, apiKey: "secret" });
    const req = {
      messages: [{ role: "user" as const, content: "h\u00e9 \u{1F600}\n\"q\"", extra: 1 }],
      maxTokens: 0,
      model: "x",
      apiKey: "nope",
    };
    await p.complete(req as never);
    expect(r.calls[0]?.body).toBe(JSON.stringify({ messages: [{ role: "user", content: "h\u00e9 \u{1F600}\n\"q\"" }], maxTokens: 0 }));
    expect(r.calls[0]?.method).toBe("POST");
    expect(r.calls[0]?.timeoutMs).toBe(25_000);
  });

  it("omits maxTokens when absent or null and forwards any number", async () => {
    for (const [maxTokens, body] of [
      [undefined, '{"messages":[{"role":"user","content":"hello"}]}'],
      [null, '{"messages":[{"role":"user","content":"hello"}]}'],
      [-3, '{"messages":[{"role":"user","content":"hello"},{"role":"bogus","content":""}],"maxTokens":-3}'],
    ] as const) {
      const r = recorder();
      const messages =
        maxTokens === -3
          ? [...hello.messages, { role: "bogus" as never, content: "" }]
          : hello.messages;
      await new HttpProvider({ endpoint: "https://gw.example.test", transport: r.transport }).complete({
        messages,
        ...(maxTokens !== undefined ? { maxTokens: maxTokens as never } : {}),
      });
      expect(r.calls[0]?.body).toBe(body);
      expect(r.calls.length).toBe(1);
    }
  });

  it("rejects a maxTokens that is not a finite integer, before any transport call", async () => {
    for (const maxTokens of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, 0.1]) {
      const r = recorder();
      const p = new HttpProvider({ endpoint: "https://gw.example.test", transport: r.transport });
      await expect(p.complete({ ...hello, maxTokens }), String(maxTokens)).rejects.toBeInstanceOf(TypeError);
      expect(r.calls.length).toBe(0);
    }
  });

  it("throws a body that cannot be built to the caller, never as unavailable, with no transport call", async () => {
    const r = recorder();
    const p = new HttpProvider({ endpoint: "https://gw.example.test", transport: r.transport });
    const bad = {
      messages: [
        {
          role: "user" as const,
          get content(): string {
            throw new SyntaxError("boom");
          },
        },
      ],
    };
    const e = await p.complete(bad).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(SyntaxError);
    expect(e).not.toBeInstanceOf(ProviderError);
    expect(r.calls.length).toBe(0);
  });

  it("does not mutate the request and always passes a headers map and a string body", async () => {
    const r = recorder();
    const req = { messages: [{ role: "user" as const, content: "x" }], maxTokens: 5 };
    const copy = structuredClone(req);
    await new HttpProvider({ endpoint: "https://gw.example.test", transport: r.transport, timeoutMs: 7 }).complete(req);
    expect(req).toEqual(copy);
    expect(typeof r.calls[0]?.body).toBe("string");
    expect(r.calls[0]?.headers).toBeTypeOf("object");
    expect(r.calls[0]?.timeoutMs).toBe(7);
  });
});

describe("HttpProvider transport failures", () => {
  const make = (transport: HttpTransport) => new HttpProvider({ endpoint: "https://gw.example.test", transport });

  it("maps only TransportTimeoutError to timeout", async () => {
    const e = await errorOf(make(() => Promise.reject(new TransportTimeoutError())).complete(hello));
    expect(e.kind).toBe("timeout");
    expect(e.retryAfterMs).toBeUndefined();
  });
  it("maps any other rejection to unavailable, even one that mentions a timeout", async () => {
    for (const reason of [new Error("connect timeout"), new TypeError("fetch failed"), "boom", undefined]) {
      const e = await errorOf(make(() => Promise.reject(reason)).complete(hello));
      expect(e.kind).toBe("unavailable");
    }
  });
  it("maps a synchronous throw of the transport", async () => {
    const e = await errorOf(
      make(() => {
        throw new Error("sync");
      }).complete(hello),
    );
    expect(e.kind).toBe("unavailable");
  });
  it("makes exactly one transport call and does not retry", async () => {
    const r = recorder({ status: 503, body: "" });
    await errorOf(make(r.transport).complete(hello));
    expect(r.calls.length).toBe(1);
  });
});

describe("HttpProvider responses", () => {
  const run = (res: Partial<HttpResponse>) => new HttpProvider({ endpoint: "https://gw.example.test", transport: recorder(res).transport }).complete(hello);

  it("reads a text and the provider", async () => {
    expect(await run({ body: '{"text":"Hi","provider":"other"}' })).toEqual({ text: "Hi", provider: "other" });
    expect(await run({ body: '{"text":"Hi","provider":"  "}' })).toEqual({ text: "Hi", provider: "gateway" });
    expect(await run({ body: '{"text":""}' })).toEqual({ text: "", provider: "gateway" });
  });
  it("tolerates a transport that hands over no headers", async () => {
    const t: HttpTransport = async () =>
      ({ status: 429, body: '{"error":{"kind":"rate_limit"}}' }) as unknown as HttpResponse;
    const e = await errorOf(new HttpProvider({ endpoint: "https://gw.example.test", transport: t }).complete(hello));
    expect(e.kind).toBe("rate_limit");
    expect(e.retryAfterMs).toBeUndefined();
  });
  it("reads retryAfterMs by exact decimal value and caps it", async () => {
    const cases: [string, number | undefined][] = [
      ["1500", 1500],
      ["1500.0", 1500],
      ["1.5e3", 1500],
      ["1E3", 1000],
      ["25.6e1", 256],
      ["-0", 0],
      ["0.5e1", 5],
      ["3600000", 3_600_000],
      ["3600001", 3_600_000],
      ["1e400", 3_600_000],
      ["4294967297", 3_600_000],
      ["12345678901234567890123", 3_600_000],
      ["1500.0000000000000001", undefined],
      ["1e-400", undefined],
      ["5e-1", undefined],
      ["-1", undefined],
    ];
    for (const [literal, want] of cases) {
      const e = await errorOf(
        run({ status: 429, body: `{"error":{"kind":"rate_limit","retryAfterMs":${literal}}}`, headers: {} }),
      );
      expect(e.retryAfterMs, literal).toBe(want);
    }
  });
  it("falls back to the retry-after header only for non-numeric or unusable body values", async () => {
    const withHeader = (body: string, value: string, name = "Retry-After") =>
      errorOf(run({ status: 429, body, headers: { [name]: value } }));
    expect((await withHeader('{"error":{"kind":"rate_limit"}}', "3")).retryAfterMs).toBe(3000);
    expect((await withHeader('{"error":{"kind":"rate_limit","retryAfterMs":1e-400}}', "0003")).retryAfterMs).toBe(3000);
    expect((await withHeader('{"error":{"kind":"rate_limit","retryAfterMs":null}}', "2")).retryAfterMs).toBe(2000);
    expect((await withHeader('{"error":{"kind":"rate_limit","retryAfterMs":0}}', "2")).retryAfterMs).toBe(0);
    expect((await withHeader('{"error":{"kind":"rate_limit"}}', "9223372036854776")).retryAfterMs).toBe(3_600_000);
    expect((await withHeader('{"error":{"kind":"rate_limit"}}', "3601")).retryAfterMs).toBe(3_600_000);
    expect((await withHeader('{"error":{"kind":"rate_limit"}}', "3600")).retryAfterMs).toBe(3_600_000);
    expect((await withHeader('{"error":{"kind":"rate_limit"}}', "0".repeat(30))).retryAfterMs).toBe(0);
    for (const bad of ["", " 3", "3 ", "+3", "-3", "3.0", "3e0", "\u0663", "\uff13", "3,4", "Wed, 21 Oct 2026 07:28:00 GMT", "3\n"]) {
      expect((await withHeader('{"error":{"kind":"rate_limit"}}', bad)).retryAfterMs, JSON.stringify(bad)).toBeUndefined();
    }
    // The header name is case-insensitive and the last of two same-name headers wins.
    expect((await withHeader('{"error":{"kind":"rate_limit"}}', "5", "RETRY-AFTER")).retryAfterMs).toBe(5000);
    const dup = await errorOf(
      run({ status: 429, body: '{"error":{"kind":"rate_limit"}}', headers: { "retry-after": "4", "Retry-After": "3" } }),
    );
    expect(dup.retryAfterMs).toBe(3000);
    // Ignored for any other kind.
    expect((await withHeader('{"error":{"kind":"unavailable","retryAfterMs":7}}', "3")).retryAfterMs).toBeUndefined();
  });
});

describe("parseStrictJson", () => {
  const ok = (s: string): JsonValue => {
    const v = parseStrictJson(s);
    expect(v, s).not.toBeUndefined();
    return v as JsonValue;
  };
  const bad = (s: string): void => {
    expect(parseStrictJson(s), JSON.stringify(s)).toBeUndefined();
  };

  it("accepts the four JSON whitespace characters around a value", () => {
    expect(ok(" \t\r\n{\"a\":1} \t\r\n")).toBeInstanceOf(Map);
  });
  it("accepts every scalar and container", () => {
    expect(ok("null")).toBeNull();
    expect(ok("true")).toBe(true);
    expect(ok("false")).toBe(false);
    expect(ok('"x"')).toBe("x");
    expect(ok("[]")).toEqual([]);
    expect(ok("{}")).toBeInstanceOf(Map);
    expect((ok("-12.5e+3") as JsonNumber).literal).toBe("-12.5e+3");
    expect(ok('[1,[2,{"a":[]}]]')).toHaveLength(2);
  });
  it("rejects anything but the four whitespace characters", () => {
    for (const ws of ["\u00a0", "\f", "\v", "\u3000", "\ufeff", "\u2028"]) {
      bad(`${ws}{}`);
      bad(`{}${ws}`);
      bad(`{${ws}}`);
    }
  });
  it("rejects non-JSON syntax", () => {
    for (const s of [
      "",
      " ",
      "{",
      "[",
      '{"a":1,}',
      "[1,]",
      "[,1]",
      "{,}",
      "{'a':1}",
      "{a:1}",
      '{"a" 1}',
      '{"a":}',
      '{"a":1 "b":2}',
      "[1 2]",
      "{} {}",
      "{}x",
      "// c\n{}",
      "{/* c */}",
      "NaN",
      "Infinity",
      "-Infinity",
      "undefined",
      "tru",
      "True",
      "nul",
      "0x10",
      "01",
      "-01",
      "+1",
      ".5",
      "1.",
      "1e",
      "1e+",
      "-",
      "--1",
      "1.5.2",
      '"abc',
      '"a\nb"',
      '"a\u0000b"',
      '"\\x41"',
      '"\\u12"',
      '"\\u12G4"',
      '"\\',
      '{"a":1}}',
      "]",
      "}",
    ]) {
      bad(s);
    }
  });
  it("decodes escapes, surrogate pairs and lone surrogates", () => {
    expect(ok('"\\"\\\\\\/\\b\\f\\n\\r\\t"')).toBe('"\\/\b\f\n\r\t');
    expect(ok('"\\u0041\\u00E9"')).toBe("A\u00e9");
    expect(ok('"\\ud83d\\ude00"')).toBe("\u{1F600}");
    expect(ok('"\\ud83d"')).toBe("\ud83d");
    expect(ok('"\u{1F600} \u20ac \u007f"')).toBe("\u{1F600} \u20ac \u007f");
  });
  it("keeps the last duplicate key and treats __proto__ as a plain key", () => {
    const o = ok('{"a":1,"a":2,"__proto__":3,"a":{"b":true}}') as Map<string, JsonValue>;
    expect(o.get("a")).toBeInstanceOf(Map);
    expect(o.get("__proto__")).toBeInstanceOf(JsonNumber);
    expect(o.size).toBe(2);
    expect(({} as Record<string, unknown>)["a"]).toBeUndefined();
  });
  it("keeps number literals as text and never as doubles", () => {
    const o = ok('[1500.0000000000000001,1e400,-0,123456789012345678901234567890]') as JsonNumber[];
    expect(o.map((n) => n.literal)).toEqual(["1500.0000000000000001", "1e400", "-0", "123456789012345678901234567890"]);
  });
  it("handles deep nesting without overflowing the stack", () => {
    const depth = 200_000;
    expect(parseStrictJson("[".repeat(depth) + "]".repeat(depth))).toBeDefined();
    expect(parseStrictJson("[".repeat(depth) + "]".repeat(depth - 1))).toBeUndefined();
  });
  it("agrees with JSON.parse on generated valid documents", () => {
    const docs = [
      { a: [1, 2.5, -3e10, "x\u{1F600}\n", null, true, false, {}], b: { c: [] } },
      [[], [[]], { "": "" }],
      "plain",
      12,
    ];
    const toPlain = (v: JsonValue): unknown =>
      v instanceof Map
        ? Object.fromEntries([...v].map(([k, x]) => [k, toPlain(x)]))
        : Array.isArray(v)
          ? v.map(toPlain)
          : v instanceof JsonNumber
            ? Number(v.literal)
            : v;
    for (const d of docs) {
      expect(toPlain(ok(JSON.stringify(d)))).toEqual(d);
      expect(toPlain(ok(JSON.stringify(d, null, 2)))).toEqual(d);
    }
  });
});

describe("readCappedNonNegativeInteger", () => {
  it("runs in linear time on adversarial digit runs", () => {
    const n = 200_000;
    const zeros = "0".repeat(n);
    const num = (literal: string) => new JsonNumber(literal);
    const started = performance.now();
    // One, N zeros, then a one: the shape that made `/0+$/` backtrack from every zero.
    expect(readCappedNonNegativeInteger(num(`1${zeros}1`), 3_600_000)).toBe(3_600_000);
    expect(readCappedNonNegativeInteger(num(`1.${zeros}1`), 3_600_000)).toBeUndefined();
    expect(readCappedNonNegativeInteger(num(`1${zeros}`), 3_600_000)).toBe(3_600_000);
    expect(readCappedNonNegativeInteger(num(`0.${zeros}1`), 3_600_000)).toBeUndefined();
    expect(readCappedNonNegativeInteger(num(`0.${zeros}`), 3_600_000)).toBe(0);
    expect(readCappedNonNegativeInteger(num(`1.5${zeros}e1`), 3_600_000)).toBe(15);
    expect(performance.now() - started).toBeLessThan(1000);
  });
  const read = (literal: string, cap = 3_600_000): number | undefined => readCappedNonNegativeInteger(new JsonNumber(literal), cap);

  it("reads integers written in any notation", () => {
    expect(read("0")).toBe(0);
    expect(read("-0")).toBe(0);
    expect(read("-0.0e5")).toBe(0);
    expect(read("1500")).toBe(1500);
    expect(read("1500.0")).toBe(1500);
    expect(read("1500.000000000000000000000")).toBe(1500);
    expect(read("1.5e3")).toBe(1500);
    expect(read("1E3")).toBe(1000);
    expect(read("25.6e1")).toBe(256);
    expect(read("0.001e3")).toBe(1);
    expect(read("100e-2")).toBe(1);
    expect(read("10000000e-3")).toBe(10000);
    expect(read("0e999999999999")).toBe(0);
  });
  it("rejects fractions and negatives, with no float intermediate", () => {
    expect(read("1500.5")).toBeUndefined();
    expect(read("1500.0000000000000001")).toBeUndefined(); // a double reads 1500
    expect(read("256.00000000000000000001")).toBeUndefined();
    expect(read("1e-400")).toBeUndefined();
    expect(read("5e-1")).toBeUndefined();
    expect(read("-1")).toBeUndefined();
    expect(read("-1e400")).toBeUndefined();
    expect(read("1e-99999999999999999999")).toBeUndefined();
  });
  it("caps after the exact computation, with no overflow", () => {
    expect(read("3599999")).toBe(3_599_999);
    expect(read("3600000")).toBe(3_600_000);
    expect(read("3600001")).toBe(3_600_000);
    expect(read("4294967297")).toBe(3_600_000);
    expect(read("18446744073709551617")).toBe(3_600_000);
    expect(read("9223372036854775808")).toBe(3_600_000);
    expect(read("1e400")).toBe(3_600_000);
    expect(read("1e99999999999999999999")).toBe(3_600_000);
    expect(read("1".repeat(100_000))).toBe(3_600_000);
    expect(read(`0.${"0".repeat(5000)}1e5001`)).toBe(1);
  });
});

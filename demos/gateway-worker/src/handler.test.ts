import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRequest, judgeHandlerRun, loadRaw, runHandlerFixture, validateFixture, type HandlerFixture } from "./contract-harness.js";
import { handle, type Deps, type Env } from "./handler.js";
import { createLimiter } from "./limiter.js";

const ENV: Env = {
  GEMINI_API_KEY: "FIXTURE_SERVER_KEY",
  GEMINI_MODEL: "fixture-model-1",
  ALLOWED_ORIGINS: "https://app.example.test",
};
const URL_OK = "https://gateway.example.test/v1/complete";
const GOOD = JSON.stringify({ messages: [{ role: "user", content: "hello" }] });
const GEMINI_OK = JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }] });

function deps(upstream: (input: string, init: RequestInit) => Promise<Response>): Deps & { calls: number } {
  const state = { calls: 0 };
  const d = {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      state.calls += 1;
      return upstream(String(input), init ?? {});
    }) as typeof fetch,
    now: () => 1_000_000,
    limiter: createLimiter(10, 60_000),
    get calls() {
      return state.calls;
    },
  };
  return d;
}

const okUpstream = () => Promise.resolve(new Response(GEMINI_OK, { status: 200 }));

function post(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request(URL_OK, { method: "POST", body, headers });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handle never throws", () => {
  // A small deterministic generator (mulberry32) so a failure can be replayed.
  function rng(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("answers 2,000 random requests with a well-formed response", async () => {
    const random = rng(20261128);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const methods = ["POST", "OPTIONS", "GET", "HEAD", "PUT", "DELETE", "PATCH"];
    const paths = ["/v1/complete", "/v1/complete", "/v1/complete", "/", "/v1/complete/", "/v1/complete?x=1", "//v1/complete", "/%00", "/v1/%63omplete"];
    const origins = [null, "", "null", "*", "https://app.example.test", "https://evil.example.test", "https://app.example.test/", "HTTPS://APP.EXAMPLE.TEST"];
    const ips = [null, "", "203.0.113.7", "2001:DB8::1", "unknown"];
    const keys = [null, "", "FIXTURE_USER_KEY", " x ", "k".repeat(300)];
    const validJson = [
      GOOD,
      `{"messages":[{"role":"system","content":"s"},{"role":"user","content":"u"}],"maxTokens":${pick([1, 1024, 0, 1025, 1.5])}}`,
      '{"messages":[{"role":"user","content":"€"}],"maxTokens":1e2}',
      '{"messages":[]}',
      "[]",
      "null",
      '{"messages":"x"}',
      "[".repeat(3000),
      "{".repeat(3000),
      "﻿" + GOOD,
      GOOD + "x",
      "",
      "{",
    ];
    const upstreamBodies = [GEMINI_OK, "", "not json", "[]", '{"candidates":[]}', '{"candidates":[{"finishReason":"SAFETY"}]}', "﻿{}"];

    for (let i = 0; i < 2_000; i++) {
      const headers: Record<string, string> = {};
      const origin = pick(origins);
      if (origin !== null) headers.origin = origin;
      const ip = pick(ips);
      if (ip !== null) headers["cf-connecting-ip"] = ip;
      const key = pick(keys);
      if (key !== null) headers["x-ilabs-api-key"] = key;

      let body: BodyInit | null;
      const kind = random();
      if (kind < 0.3) {
        body = pick(validJson);
      } else if (kind < 0.55) {
        const bytes = new Uint8Array(Math.floor(random() * 200));
        for (let b = 0; b < bytes.length; b++) bytes[b] = Math.floor(random() * 256);
        body = bytes;
      } else if (kind < 0.65) {
        body = "x".repeat(65_000 + Math.floor(random() * 1_000));
      } else {
        body = null;
      }
      const method = pick(methods);
      const request = new Request(`https://gateway.example.test${pick(paths)}`, {
        method,
        headers,
        ...(body !== null && method !== "GET" && method !== "HEAD" ? { body } : {}),
      });

      const upstreamKind = Math.floor(random() * 6);
      const d = deps(() => {
        switch (upstreamKind) {
          case 0:
            return Promise.reject(new TypeError("fetch failed"));
          case 1:
            return Promise.reject(new DOMException("t", "TimeoutError"));
          case 2:
            return Promise.reject(null);
          case 3:
            return Promise.resolve(new Response(pick(upstreamBodies), { status: pick([200, 429, 500, 503, 401]) }));
          case 4:
            return Promise.resolve(undefined as unknown as Response);
          default:
            return okUpstream();
        }
      });

      const response = await handle(request, ENV, d);
      expect(response).toBeInstanceOf(Response);
      expect([200, 204, 400, 403, 404, 405, 429, 502, 503, 504]).toContain(response.status);
      const text = await response.text();
      expect(response.headers.get("vary")).toBe("Origin");
      if (response.status === 204) {
        expect(text).toBe("");
      } else {
        const parsed = JSON.parse(text) as { error?: { kind: string }; text?: string };
        if (response.status === 200) expect(typeof parsed.text).toBe("string");
        else expect(["rate_limit", "timeout", "invalid_output", "unavailable"]).toContain(parsed.error?.kind);
      }
      expect(d.calls).toBeLessThanOrEqual(1);
    }
  });

  it("answers 503 when its own dependencies misbehave", async () => {
    const throwingLimiter = { check: () => { throw new Error("boom FIXTURE_USER_KEY"); } };
    const r1 = await handle(post(GOOD), ENV, { ...deps(okUpstream), limiter: throwingLimiter });
    expect(r1.status).toBe(503);
    expect(await r1.json()).toEqual({ error: { kind: "unavailable" } });

    const throwingNow = { ...deps(okUpstream), now: () => { throw new Error("clock"); } };
    expect((await handle(post(GOOD), ENV, throwingNow)).status).toBe(503);

    const syncThrow = { ...deps(okUpstream), fetch: (() => { throw new TypeError("sync"); }) as unknown as typeof fetch };
    expect((await handle(post(GOOD), ENV, syncThrow)).status).toBe(503);
  });

  it("copes with a broken environment", async () => {
    for (const env of [
      {} as Env,
      { GEMINI_API_KEY: "FIXTURE_SERVER_KEY" } as Env,
      { GEMINI_MODEL: "m" } as Env,
      { GEMINI_API_KEY: 5, GEMINI_MODEL: 7, ALLOWED_ORIGINS: 9 } as unknown as Env,
      undefined as unknown as Env,
      null as unknown as Env,
    ]) {
      const response = await handle(post(GOOD), env, deps(okUpstream));
      expect([200, 503]).toContain(response.status);
    }
    // No model is a deployment error: 503, no upstream call.
    const d = deps(okUpstream);
    expect((await handle(post(GOOD), { GEMINI_API_KEY: "k", ALLOWED_ORIGINS: "" } as Env, d)).status).toBe(503);
    expect(d.calls).toBe(0);
  });

  it("answers 400 when the request body stream fails", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("client went away"));
      },
    });
    const request = new Request(URL_OK, { method: "POST", body: stream, duplex: "half" } as RequestInit);
    const response = await handle(request, ENV, deps(okUpstream));
    expect(response.status).toBe(400);
  });

  it("answers 503 for something that is not a Request", async () => {
    const response = await handle({} as Request, ENV, deps(okUpstream));
    expect(response.status).toBe(503);
  });
});

describe("request body", () => {
  it("answers 400 for a body that is not valid UTF-8", async () => {
    for (const bytes of [[0xff], [0xc3], [0xe2, 0x82], [0x7b, 0x80, 0x7d], [0xc0, 0xaf], [0xed, 0xa0, 0x80]]) {
      const d = deps(okUpstream);
      const response = await handle(post(new Uint8Array(bytes)), ENV, d);
      expect(response.status, bytes.join(",")).toBe(400);
      expect(d.calls).toBe(0);
    }
  });

  it("answers 400 for invalid UTF-8 inside a JSON string (the body is otherwise valid JSON)", async () => {
    const enc = new TextEncoder();
    const wrap = (...inner: number[]) =>
      new Uint8Array([
        ...enc.encode('{"messages":[{"role":"user","content":"a'),
        ...inner,
        ...enc.encode('b"}]}'),
      ]);
    const bodies = [
      wrap(0xff), // never valid
      wrap(0xc3), // truncated two-byte sequence, followed by an ASCII byte
      wrap(0xe2, 0x82), // truncated three-byte sequence
      wrap(0xc0, 0xaf), // overlong encoding
      wrap(0xed, 0xa0, 0x80), // encoded surrogate
    ];
    for (const [index, bytes] of bodies.entries()) {
      const d = deps(okUpstream);
      const response = await handle(post(bytes), ENV, d);
      expect(response.status, `body ${index}`).toBe(400);
      expect(d.calls).toBe(0);
    }
    // control: the same shape with valid UTF-8 is accepted
    expect((await handle(post(wrap(0xc3, 0xa9)), ENV, deps(okUpstream))).status).toBe(200);
  });

  it("answers 400 with a UTF-8 byte order mark before the JSON", async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(GOOD)]);
    expect((await handle(post(bom), ENV, deps(okUpstream))).status).toBe(400);
  });

  it("does not consult Content-Length", async () => {
    for (const length of ["0", "5", "999999999", "-1", "abc"]) {
      const response = await handle(post(GOOD, { "content-length": length }), ENV, deps(okUpstream));
      expect(response.status, length).toBe(200);
    }
    const tooBig = "x".repeat(70_000);
    const response = await handle(post(tooBig, { "content-length": "3" }), ENV, deps(okUpstream));
    expect(response.status).toBe(400);
  });

  it("stops reading a body that is over the limit", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024));
        if (pulled > 100_000) controller.close();
      },
    });
    const request = new Request(URL_OK, { method: "POST", body: stream, duplex: "half" } as RequestInit);
    const d = deps(okUpstream);
    const response = await handle(request, ENV, d);
    expect(response.status).toBe(400);
    expect(d.calls).toBe(0);
    expect(pulled).toBeLessThan(200); // 64 KiB is 64 chunks; the other ~100,000 were never requested
  });
});

describe("the upstream call", () => {
  it("passes an AbortSignal.timeout(20,000) through deps.fetch, once", async () => {
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    let seen: AbortSignal | null | undefined;
    const d = deps((_url, init) => {
      seen = init.signal;
      return okUpstream();
    });
    const response = await handle(post(GOOD), ENV, d);
    expect(response.status).toBe(200);
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(20_000);
    expect(seen).toBe(signal);
    expect(d.calls).toBe(1);
  });

  it("answers 504 when that signal fires (TimeoutError) and when the fetch is aborted (AbortError)", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const hanging = deps(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          // like the real fetch: reject as soon as the signal is (or already was) aborted
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    const pending = handle(post(GOOD), ENV, hanging);
    await new Promise((resolve) => setTimeout(resolve, 20)); // the handler is now waiting on the upstream
    controller.abort(new DOMException("The operation timed out", "TimeoutError"));
    const timedOut = await pending;
    expect(timedOut.status).toBe(504);
    expect(await timedOut.json()).toEqual({ error: { kind: "timeout" } });

    const aborted = await handle(post(GOOD), ENV, deps(() => Promise.reject(new DOMException("aborted", "AbortError"))));
    expect(aborted.status).toBe(504);
  });

  it("answers 504 when the timeout hits while the body is still streaming", async () => {
    const d = deps(() => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new DOMException("The operation timed out", "TimeoutError"));
        },
      });
      return Promise.resolve(new Response(stream, { status: 200 }));
    });
    expect((await handle(post(GOOD), ENV, d)).status).toBe(504);
  });

  it("reads timeouts from the error name only: other errors are network failures", async () => {
    const failures: unknown[] = [
      new TypeError("fetch failed: connect timeout"),
      new Error("timeout"),
      new Error("The operation was aborted due to timeout"),
      "TimeoutError",
      { message: "TimeoutError" },
      null,
      undefined,
      42,
    ];
    for (const failure of failures) {
      const response = await handle(post(GOOD), ENV, deps(() => Promise.reject(failure)));
      expect(response.status, String(failure)).toBe(503);
    }
    for (const name of ["TimeoutError", "AbortError"]) {
      const named = Object.assign(new Error("x"), { name });
      expect((await handle(post(GOOD), ENV, deps(() => Promise.reject(named)))).status).toBe(504);
    }
  });

  it("sends the key only in x-goog-api-key and never in the URL or the body", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const d = deps((url, init) => {
      seen = { url, init };
      return okUpstream();
    });
    await handle(post(GOOD, { "x-ilabs-api-key": "FIXTURE_USER_KEY" }), ENV, d);
    expect(seen?.url).not.toContain("FIXTURE_USER_KEY");
    expect(String(seen?.init.body)).not.toContain("FIXTURE_USER_KEY");
    expect(new Headers(seen?.init.headers).get("x-goog-api-key")).toBe("FIXTURE_USER_KEY");
    expect(new Headers(seen?.init.headers).has("x-ilabs-api-key")).toBe(false);
    expect(seen?.init.redirect).toBe("manual");
  });
});

describe("the keys never leak", () => {
  const consoleMethods = ["log", "info", "warn", "error", "debug", "trace"] as const;

  it("writes no log line and leaks no key across the whole fixture run", async () => {
    const spies = consoleMethods.map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const fixtures = loadRaw()
      .map(({ raw }) => validateFixture(raw))
      .filter((f): f is HandlerFixture => f.kind === "handler");
    let withKey = 0;
    for (const fx of fixtures) {
      // Every fixture is run through the harness, which fails on a key in any response body or
      // header (fixtures with a user key include upstream errors that echo it).
      const run = await runHandlerFixture(fx);
      expect(judgeHandlerRun(fx, run), fx.name).toEqual([]);
      if (new Headers(fx.request.headers).has("x-ilabs-api-key")) withKey += 1;
    }
    expect(withKey).toBeGreaterThan(5);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("does not echo a user key through any status the Worker can produce", async () => {
    const key = "FIXTURE_USER_KEY";
    const hostile = (status: number) => () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: `bad key ${key}` }, echo: key }), {
          status,
          headers: { "x-echo": key, "retry-after": "5", "x-goog-api-key": key },
        }),
      );
    const cases: { status: number; make: () => Request; upstream: () => Promise<Response> }[] = [
      { status: 200, make: () => post(GOOD, { "x-ilabs-api-key": key }), upstream: okUpstream },
      { status: 400, make: () => post("{", { "x-ilabs-api-key": key }), upstream: okUpstream },
      { status: 403, make: () => post(GOOD, { "x-ilabs-api-key": key, origin: `https://evil.test/${key}` }), upstream: okUpstream },
      { status: 404, make: () => new Request(`https://gateway.example.test/${key}`, { method: "POST", headers: { "x-ilabs-api-key": key } }), upstream: okUpstream },
      { status: 405, make: () => new Request(`${URL_OK}?k=${key}`, { method: "GET", headers: { "x-ilabs-api-key": key } }), upstream: okUpstream },
      { status: 503, make: () => post(GOOD, { "x-ilabs-api-key": key }), upstream: hostile(401) },
      { status: 503, make: () => post(GOOD, { "x-ilabs-api-key": key }), upstream: hostile(500) },
      { status: 429, make: () => post(GOOD, { "x-ilabs-api-key": key }), upstream: hostile(429) },
      { status: 502, make: () => post(GOOD, { "x-ilabs-api-key": key }), upstream: hostile(200) },
      { status: 504, make: () => post(GOOD, { "x-ilabs-api-key": key }), upstream: () => Promise.reject(new DOMException(key, "TimeoutError")) },
      { status: 503, make: () => post(GOOD, { "x-ilabs-api-key": key }), upstream: () => Promise.reject(new TypeError(key)) },
    ];
    for (const c of cases) {
      const response = await handle(c.make(), ENV, deps(c.upstream));
      expect(response.status).toBe(c.status);
      const everything = JSON.stringify([...response.headers]) + (await response.text());
      expect(everything).not.toContain(key);
      expect(everything).not.toContain("FIXTURE_SERVER_KEY");
    }
  });
});

describe("rate-limit slots in volume", () => {
  it("counts only requests that reach the limiter", async () => {
    const d = deps(okUpstream);
    const ip = { "cf-connecting-ip": "198.51.100.9" };
    const origin = { origin: "https://app.example.test" };
    for (let i = 0; i < 10; i++) {
      expect((await handle(new Request(URL_OK, { method: "OPTIONS", headers: { ...ip, ...origin } }), ENV, d)).status).toBe(204);
      expect((await handle(new Request("https://gateway.example.test/nope", { method: "POST", headers: ip }), ENV, d)).status).toBe(404);
      expect((await handle(new Request(URL_OK, { method: "GET", headers: ip }), ENV, d)).status).toBe(405);
      expect((await handle(post(GOOD, { ...ip, origin: "https://evil.example.test" }), ENV, d)).status).toBe(403);
      expect((await handle(post("{", ip), ENV, d)).status).toBe(400);
    }
    expect(d.calls).toBe(0);
    for (let i = 0; i < 10; i++) expect((await handle(post(GOOD, ip), ENV, d)).status, `valid ${i + 1}`).toBe(200);
    const eleventh = await handle(post(GOOD, ip), ENV, d);
    expect(eleventh.status).toBe(429);
    expect(eleventh.headers.get("retry-after")).toBe("60");
    expect(d.calls).toBe(10);
  });
});

describe("a plain request", () => {
  it("builds on the harness request builder", async () => {
    const response = await handle(
      buildRequest({ method: "POST", path: "/v1/complete", headers: { origin: "https://app.example.test" }, body: { messages: [{ role: "user", content: "x" }] } }),
      ENV,
      deps(okUpstream),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example.test");
    expect(await response.json()).toEqual({ text: "hi", provider: "gateway" });
  });
});

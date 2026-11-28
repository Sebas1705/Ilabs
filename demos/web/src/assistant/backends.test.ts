import { TransportTimeoutError } from "@ilabs/providers";
import { abortableSleep, buildProvider, checkEndpoint, createMock, effectiveBackend, fetchTransport, mockScript, MAX_BODY_BYTES } from "./backends";
import { Tracer } from "./trace";
import { fakeTransport, instantSleep, noNetwork, ok } from "./testTransport";

describe("checkEndpoint", () => {
  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["https://gw.example.test", "ok"],
    ["  https://gw.example.test/prefix/  ", "ok"],
    ["https://gw.example.test:8443", "ok"],
    ["http://localhost", "ok"],
    ["http://localhost:8787", "ok"],
    ["http://127.0.0.1:8787/", "ok"],
    ["http://10.0.2.2:8787", "ok"],
    ["http://gw.example.test", "invalid"],
    ["http://localhost.evil.test", "invalid"],
    ["http://192.168.1.5:8787", "invalid"],
    ["ftp://gw.example.test", "invalid"],
    ["gw.example.test", "invalid"],
    ["https://", "invalid"],
    ["https://user:pass@gw.example.test", "invalid"],
    ["https://gw.example.test/?a=1", "invalid"],
    ["https://gw.example.test/#x", "invalid"],
    ["https://gw.example.test/a b", "invalid"],
    ["https:\\\\gw.example.test", "invalid"],
    ["javascript:alert(1)", "invalid"],
    ["HTTPS://gw.example.test", "ok"],
    ["Https://gw.example.test/prefix", "ok"],
    ["HTTP://localhost:8787", "ok"],
    ["HtTp://127.0.0.1:8787", "ok"],
    ["HTTP://gw.example.test", "invalid"],
    ["HTTP://localhost.evil.test", "invalid"],
    ["FTP://gw.example.test", "invalid"],
    ["HTTPS://user:pass@gw.example.test", "invalid"],
    // The shared accept/reject table (the Android twin has the same one).
    ["http://localhost:99999", "invalid"],
    ["http://localhost:0", "invalid"],
    ["http://localhost:", "invalid"],
    ["http://127.1", "invalid"],
    ["https://127.1", "invalid"],
    ["https://256.1.1.1", "invalid"],
    ["https://1.2.3.4", "ok"],
    ["https://exa_mple.com", "invalid"],
    ["HTTPS://Example.com", "ok"],
    ["https://a.b:443/", "ok"],
    ["https://a.b:65535", "ok"],
    ["https://a.b:65536", "invalid"],
    ["https://a.b///", "ok"],
    ["https://u@h", "invalid"],
    ["https://h?x=1", "invalid"],
    ["https://h#f", "invalid"],
    ["https://[::1]:8443", "ok"],
    ["http://[::1]:8787", "invalid"],
    ["https://[zz]", "invalid"],
    ["https://-a.com", "invalid"],
    ["https://a..com", "invalid"],
  ])("%j is %s", (value, expected) => {
    expect(checkEndpoint(value)).toBe(expected);
  });
});

describe("effectiveBackend", () => {
  it("keeps the mock and falls back to it for the gateway backends while the endpoint is not valid", () => {
    expect(effectiveBackend("mock", false)).toBe("mock");
    expect(effectiveBackend("mock", true)).toBe("mock");
    expect(effectiveBackend("worker", false)).toBe("mock");
    expect(effectiveBackend("key", false)).toBe("mock");
    expect(effectiveBackend("worker", true)).toBe("worker");
    expect(effectiveBackend("key", true)).toBe("key");
  });
});

describe("mockScript", () => {
  it("scripts a rate_limit with retryAfterMs 1500 as the third call and replies everywhere else", () => {
    for (const lang of ["en", "es"] as const) {
      const script = mockScript(lang);
      expect(script[2]).toEqual({ error: { kind: "rate_limit", retryAfterMs: 1500 } });
      expect(script.filter((e) => e.error !== undefined)).toHaveLength(1);
      expect(script.length).toBeGreaterThan(100);
    }
  });

  it("has different replies per language and they are short", () => {
    const en = mockScript("en").flatMap((e) => (e.response === undefined ? [] : [e.response]));
    const es = mockScript("es").flatMap((e) => (e.response === undefined ? [] : [e.response]));
    expect(new Set(en).size).toBeGreaterThanOrEqual(4);
    expect(en.some((r) => es.includes(r))).toBe(false);
    for (const r of [...en, ...es]) expect(r.length).toBeLessThan(250);
  });
});

describe("buildProvider", () => {
  it("uses no transport for the mock backend", async () => {
    const tracer = new Tracer();
    const p = buildProvider("mock", { endpoint: "", transport: noNetwork, sleep: instantSleep().sleep, tracer, mock: createMock("en") });
    expect((await p.complete({ messages: [{ role: "user", content: "hi" }] })).provider).toBe("mock");
  });

  it("sends the key only for the key backend", async () => {
    for (const [backend, expected] of [["worker", undefined], ["key", "K-123"]] as const) {
      const fake = fakeTransport([ok("x")]);
      const p = buildProvider(backend, { endpoint: "https://gw.example.test/", apiKey: "K-123", transport: fake.transport, sleep: instantSleep().sleep, tracer: new Tracer(), mock: createMock("en") });
      await p.complete({ messages: [{ role: "user", content: "hi" }] });
      expect(fake.requests[0]!.headers["x-ilabs-api-key"]).toBe(expected);
      expect(fake.requests[0]!.url).toBe("https://gw.example.test/v1/complete");
    }
  });
});

function response(init: { status?: number; body?: string; headers?: Record<string, string> } = {}): Response {
  return new Response(init.body ?? "", { status: init.status ?? 200, headers: init.headers });
}

describe("fetchTransport", () => {
  const req = { url: "https://gw.example.test/v1/complete", method: "POST" as const, headers: { "content-type": "application/json", "x-ilabs-api-key": "K" }, body: "{}", timeoutMs: 5000 };

  it("calls fetch with no credentials, no redirect following, no cache and the abort signal", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const t = fetchTransport(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return response({ status: 429, body: "{}", headers: { "Retry-After": "7", "content-type": "application/json" } });
    });
    const res = await t(req);
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("7");
    expect(res.body).toBe("{}");
    const { init, url } = calls[0]!;
    expect(url).toBe(req.url);
    expect(init).toMatchObject({ method: "POST", body: "{}", credentials: "omit", redirect: "manual", cache: "no-store", referrerPolicy: "no-referrer", headers: req.headers });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps the timeout to TransportTimeoutError", async () => {
    const t = fetchTransport(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    await expect(t({ ...req, timeoutMs: 20 })).rejects.toBeInstanceOf(TransportTimeoutError);
  });

  it("maps other failures to a plain error without the original message", async () => {
    const t = fetchTransport(async () => {
      throw new TypeError("secret detail K-123");
    });
    const error = await t(req).catch((e: unknown) => e as Error);
    expect(error).not.toBeInstanceOf(TransportTimeoutError);
    expect(String(error)).not.toContain("K-123");
    expect(String(error)).not.toContain("secret detail");
  });

  it("reports an opaque redirect (no body) as a non-200 status", async () => {
    const redirect = fetchTransport(async () => ({ status: 0, headers: new Headers(), body: null }) as unknown as Response);
    expect(await redirect(req)).toEqual({ status: 0, headers: {}, body: "" });
  });

  it("accepts a reply of exactly the cap and rejects one byte more", async () => {
    const exact = fetchTransport(async () => response({ body: "x".repeat(MAX_BODY_BYTES) }));
    expect((await exact(req)).body).toHaveLength(MAX_BODY_BYTES);
    const over = fetchTransport(async () => response({ body: "x".repeat(MAX_BODY_BYTES + 1) }));
    await expect(over(req)).rejects.toThrow();
  });

  it("counts bytes, not characters: a multi-byte body under the character cap is still too large", async () => {
    const body = "é".repeat(MAX_BODY_BYTES / 2 + 1); // 2 bytes each, fewer characters than the cap
    expect(body.length).toBeLessThan(MAX_BODY_BYTES);
    await expect(fetchTransport(async () => response({ body }))(req)).rejects.toThrow();
  });

  it("stops reading an endless stream once it is over the cap and cancels it", async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(256 * 1024).fill(120));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(fetchTransport(async () => new Response(stream))(req)).rejects.toThrow();
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(10);
  });

  it("rejects early on a declared content-length over the cap, without reading the body", async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(256 * 1024).fill(120));
      },
      cancel() {
        cancelled = true;
      },
    });
    const t = fetchTransport(async () => new Response(stream, { headers: { "content-length": String(MAX_BODY_BYTES + 1) } }));
    await expect(t(req)).rejects.toThrow();
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(2);
  });

  it("keeps a leading BOM in the body (the gateway contract treats it as a failure) and decodes UTF-8", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"text":"ñ"}')]);
    const res = await fetchTransport(async () => new Response(bytes))(req);
    expect(res.body.startsWith("﻿")).toBe(true);
    expect(res.body.slice(1)).toBe('{"text":"ñ"}');
    expect((await fetchTransport(async () => new Response('{"a":1}'))(req)).body).toBe('{"a":1}');
  });

  it("aborts the request in flight when the caller's signal aborts, with a plain error and not a timeout", async () => {
    let seen: AbortSignal | undefined;
    const t = fetchTransport(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          seen = init?.signal ?? undefined;
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const controller = new AbortController();
    const pending = t({ ...req, timeoutMs: 60_000 }, controller.signal).catch((e: unknown) => e as Error);
    await Promise.resolve();
    expect(seen?.aborted).toBe(false);
    controller.abort();
    const error = await pending;
    expect(seen?.aborted).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TransportTimeoutError);
  });

  it("hands fetch an already aborted signal when the caller's signal is aborted before the call", async () => {
    const controller = new AbortController();
    controller.abort();
    let wasAborted: boolean | undefined;
    const t = fetchTransport(async (_url, init) => {
      wasAborted = init?.signal?.aborted;
      throw new DOMException("aborted", "AbortError");
    });
    const error = await t(req, controller.signal).catch((e: unknown) => e as Error);
    expect(wasAborted).toBe(true);
    expect(error).not.toBeInstanceOf(TransportTimeoutError);
  });
});

describe("abortableSleep", () => {
  it("resolves after the delay and early on abort", async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      void abortableSleep(1000).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
      const controller = new AbortController();
      let early = false;
      void abortableSleep(60_000, controller.signal).then(() => (early = true));
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(early).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

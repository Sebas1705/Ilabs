import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./index.js";
import { parseAllowlist } from "./cors.js";

const ENV = { GEMINI_API_KEY: "FIXTURE_SERVER_KEY", GEMINI_MODEL: "fixture-model-1", ALLOWED_ORIGINS: "" };
const GEMINI_OK = JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }] });

afterEach(() => {
  vi.unstubAllGlobals();
});

function request(ip: string): Request {
  return new Request("https://gateway.example.test/v1/complete", {
    method: "POST",
    headers: { "cf-connecting-ip": ip },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
  });
}

describe("default export", () => {
  it("wires the real fetch, the clock and one limiter per isolate", async () => {
    const upstream = vi.fn(async () => new Response(GEMINI_OK, { status: 200 }));
    vi.stubGlobal("fetch", upstream);
    for (let i = 0; i < 10; i++) {
      const response = await worker.fetch(request("192.0.2.77"), ENV);
      expect(response.status).toBe(200);
    }
    expect((await worker.fetch(request("192.0.2.77"), ENV)).status).toBe(429);
    expect(upstream).toHaveBeenCalledTimes(10);
    const [url, init] = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/fixture-model-1:generateContent");
    expect(init.method).toBe("POST");
    // another IP has its own bucket
    expect((await worker.fetch(request("192.0.2.78"), ENV)).status).toBe(200);
  });
});

describe("parseAllowlist", () => {
  it("keeps the valid entries only", () => {
    const list = parseAllowlist(" https://a.example.test , http://localhost:5173,*,null,https://b.example.test/,HTTPS://C.TEST,,https://d.test:65536,http://[::1]:3000");
    expect([...list].sort()).toEqual(["http://[::1]:3000", "http://localhost:5173", "https://a.example.test"]);
  });

  it("is empty for anything that is not a string", () => {
    for (const value of [undefined, null, 5, {}, []]) expect(parseAllowlist(value).size).toBe(0);
  });
});

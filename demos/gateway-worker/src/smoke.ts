// Local smoke test: `pnpm --filter @ilabs/gateway-worker smoke`.
//
// Serves the handler over a real local HTTP socket (127.0.0.1, an ephemeral port) with a FAKE
// Gemini behind `deps.fetch`, then drives it with a few requests and prints what came back.
// Nothing leaves the machine and no key is involved: the "keys" below are obvious markers.
// It exercises the handler in Node, not the Workers runtime (see README.md for `wrangler dev`).

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { handle, type Env } from "./handler.js";
import { createLimiter } from "./limiter.js";

const env: Env = {
  GEMINI_API_KEY: "SMOKE_SERVER_KEY",
  GEMINI_MODEL: "smoke-model",
  ALLOWED_ORIGINS: "http://localhost:5173",
};

const upstreamCalls: { url: string; key: string | null; body: unknown }[] = [];

const fakeGemini = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const body = JSON.parse(String(init?.body)) as { contents: { parts: { text: string }[] }[] };
  upstreamCalls.push({ url: String(input), key: new Headers(init?.headers).get("x-goog-api-key"), body });
  const last = body.contents[body.contents.length - 1]?.parts[0]?.text ?? "";
  const reply = { candidates: [{ content: { role: "model", parts: [{ text: `echo: ${last}` }] }, finishReason: "STOP" }] };
  return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const limiter = createLimiter(10, 60_000);

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(name, value);
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(`http://127.0.0.1${req.url ?? "/"}`, {
      method: req.method ?? "GET",
      headers,
      ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
    });
    void handle(request, env, { fetch: fakeGemini, now: () => Date.now(), limiter }).then(async (response) => {
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
  });
});

type Check = { label: string; init: RequestInit; path?: string; status: number; contains?: string };

const json = { "content-type": "application/json" };
const hello = JSON.stringify({ messages: [{ role: "user", content: "hello" }] });
const checks: Check[] = [
  { label: "valid request, server key", init: { method: "POST", headers: json, body: hello }, status: 200, contains: "echo: hello" },
  { label: "valid request, user key", init: { method: "POST", headers: { ...json, "x-ilabs-api-key": "SMOKE_USER_KEY" }, body: hello }, status: 200 },
  { label: "preflight from an allowed origin", init: { method: "OPTIONS", headers: { origin: "http://localhost:5173" } }, status: 204 },
  { label: "another origin", init: { method: "POST", headers: { ...json, origin: "http://evil.test" }, body: hello }, status: 403 },
  { label: "malformed body", init: { method: "POST", headers: json, body: "{" }, status: 400 },
  { label: "too many tokens", init: { method: "POST", headers: json, body: JSON.stringify({ messages: [{ role: "user", content: "x" }], maxTokens: 5000 }) }, status: 400 },
  { label: "wrong method", init: { method: "GET" }, status: 405 },
  { label: "wrong path", init: { method: "POST", headers: json, body: hello }, path: "/nope", status: 404 },
];

async function main(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let failed = 0;
  for (const check of checks) {
    const response = await fetch(`${base}${check.path ?? "/v1/complete"}`, check.init);
    const text = await response.text();
    const good = response.status === check.status && (check.contains === undefined || text.includes(check.contains));
    if (!good) failed += 1;
    console.log(`${good ? "ok  " : "FAIL"} ${String(response.status)} ${check.label}${text === "" ? "" : `  ${text}`}`);
  }
  const keys = upstreamCalls.map((c) => c.key);
  const keysOk = keys.length === 2 && keys[0] === "SMOKE_SERVER_KEY" && keys[1] === "SMOKE_USER_KEY";
  console.log(`${keysOk ? "ok  " : "FAIL"} the fake Gemini saw ${String(upstreamCalls.length)} calls, keys ${keys.join(", ")}`);
  if (!keysOk) failed += 1;
  server.close();
  if (failed > 0) process.exitCode = 1;
}

void main();

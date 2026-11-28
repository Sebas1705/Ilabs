# gateway-worker

A small Cloudflare Worker that sits between the iLabs demos (the Assistant page on the web and the Assistant screen on Android, through `HttpProvider`) and Gemini, so a browser or an app can talk to a real model without ever holding the key. It validates and caps the request, applies an origin allowlist and a rate limit, makes one call to Gemini and maps every outcome to the error kinds of the [`providers`](../../modules/providers/README.md) module. The protocol and every rule (validation order, status table, limits, Gemini mapping, retry-delay parsing) are pinned by the shared fixtures in [`contracts/gateway`](../../contracts/gateway/README.md): this package passes all of its `handler` and `limiter` fixtures.

```
POST {endpoint}/v1/complete          optional header: x-ilabs-api-key: <your own Gemini key>
{ "messages": [{ "role": "user", "content": "..." }], "maxTokens": 256 }
-> 200 { "text": "...", "provider": "gateway" }
-> 4xx/5xx { "error": { "kind": "rate_limit" | "timeout" | "invalid_output" | "unavailable", "retryAfterMs"?: number } }
```

## What it enforces

| Rule | Value |
|---|---|
| Body | at most 64 KiB, strict JSON, UTF-8 |
| Messages | 1 to 50, roles `system` / `user` / `assistant`, at most 8,000 characters each and 32,000 in total |
| `maxTokens` | integer 1 to 1,024 (default 256), never clamped: out of range is `400` |
| Model | the `GEMINI_MODEL` variable, never from the request |
| Origin | an `Origin` that is not in `ALLOWED_ORIGINS` is `403`; no `Origin` (curl, native apps) is allowed |
| Rate limit | 10 requests per 60 s per `CF-Connecting-IP`, fixed window, in memory |
| Upstream | one call, 20 s timeout, no retry; upstream errors and bodies are never forwarded |
| Key | `x-ilabs-api-key` replaces the server key for that call; neither key is ever logged, echoed or put in a URL |

## Honest limits

- The origin allowlist is a CORS and browser-abuse control, **not authentication**. Anyone can call the Worker from a script with no `Origin` header. That is why the key, the model and every cap are fixed on the server, and why the rate limit exists.
- The rate limit is per address, not per network: the key is the whole `CF-Connecting-IP` string. A client with an IPv6 `/64` (the usual home allocation) can send from 2^64 distinct addresses, each with its own fresh window, so it can get around the per-IP limit and spend the server key. Put a Cloudflare rate-limiting rule (which can group by prefix) in front of the Worker if that matters.
- The rate limiter is a fixed window held in the memory of one isolate. Cloudflare may run several isolates (each with its own counters) and recycles them, so it is best-effort protection, not a quota. Use a Cloudflare rate-limiting rule or binding in front of it if you need a hard limit.
- With "my key" a caller spends their own quota, but the per-IP limit still protects the Worker itself.
- The guardrails (PII redaction, context window) of the demos run in the client and are not enforced here.
- The Worker never retries, so a Gemini `429` reaches the client with `retryAfterMs` when Gemini says how long, and the client's `RetryingProvider` decides what to do.
- `redirect: "manual"` is set on the upstream call, so a redirect from the upstream is an upstream failure (`503`) and the key header is never replayed to another host.

## Layout

| File | Responsibility |
|---|---|
| `src/index.ts` | the Workers entry (`export default { fetch }`): real `fetch`, `Date.now` and one limiter per isolate |
| `src/handler.ts` | `handle(request, env, deps)`: the steps of the contract in order; never throws |
| `src/cors.ts` | allowlist parsing and the CORS/preflight headers |
| `src/limits.ts` | the constants and request validation |
| `src/gemini.ts` | the upstream request, the response mapping and the retry-delay parsing (exact decimal arithmetic) |
| `src/limiter.ts` | the fixed-window limiter with bounded memory |
| `src/json.ts` | strict RFC 8259 reader that keeps number literals, and the exact integer reading |
| `src/contract-harness.ts`, `src/*.test.ts` | the fixture runner and the unit tests (not part of the Worker) |

`handle` takes its collaborators as `deps = { fetch, now, limiter }`, so every test runs offline with a fake upstream and a fake clock.

## Develop

```bash
pnpm install --frozen-lockfile
pnpm --filter @ilabs/gateway-worker test        # all contract fixtures + unit tests, offline
pnpm --filter @ilabs/gateway-worker typecheck
pnpm --filter @ilabs/gateway-worker smoke       # local HTTP server + a FAKE Gemini, no network, no key
```

Tests never need `wrangler`, a network or a secret, so CI stays offline.

## Local smoke with `wrangler dev`

`pnpm ... smoke` (above) is the check of the whole path with a fake upstream. To run the real Workers runtime locally (`workerd`) use a pinned Wrangler without adding it to the repo:

```bash
cd demos/gateway-worker
pnpm dlx wrangler@4.162.0 dev --port 8787 \
  --var ALLOWED_ORIGINS:http://localhost:5173 --var GEMINI_MODEL:smoke-model
```

In another terminal:

```bash
# preflight from an allowed origin: 204 with the CORS headers
curl -i -X OPTIONS http://127.0.0.1:8787/v1/complete -H 'Origin: http://localhost:5173'
# invalid body: 400
curl -i -X POST http://127.0.0.1:8787/v1/complete -d '{"messages":[]}'
# valid body but no key configured: 503 {"error":{"kind":"unavailable"}}
curl -i -X POST http://127.0.0.1:8787/v1/complete -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"hello"}]}'
```

The upstream address is a constant of the contract, so a fake Gemini cannot be plugged into `wrangler dev`: the `200` path is covered by `smoke` and the fixtures. A valid request with a real key would call Gemini for real; that is the owner's step below.

## Deploy (owner only)

Nothing here is automated and no agent has deployed it. You need a Cloudflare account and a Gemini API key kept in Doppler. Never paste the key in a terminal history, a file or a chat.

1. **Create the Doppler project** `ilabs` (it does not exist by default) with a config of your choice, and add the secret `GEMINI_API_KEY` by typing its value in the Doppler dashboard, not in a shell.
2. **Sign in once**: `pnpm dlx wrangler@4.162.0 login` (browser flow).
3. **Set the two variables** in `wrangler.jsonc` (they are not secrets): `GEMINI_MODEL` (the Gemini model name) and `ALLOWED_ORIGINS` (comma-separated exact origins such as `https://example.test`, no wildcard, no trailing slash; list `http://localhost:5173` explicitly if you want local development to work). Both ship unedited and fail closed: with an empty `GEMINI_MODEL` every valid request answers `503` without calling Gemini, and with the `ALLOWED_ORIGINS` placeholder no browser origin is allowed.
4. **Deploy first**: `pnpm dlx wrangler@4.162.0 deploy` creates the Worker `ilabs-gateway` and prints the `workers.dev` URL, which is the demos' endpoint (`VITE_GATEWAY_ENDPOINT` in the web demo, the endpoint field in the Android demo). Without the key it answers `503`, so this first deploy is safe. The order matters: `secret put` on a Worker that does not exist yet asks for confirmation interactively, and that prompt cannot be answered when the key is piped in.
5. **Store the key as a Worker secret**, fed from Doppler so the value is never printed:

   ```bash
   cd demos/gateway-worker
   doppler run -p ilabs -c <config> -- sh -c 'printf %s "$GEMINI_API_KEY" | pnpm dlx wrangler@4.162.0 secret put GEMINI_API_KEY'
   ```

6. **Check it** with the curl commands above against the deployed URL (a valid request now reaches Gemini and uses your quota).

To rotate the key, put the new one in Doppler and repeat step 5. To take the Worker offline, delete it in the Cloudflare dashboard or with `wrangler delete`.

## Not verified

Neither the author nor the automated checks made a real Gemini call or deployed this Worker to Cloudflare: those are your steps, and the first live call is the first time the Gemini request and response mapping meets the real service. Also unverified: the behavior of Cloudflare's own rate limiting and what Gemini actually answers (latency, quotas, content). The contract scripts the network, the clock and Gemini; this package is verified against that script by the tests and by `smoke`. The author did not run `wrangler dev` (including the `--var ALLOWED_ORIGINS:...` command above, whose value contains colons) or `wrangler deploy --dry-run`, because no Wrangler was installed and nothing was online: run each once before you rely on them.

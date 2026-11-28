# Gateway and full-stack demo - design

Date: 2026-11-28. Status: approved to plan (the owner said to go ahead without further questions); the calls in "Calls after the builder check" are mine.

## Intent and why

iLabs has seven library modules and per-module demos. All of them run offline with a scripted mock, so none of them shows a **real model behind a real network boundary**. This work adds the missing piece the original design promised ("full-stack demo: web app + Cloudflare Worker proxy that composes several modules"):

1. a small **gateway Worker** (Cloudflare) that forwards completion requests to Gemini without ever exposing the key to the browser;
2. an **`HttpProvider`** in `providers` (TypeScript and Kotlin) that talks to that Worker, with its behavior pinned by shared fixtures like every other module;
3. an **Assistant** page (web) and screen (Android) that compose `context` + `guardrails` + `providers` (retry, fallback) + `evals` around that provider, so the portfolio shows the modules working together on a live path.

Owner's purpose: portfolio and practising the technique, aimed at interviews. A visitor must be able to see the whole chain work without any key (mock) and, where the owner deploys it, with a real model.

## Goals

- The Worker is a **thin, hardened proxy**: it validates and caps the request, applies an origin allowlist and a rate limit, calls Gemini, and maps every upstream outcome to the existing provider error taxonomy.
- The browser/app composition is client-side, so the same modules run in the same way against the mock and the Worker.
- The protocol between client and Worker is a **contract** (`contracts/gateway`): request/response JSON, validation limits, status-to-error mapping, CORS and rate-limit behavior. The Worker's pure request handler, the TypeScript `HttpProvider` and the Kotlin `HttpProvider` all pass the same fixtures.
- Default demos stay **offline and deterministic** (mock). The Worker and a real model are optional.
- Free-tier realities are handled (Gemini ~5 requests/min): `RetryingProvider` honors the `retryAfterMs` the Worker forwards.

## Non-goals

- No user accounts, sessions, persistence or analytics. No streaming in this iteration (one JSON response per request).
- Not a general LLM gateway: one upstream (Gemini), one fixed model chosen server-side, no tool calling.
- No public deployment by me. Deploying, creating the Cloudflare project, setting secrets and any live call with a real key are owner-only steps, documented as a guide.
- No server-side use of the other iLabs modules (guardrails, context stay in the client).

## Anti-goals (failure even if it "works")

- The Gemini key reaching the browser, the repo, logs or a fixture.
- An open proxy: arbitrary model, unbounded `maxTokens`, unbounded body or message count, any origin.
- A demo that only works with the owner's key or deployment.
- TS and Kotlin clients (or the Worker) drifting apart silently.
- A user-supplied key being stored, logged or echoed.

## Constraints

- Public MIT repo, English content, UI texts es + en, commits as the owner, no trailers, push/PR only when asked, no `--no-verify`.
- Secrets in Doppler (project `ilabs`, to be created by the owner); never printed.
- Workspace: pnpm 12.18.0 with exact pins; TypeScript 7.0.2, Vitest 5.1.0, React 19.3.1, Vite 8.3.7 as in the repo. Kotlin: JDK 21 builds, KMP Android + JVM, no new Gradle dependency unless unavoidable.
- CI keeps running without network and without secrets.

## Approaches considered

- **A. Thin proxy + contract-pinned clients (chosen by me).** The Worker only enforces hard limits and forwards. `HttpProvider` is a new provider in both languages over an injected transport, so it is testable with fixtures. The composition (context, guardrails, evals) lives in the clients. Trade-off: guardrails are client-side (a determined caller can bypass them, which the README states honestly); in exchange the demo shows the modules composing and the Worker stays small.
- **B. Worker only, hand-rolled `fetch` in the demos.** Least code, but no contract, no Kotlin client and drift is guaranteed. Rejected: it breaks the repo's core idea.
- **C. Worker runs guardrails/context server-side.** Better security story, but couples modules to the Worker, needs the Kotlin side to call the same logic remotely, and breaks "demos work offline". Rejected for this iteration; noted as a possible later hardening.

## The design

### Protocol (`contracts/gateway`)

`POST {endpoint}/v1/complete`, `Content-Type: application/json`.

Request body: the providers request shape, `{ "messages": [{ "role", "content" }], "maxTokens"?: number }`. Optional header `x-ilabs-api-key: <user key>` (bring your own key).

Success `200`: `{ "text": string, "provider": "gateway" }`.

Errors (JSON body `{ "error": { "kind", "retryAfterMs"? } }`):

| Condition | Status | `kind` |
|---|---|---|
| malformed JSON, wrong shape, over limits (below) | 400 | `invalid_output` |
| origin not on the allowlist | 403 | `unavailable` |
| rate limit exceeded | 429 | `rate_limit` (+ `retryAfterMs`, `Retry-After`) |
| upstream 429 | 429 | `rate_limit` (+ forwarded retry delay if known) |
| upstream timeout (20 s) | 504 | `timeout` |
| upstream 5xx, network failure, upstream auth failure, no key configured | 503 | `unavailable` |
| upstream blocked or empty candidate | 502 | `invalid_output` |

Limits (pinned in the contract, constants in the Worker): at most 50 messages, 8,000 characters per message, 32,000 characters in total, `maxTokens` 1..1,024 (default 256), body at most 64 KiB. Roles limited to `system|user|assistant`. The model name is a Worker variable, never taken from the request.

CORS: `Access-Control-Allow-Origin` echoes the request origin only when allowlisted; `OPTIONS` preflight answered; no credentials. The user key header is allowed only for allowlisted origins and is never logged or echoed.

Rate limit: per client IP, fixed window; the exact algorithm (a pure, injectable-clock function) is in the contract so both the Worker and tests agree. Implementation uses an in-isolate counter behind an interface; a Cloudflare rate-limiting binding may replace it at deploy time (builder's call, documented as best-effort).

### Components

- `contracts/gateway/`: README and fixtures for (a) the Worker handler: request + env + fake upstream script -> status + body + headers; (b) the client mapping: HTTP response -> `Provider` result/error.
- `demos/gateway-worker` (`@ilabs/gateway-worker`, TypeScript): `handle(request, env, deps)` pure handler (fake upstream and clock injected), thin `fetch` entry, `wrangler.jsonc` with no secrets, README with the owner-only deploy guide.
- `modules/providers`: `HttpProvider(id, endpoint, transport, options)` in TS and Kotlin. `transport` is an injected function/interface (like `sleep`), so fixtures run without a network; the demos supply `fetch` (web) and an `HttpURLConnection`-based transport (Android). Maps statuses and the error body to `ProviderError`/`ProviderException`, forwards `retryAfterMs`.
- Web page `#/assistant` and Android screen "Assistant": a chat over `RetryingProvider(FallbackProvider([HttpProvider, MockProvider]))`-style composition, `guardrails` redaction of PII before sending, `context` window to the token budget, a visible trace (which provider answered, retries, redactions, tokens kept), a backend switch **Mock (default) | Worker | My key**, and a small `evals` suite runnable against the selected backend. Same decisions file for both twins.

### Behavior calls (mine, to confirm)

- Default backend is **Mock** and works with no network. **Worker** needs a configured endpoint (build-time variable in web, a text field in Android); **My key** sends the user key per request to the same endpoint, kept in memory only.
- When the Worker is selected but unreachable, the visible trace says so and the fallback answers from the mock, labeled as such.
- The evals suite on a real backend is limited to a handful of cases to respect the free tier, with the delay between cases honoring `retryAfterMs`.

## Calls after the builder check (mine)

- **Origin allowlist is a browser-abuse and CORS control, not authentication.** It comes from a Worker variable `ALLOWED_ORIGINS` (comma-separated exact origins, no wildcards; localhost dev origins are listed explicitly by the owner). A request **without** an `Origin` header (native clients such as the Android app, curl) is allowed; a request with a non-allowlisted `Origin` gets 403. The real abuse controls are the rate limit and the hard caps, and the README says so plainly: anyone can call the Worker from a script, which is why the key, model and limits are fixed server-side.
- **"My key".** `x-ilabs-api-key` replaces the server key for that call only, works even when the Worker has no secret configured, and uses the same fixed model, the same size caps and the same per-IP rate limit (the limit protects the Worker, not the upstream quota). The key is never logged, echoed or included in an error returned to the client; upstream error bodies are never forwarded.
- **Evals on a real backend** use deterministic graders from the `evals` module only (contains, length, schema, no-PII), chosen so the same cases also pass against the mock. No LLM-as-judge in this demo (it would double the calls against the free tier).
- **Fallback order** in the Assistant: Worker first, mock second, labeled in the trace as "answered by the mock" when the Worker failed. Mock stays the default backend.
- **Client IP** is `CF-Connecting-IP`, falling back to a constant bucket when absent (tests, `wrangler dev`). The in-isolate counter is best-effort and documented as such.
- **Upstream retry delay:** parsing Gemini's `RetryInfo.retryDelay` (for example `"7s"`) from the 429 body, and the `Retry-After` header if present, is in scope; otherwise `retryAfterMs` is omitted.

## Left to the builder

Exact fixture file names and field layout; the rate-limit window constants (default proposal: 10 requests per 60 s per IP); Gemini request/response field mapping (REST `generateContent`); wrangler config details and compatibility date; test tooling for the Worker (plain Vitest on the pure handler is expected); Android transport implementation details; i18n keys; the Android/web UI layout following the existing demo pages.

## Verification the owner can expect

Contract fixtures passing in the Worker handler, TS client and Kotlin client; differential check TS vs Kotlin client mapping; demo tests with fake transports; a clean-clone run of the CI commands; a scripted local smoke of the Worker with `wrangler dev` against a fake upstream. Not verifiable by me: a real Gemini call and a Cloudflare deployment (owner steps).

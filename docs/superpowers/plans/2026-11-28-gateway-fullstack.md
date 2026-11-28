# Gateway and full-stack demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Run independent tasks in parallel** (see "Execution order"): each parallel implementer works in its own git worktree and must FIRST verify that its base is the commit named in its dispatch (`git merge-base --is-ancestor <sha> HEAD`, else `git merge --ff-only <full sha>`), and its commits are cherry-picked onto the branch after review.

**Goal:** Add a hardened Cloudflare Worker gateway to Gemini, an `HttpProvider` (TypeScript and Kotlin) pinned by a shared contract, and an Assistant page/screen that composes `context`, `guardrails`, `providers` and `evals` over it.

**Architecture:** `contracts/gateway` pins the HTTP protocol, the Worker handler behavior and the client mapping. The Worker is a pure handler `handle(request, env, deps)` plus a thin `fetch` entry. `HttpProvider` takes an injected transport so fixtures run offline. The demos compose the existing modules client-side.

**Tech Stack:** TypeScript 7.0.2, Vitest 5.1.0, React 19.3.1, Vite 8.3.7 (as in the repo), Cloudflare Workers runtime (Web `Request`/`Response`), Kotlin KMP (Android + JVM) with kotlinx.serialization already used by `providers`, Compose in the Android demo. Any new dependency (for example `wrangler`, `@cloudflare/workers-types`) is pinned to an exact version at least two weeks old.

**Spec:** `docs/superpowers/specs/2026-11-28-gateway-fullstack-design.md` (read the "Calls after the builder check" section: it overrides the earlier prose where they differ).

## Global Constraints

- Public MIT repo; English everywhere in the repo (code, docs, commits); demo UI strings es + en; no secrets, no local paths or usernames in tracked files; fixture "keys" are obvious markers such as `FIXTURE_SERVER_KEY`, never credential-shaped.
- Commits as the repo identity, NO trailers, never `--no-verify`; no push, tag or deploy without the owner's order.
- Protocol: `POST {endpoint}/v1/complete`; request `{messages:[{role,content}], maxTokens?}`; success `200 {text, provider:"gateway"}`; errors `{error:{kind, retryAfterMs?}}`.
- Limits (constants in the Worker, pinned by fixtures): body <= 64 KiB (65,536 bytes), messages 1..50, content <= 8,000 characters each and <= 32,000 in total (characters = UTF-16 code units, as `String.length`), roles `system|user|assistant`, `maxTokens` integer 1..1,024 default 256, upstream timeout 20,000 ms, rate limit 10 requests per 60,000 ms per IP (fixed window).
- Status mapping: 400 `invalid_output` (malformed or over limits); 403 `unavailable` (non-allowlisted `Origin`; a missing `Origin` is allowed); 429 `rate_limit` (+`retryAfterMs`, `Retry-After` seconds rounded up); upstream 429 -> 429 `rate_limit`; upstream timeout -> 504 `timeout`; upstream 5xx / network / upstream 401-403 / no key configured -> 503 `unavailable`; upstream blocked or empty candidate -> 502 `invalid_output`. Upstream error bodies are never forwarded.
- `x-ilabs-api-key` replaces the server key for that call, works without a server secret, never appears in any response, log or error; model is the Worker variable `GEMINI_MODEL`, never from the request.
- CORS: `Access-Control-Allow-Origin` echoes the request `Origin` only when allowlisted (`ALLOWED_ORIGINS`, comma-separated exact origins, no wildcards); `OPTIONS` preflight returns 204 with allowed methods `POST, OPTIONS` and headers `content-type, x-ilabs-api-key`; `Vary: Origin` always.
- CI must stay offline and secretless. TS contract harnesses guard `fixtures.length >= N`.
- Kotlin builds need `JAVA_HOME=~/.jdks/jdk-21.0.12.1+1` and `ANDROID_HOME=~/Android/sdk`; pnpm via a scratch pnpm 12.18.0 when corepack is missing.

## Review Focus

- A `messages` array whose total length is exactly 32,000 / 32,001 characters and one message of exactly 8,000 / 8,001: expect 200 / 400 (boundaries pinned by fixtures).
- A malformed `Origin` (empty string, `null`, with a trailing slash or path): treated as non-allowlisted, 403, never as "missing".
- Client IP header missing, or many different IPs: shared "unknown" bucket; the limiter map must not grow without bound (evict expired windows).
- An upstream reply of 200 with `candidates: []`, `finishReason: "SAFETY"`, or non-JSON: 502 `invalid_output`, never a crash or a 200 with empty text.
- Transport failures in the client: transport throws a timeout -> `timeout`; any other throw or a non-JSON body on an error status -> `unavailable`; a 200 whose body is not `{text:string}` -> `invalid_output`.

---

## Execution order

T1 first (contract). Then T2 (Worker), T3 (TS client) and T4 (Kotlin client) in parallel (disjoint files). Then T5 (web) and T6 (Android) in parallel, both reading one shared decisions file written by the controller after T4. Then T7 (docs, CI, owner guide). Reviews per task by fresh reviewers; Android review compares with the web twin point by point; a differential run TS vs Kotlin client; whole-branch review; ONE final fix wave; clean-clone verification with the exact CI commands. No push or squash without the owner's order.

### Task 1: Gateway contract and fixtures

**Files:**
- Create: `contracts/gateway/README.md`, `contracts/gateway/*.json`
- Modify: `.gitattributes` only if `contracts/**` is not already `eol=lf` (it is).

**Interfaces:**
- Produces: three fixture kinds, each file `{ "kind": "handler"|"client"|"limiter", "name": string, ... }`:
  - `handler`: `{ env: {GEMINI_API_KEY?, GEMINI_MODEL, ALLOWED_ORIGINS}, request: {method, path, headers: {}, body: string|object|null}, limiterPreload?: number, upstream: [ {status, body?, headers?} | {throws: "timeout"|"network"} ], expect: {status, body?, headers?: subset, upstreamCalls: number, upstream?: {model, key: "FIXTURE_SERVER_KEY"|"FIXTURE_USER_KEY", maxOutputTokens, contentsCount}} }`.
  - `client`: `{ endpoint, id?, apiKey?, request, transport: [ {status, body?, headers?} | {throws: "timeout"|"network"} ], expect: {result: {text, provider}|{error:{kind, retryAfterMs?}}, requests: [{url, method, headers: subset, body}]} }`.
  - `limiter`: `{ limit, windowMs, calls: [{key, now}], expect: [{allowed: boolean, retryAfterMs?: number}] }`.
- The README states every rule in the Global Constraints as ordered step lists (validation order: method/path, origin, preflight, body size, JSON, shape, limits, rate limit, key, upstream), the Gemini upstream request/response mapping, the `retryDelay` parsing rule, and the numbered clarifications convention of earlier contracts.

- [ ] **Step 1: Write the README** with the validation order, status table, limits, CORS, limiter algorithm (fixed window: the window starts at the first call of a key; the (limit+1)th call inside the window is denied with `retryAfterMs = windowStart + windowMs - now`; a call at `now >= windowStart + windowMs` starts a new window), the Gemini mapping (request `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`, header `x-goog-api-key`, `system` messages joined into `systemInstruction`, `assistant` -> role `model`, `generationConfig.maxOutputTokens`; response text = concatenated `parts[].text` of `candidates[0]` when `finishReason` is absent or `STOP`/`MAX_TOKENS`), and `RetryInfo.retryDelay` strings of the form `<seconds>s` (fractional allowed) -> milliseconds, rounded up.
- [ ] **Step 2: Write fixtures** (at least 70, one rule each, derived by hand from the README, not by running an implementation): every status row, each boundary of the Review Focus, CORS echo/no-echo/preflight, missing vs bad origin, user key vs server key vs neither, upstream 429 with and without `retryDelay`/`Retry-After`, SAFETY/empty candidate/non-JSON upstream, model taken from env, `maxTokens` default and clamp rejection, limiter window edges, client mapping of every status and transport failure, `retryAfterMs` forwarding, trailing-slash endpoint normalization (`endpoint` with or without `/` gives the same URL).
- [ ] **Step 3: Write a scratch verifier** (outside the repo, in the scratchpad) implementing the README independently and report that it passes all fixtures; keep a mutant list for discrimination (late validation, missing boundary, wrong status, key leak in body, origin echo for non-allowlisted).
- [ ] **Step 4: Commit** `docs: add the gateway contract and fixtures`.

### Task 2: Worker handler (`demos/gateway-worker`)

**Files:**
- Create: `demos/gateway-worker/{package.json,tsconfig.json,wrangler.jsonc,README.md,src/{index.ts,handler.ts,limits.ts,gemini.ts,limiter.ts,cors.ts},src/*.test.ts,src/contract.test.ts}`
- Modify: `pnpm-workspace.yaml` (add `demos/gateway-worker`), `pnpm-lock.yaml`.

**Interfaces:**
- Consumes: the Task 1 fixtures.
- Produces: `handle(request: Request, env: Env, deps: Deps): Promise<Response>` with `Env = {GEMINI_API_KEY?: string; GEMINI_MODEL: string; ALLOWED_ORIGINS: string}` and `Deps = {fetch: typeof fetch; now(): number; limiter: RateLimiter}`; `createLimiter(limit: number, windowMs: number): RateLimiter` with `check(key: string, now: number): {allowed: boolean; retryAfterMs?: number}` and bounded memory; default export `{ fetch(request, env) }` wiring real `fetch`, `Date.now` and a module-level limiter.

- [ ] **Step 1: Write the contract test** `src/contract.test.ts` running every `handler` and `limiter` fixture (fake upstream from the script, fake clock), with the `fixtures.length >= N` guard; run it and see it fail.
- [ ] **Step 2: Implement** the modules by responsibility (`cors.ts` origin parsing/headers, `limits.ts` validation returning a typed result, `gemini.ts` request building and response/error mapping, `limiter.ts`, `handler.ts` orchestration in the README's validation order). The upstream call uses `AbortSignal.timeout(20_000)` only through `deps.fetch` options; tests simulate the timeout via the script.
- [ ] **Step 3: Unit tests** for the Review Focus items not expressible as fixtures: limiter eviction keeps the map bounded under 100,000 distinct keys; the user key never appears in any response body or header across all fixtures (assert over the whole fixture run); `handle` never throws for arbitrary `Request` input (property-style loop with random bodies and headers).
- [ ] **Step 4: Run** `pnpm --filter @ilabs/gateway-worker test` and `typecheck`: all green.
- [ ] **Step 5: README** with the honest limits (allowlist is not authentication, in-isolate limiter is best-effort), and an owner-only deploy guide (create the Cloudflare project, `wrangler secret put GEMINI_API_KEY` fed from Doppler project `ilabs` without printing it, set `ALLOWED_ORIGINS` and `GEMINI_MODEL`, `wrangler deploy`), plus a local smoke recipe with `wrangler dev` and a fake upstream. Do not deploy.
- [ ] **Step 6: Commit** `feat(gateway-worker): add the gateway Worker`.

### Task 3: TypeScript `HttpProvider`

**Files:**
- Create: `modules/providers/ts/src/http.ts`, `modules/providers/ts/src/http.test.ts`, `modules/providers/ts/src/http-contract.ts`
- Modify: `modules/providers/ts/src/index.ts` (export), `modules/providers/README.md` (short section).

**Interfaces:**
- Produces: `type HttpRequest = {url: string; method: "POST"; headers: Record<string,string>; body: string; timeoutMs: number}`; `type HttpResponse = {status: number; headers: Record<string,string>; body: string}`; `type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>` (rejects with `TransportTimeoutError` for a timeout, anything else is a network failure); `class TransportTimeoutError extends Error`; `class HttpProvider implements Provider` with `constructor(options: {id?: string; endpoint: string; transport: HttpTransport; apiKey?: string; timeoutMs?: number})` (default id `"gateway"`, default timeout 25,000 ms) and `complete(req)`; `runClientFixture(fixture): Promise<ClientRun>`.

- [ ] **Step 1: Write failing tests**: `http.test.ts` runs every `client` fixture through `runClientFixture` (guard `>= N`) plus unit cases (apiKey header only when set, endpoint normalization, request body is exactly the JSON of the request).
- [ ] **Step 2: Implement** per the contract mapping (status table, `retryAfterMs` from the body, `Retry-After` header as fallback in seconds, transport timeout -> `timeout`, other throw -> `unavailable`, 200 with a body that is not `{text:string}` -> `invalid_output`, `provider` taken from the response when it is a string else the configured id).
- [ ] **Step 3: Run** the package tests and typecheck: green.
- [ ] **Step 4: Commit** `feat(providers): add HttpProvider (TypeScript)`.

### Task 4: Kotlin `HttpProvider`

**Files:**
- Create: `modules/providers/kotlin/src/commonMain/kotlin/es/sebas1705/ilabs/providers/HttpProvider.kt`, tests in `commonTest` and the client-fixture runner in `commonMain/.../contract` following the existing harness, `jvmTest` entry that runs the shared fixtures.

**Interfaces:**
- Produces (same semantics as Task 3): `data class HttpRequest(val url: String, val headers: Map<String,String>, val body: String, val timeoutMs: Long)`, `data class HttpResponse(val status: Int, val headers: Map<String,String>, val body: String)`, `fun interface HttpTransport { suspend fun send(req: HttpRequest): HttpResponse }`, `class TransportTimeoutException : Exception`, `class HttpProvider(override val id: String = "gateway", endpoint: String, transport: HttpTransport, apiKey: String? = null, timeoutMs: Long = 25_000) : Provider`.

- [ ] **Step 1: Failing tests** running all `client` fixtures (guard) and the same unit cases as Task 3.
- [ ] **Step 2: Implement** with kotlinx.serialization (already a dependency), identical mapping.
- [ ] **Step 3: Run** `./gradlew :modules:providers-kotlin:jvmTest` (adjust to the real module path): green.
- [ ] **Step 4: Commit** `feat(providers): add HttpProvider (Kotlin)`.

### Task 5: Web Assistant page

**Files:**
- Create: `demos/web/src/pages/AssistantPage.tsx`, `demos/web/src/assistant/{compose.ts,backends.ts,evalsSuite.ts}`, tests next to them.
- Modify: `demos/web/src/routes.ts` (route `assistant`, `#/assistant`, nav label "Assistant"), `demos/web/src/i18n.ts` (es + en keys prefixed `assistant`), `demos/web/src/styles.css`, `demos/web/src/route.test.tsx`.

**Interfaces:**
- Consumes: `HttpProvider`, `MockProvider`, `RetryingProvider`, `FallbackProvider`, `guardedComplete`/`GuardedProvider` (check the exact export in `@ilabs/guardrails`), `slidingWindow`, the `evals` graders; the shared decisions file `.superpowers/sdd/<ledger>/assistant-decisions.md` (written by the controller after Task 4).
- Produces: `buildProvider(backend: "mock"|"worker"|"key", config): Provider` and `runTurn(...)` returning `{text, answeredBy, trace: TraceEvent[]}`.

- [ ] **Step 1: Failing tests** with a scripted fake transport: mock backend answers offline; worker backend failing with `unavailable` falls back to the mock and the trace says "answered by the mock"; `rate_limit` with `retryAfterMs` makes the retry wait (injected sleep) and shows the wait in the trace; PII in the user message is redacted before the transport sees it (assert on the recorded request body); the context window drops old turns beyond the budget and the trace shows the kept token count; "My key" is sent only in the `x-ilabs-api-key` header and never rendered in the DOM; the evals suite runs on mock and on a scripted worker with deterministic graders; es/en keys identical sets; accessibility (labels, polite status, assertive errors, 44 px targets).
- [ ] **Step 2: Implement** the page and composition; endpoint from `import.meta.env.VITE_GATEWAY_ENDPOINT` with an editable field; backends enabled/disabled with translated notes; no real network in tests.
- [ ] **Step 3: Verify** typecheck, tests, build; run the page in the browser pane against the mock at 375 px and desktop (es/en, light/dark).
- [ ] **Step 4: Commit** `feat(demo-web): add the assistant page`.

### Task 6: Android Assistant screen

**Files:**
- Create: `demos/android/src/main/kotlin/es/sebas1705/ilabs/demo/Assistant{Screen,ViewModel,Backends,Trace}.kt`, strings es/en with prefix `assistant_`, tests in `demos/android/src/test/kotlin/.../Assistant*Test.kt`.
- Modify: the module list (`ModuleHome.kt` / `MainActivity.kt`) to add the eighth module, `demos/android/build.gradle.kts` only if a dependency is unavoidable.

**Interfaces:**
- Consumes: Kotlin `HttpProvider` and the same decisions file as Task 5; an `HttpURLConnection`-based `HttpTransport` implemented in the demo (timeouts mapped to `TransportTimeoutException`, TLS only, no cleartext except an explicit `http://10.0.2.2` / `localhost` dev endpoint).

- [ ] **Step 1: Failing tests** mirroring Task 5 point by point with a fake transport (JVM unit tests), plus the transport against a local `HttpServer` from the JDK (success, 429 with `Retry-After`, timeout).
- [ ] **Step 2: Implement** screen, ViewModel (state saved across process death, stale results ignored), 48 dp targets, spoken sentences per row.
- [ ] **Step 3: Verify** `./gradlew :demos:android:testDebugUnitTest :demos:android:assembleDebug`; on the `ilabs_api36` emulator check mock chat, Worker mode against a local fake gateway if feasible, es/en, dark, font scale 1.5.
- [ ] **Step 4: Commit** `feat(demo-android): add the assistant screen`.

### Task 7: Docs, CI and owner guide

**Files:**
- Modify: root `README.md` (module/demo table, gateway section), `modules/providers/README.md`, `.github/workflows/ci.yml` (nothing new if `demos/**` and `contracts/**` already trigger; add the Worker package to any explicit lists), `demos/gateway-worker/README.md` (final pass).
- Create: `docs/gateway-deploy.md` only if the Worker README would exceed one screen (owner-only steps, Doppler project `ilabs`, never print the key).

- [ ] **Step 1: Write the docs** truthfully against the final code: every snippet executed; honest limits (client-side guardrails, best-effort limiter, allowlist is not authentication, a real Gemini call and a deployment were not verified by the agents).
- [ ] **Step 2: Verify** links, `git diff --check`, no local paths, `pnpm install --frozen-lockfile`, typecheck, tests, builds, the exact Gradle command.
- [ ] **Step 3: Commit** `docs: document the gateway and the assistant demo`.

## Self-review

- Spec coverage: protocol, limits and mapping (T1, T2); `HttpProvider` both languages (T3, T4); Assistant web/Android with backend switch, fallback labeling, redaction, context window, evals (T5, T6); owner-only deploy guide and honest limits (T2, T7); BYOK rules (T1, T2, T5 tests); no deployment, no secrets (Global Constraints).
- Types: `HttpTransport`/`HttpRequest`/`HttpResponse` names match across T3, T4 (Kotlin spelling noted), `handle`/`Env`/`Deps` only in T2, `buildProvider`/`runTurn` only in T5 and mirrored by T6 via the decisions file.
- Proportion: the plan fixes names, limits and mapping; fixture content and module bodies are left to the implementers under the contract.

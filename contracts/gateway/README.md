# gateway contract

Shared contract for the iLabs gateway: the HTTP protocol between a client and the gateway Worker, the behavior of the Worker's request handler and rate limiter, the way the handler talks to Gemini, and the mapping a client (`HttpProvider`, in TypeScript and Kotlin) applies to the gateway's replies. Three implementations must pass every `*.json` fixture in this folder that concerns them: the Worker handler and limiter (`demos/gateway-worker`, TypeScript), `HttpProvider` in TypeScript and `HttpProvider` in Kotlin (`modules/providers`).

The network, the clock and Gemini are scripted in the fixtures: a real HTTP exchange, real Gemini behavior (latency, quotas, the content of answers), a deployed Worker, the real clock and the wording of any UI are not in the contract. Nothing in this folder contains a credential: the fixture "keys" are the markers `FIXTURE_SERVER_KEY` and `FIXTURE_USER_KEY`.

Honest limits, each pinned by a rule below: the origin allowlist is a browser-abuse and CORS control, not authentication (a script can call the Worker, so the model, the key and every cap are fixed server-side); the rate limiter is a fixed window held in memory by one isolate, so it is best-effort (several isolates each have their own counters); the guardrails of the demos are client-side and are not part of this contract; one request produces at most one upstream call (the gateway never retries).

## Constants

| Name | Value |
|---|---|
| Body limit | 65,536 bytes (64 KiB) of UTF-8 |
| Messages per request | 1 to 50 |
| Characters per message | 1 to 8,000 |
| Characters in total | at most 32,000 (the sum over all messages, `system` included) |
| Character | one UTF-16 code unit (`String.length`): `😀` counts 2 |
| Roles | `system`, `user`, `assistant`, exactly these lowercase strings |
| `maxTokens` | integer 1 to 1,024, default 256 |
| Upstream timeout | 20,000 ms |
| Rate limit | 10 requests per 60,000 ms per client IP, fixed window |
| Delay cap | 3,600,000 ms (any retry delay above it is capped to it) |
| Client default timeout | 25,000 ms |
| Preflight max age | 600 seconds |
| Upstream base | `https://generativelanguage.googleapis.com/v1beta/models/` |

## Protocol

`POST {endpoint}/v1/complete` with a JSON body `{ "messages": [{ "role", "content" }], "maxTokens"?: number }` (the request shape of the `providers` contract) and an optional header `x-ilabs-api-key: <user key>` (bring your own key).

Success: `200` with `{ "text": string, "provider": "gateway" }`. Every error: a JSON body `{ "error": { "kind", "retryAfterMs"? } }` where `kind` is one of `rate_limit`, `timeout`, `invalid_output`, `unavailable` (the error kinds of the `providers` contract) and `retryAfterMs` (an integer number of milliseconds) is present only on `429` and only when known. The error body has no other key: no message, no detail, never an upstream body.

| Condition | Status | `kind` |
|---|---|---|
| path is not `/v1/complete` | 404 | `unavailable` |
| method is neither `POST` nor `OPTIONS` | 405 | `unavailable` |
| `Origin` present and not allowlisted | 403 | `unavailable` |
| body over 64 KiB, not JSON, wrong shape, over a limit | 400 | `invalid_output` |
| this client exceeded the rate limit | 429 | `rate_limit` (+ `retryAfterMs`) |
| neither a server key nor a user key | 503 | `unavailable` |
| upstream 429 | 429 | `rate_limit` (+ `retryAfterMs` when the upstream says how long) |
| the upstream call timed out (20 s) | 504 | `timeout` |
| upstream 401, 403, 5xx, any other status, a network failure | 503 | `unavailable` |
| upstream 200 that is blocked, empty or unreadable | 502 | `invalid_output` |
| success | 200 | (body `{ text, provider }`) |

## Environment

`env` is `{ GEMINI_API_KEY?: string, GEMINI_MODEL: string, ALLOWED_ORIGINS: string }`.

- E1. `GEMINI_API_KEY` is the server key. Absent or the empty string means "no server key".
- E2. `GEMINI_MODEL` is the only source of the model name (it is chosen by the owner and never comes from a request). It is put into the upstream URL as one path segment, percent-encoded like JavaScript's `encodeURIComponent`: every character except `A-Z a-z 0-9 - _ . ! ~ * ' ( )` becomes `%XX` for each byte of its UTF-8 form. So `tunedModels/my-model-123` is `tunedModels%2Fmy-model-123` and `m%2Fx` is `m%252Fx`. A model that is empty once spaces and tabs are removed is a deployment error: step 11 answers `503` `unavailable` with no upstream call.
- E3. `ALLOWED_ORIGINS` is split on `,` only (not on `;`, on spaces or on newlines); each entry is trimmed of ASCII space and tab only (a CR, a LF or a no-break space is not trimmed and makes the entry invalid); an empty entry is dropped; an entry that is not valid (E4) is ignored. The allowlist is the set of valid entries.
- E4. A valid entry is exactly `scheme://host` or `scheme://host:port` and nothing else, where the scheme is the lowercase `http` or `https`; the host is one or more characters from lowercase letters `a-z`, digits, `.` and `-`, or a bracketed IPv6 literal made of lowercase hex digits, `:` and `.`; the port is a decimal number from 1 to 65535 without a leading zero. No path (not even a trailing `/`), no query, no fragment, no user info, no wildcard, no underscore, no uppercase letter anywhere. A request `Origin` is allowed only when it is equal, character for character, to a valid entry: no case folding, no default-port stripping (`https://h` and `https://h:443` are two different origins), no URL normalization of any kind. The strings `*` and `null` can never be allowed.

## Handler: processing order

`handle(request, env, deps)` runs these steps in order. A step either answers (the request stops there, later steps do not run and cost nothing) or lets the request continue.

1. **Path.** The path of the request URL without the query string must be exactly `/v1/complete`: case-sensitive, no trailing slash. Otherwise `404` `unavailable`. The contract adds no normalization at all: no percent-decoding, no collapsing of slashes, no removal of `;` parameters (`//v1/complete`, `/v1//complete`, `/v1/%63omplete`, `/v1/complete;x=1` and `/v1/complete/` are all `404`). The runtime's own URL parser resolves dot segments before any handler sees the request (`/v1/./complete` arrives as `/v1/complete`); that is the runtime's business and is not pinned. The query string and the fragment are not part of the path.
2. **Method.** `OPTIONS` and `POST` continue; any other method (`GET`, `HEAD`, `PUT`, `DELETE`, ...) is `405` `unavailable` with the header `allow: POST, OPTIONS`. The path is checked before the method, so `GET /nope` is `404`.
3. **Origin.** If the request has an `Origin` header (any value, the empty string included) its value must be in the allowlist; otherwise `403` `unavailable`. A request with no `Origin` header at all (a native client, `curl`) continues. This step applies to `OPTIONS` as well. `null`, an empty string, a value with a trailing `/`, a path, another scheme, host case or port are all "present and not allowlisted": `403`, never "missing".
4. **Preflight.** `OPTIONS` is answered `204` with an empty body and the headers `access-control-allow-methods: POST, OPTIONS`, `access-control-allow-headers: content-type, x-ilabs-api-key` and `access-control-max-age: 600` (plus the common headers below). The request body, `Access-Control-Request-*` headers and the rate limiter are ignored: a preflight never reads the body, never consumes a rate-limit slot and never reaches the upstream. A preflight without an `Origin` header is also `204`.
5. **Body size.** The body is read as bytes. More than 65,536 bytes is `400` `invalid_output`. Bytes, not characters: a body of 22,000 `€` (3 bytes each) is over the limit although it is only 22,000 characters. No body at all is an empty body (size 0). `Content-Length` is not consulted. A body that is not valid UTF-8 is `400` `invalid_output` as well (a unit-test rule: a fixture body is text and cannot hold invalid bytes).
6. **JSON.** The bytes are decoded as UTF-8 without dropping a leading byte order mark, and parsed as exactly one JSON value as RFC 8259 defines it, strictly. Only the four JSON whitespace characters (space, tab, LF, CR) may surround the value, and nothing is trimmed: a no-break space, a form feed, a vertical tab, U+3000 or a byte order mark (U+FEFF) before or after the value is not whitespace, so such a body is not JSON. Comments, trailing commas, single quotes, unquoted keys, `NaN`, `Infinity`, hexadecimal numbers, numbers with a leading zero or a plus sign, and raw control characters inside strings are not JSON. When an object repeats a key the last occurrence wins (`{"messages":[],"messages":[...]}` has the second value). Anything that is not JSON (an empty body, truncated text, trailing text, ...) is `400` `invalid_output`.
7. **Shape.** The value must be an object (an array, `null`, a string or a number is `400`). Then, every failure being `400` `invalid_output`:
   - `messages` is present and is an array of 1 to 50 elements;
   - every element is an object with `role` one of the three role strings and `content` a string of at least 1 character;
   - at least one element has the role `user` or `assistant` (a request of `system` messages only has nothing to answer);
   - `maxTokens`, when the key is present, is a JSON number that is an integer (read as "Reading an integer" below) from 1 to 1,024 (`256.0`, `1e2` and `25.6e1` are 256, 100 and 256; `null`, a string, a boolean, an array, `0`, `-0`, `1025`, `1.5`, `1e-400`, `1e400` and `-1` are not valid). When the key is absent the value is 256.
   Keys other than `messages` and `maxTokens`, at the top level and inside a message, are ignored: they are never read and never forwarded (a `model`, `apiKey`, `tools` or `systemInstruction` key in the request has no effect).
8. **Limits.** Every `content` has at most 8,000 characters and the sum of the lengths of all contents is at most 32,000; otherwise `400` `invalid_output`. Steps 7 and 8 give the same answer, so which of them fires first is not observable.
9. **Rate limit.** The limiter key is the value of the `cf-connecting-ip` header, as the runtime delivers it, when it is present and not empty, otherwise the constant `unknown` (other headers such as `x-forwarded-for` are never used). A key is an opaque string, compared exactly (an IPv6 address in another letter case is another key). `check(key, now)` of the fixed-window limiter below with `limit = 10` and `windowMs = 60,000`: when it denies, `429` `rate_limit` with `retryAfterMs` as the limiter returns and the header `retry-after` equal to `retryAfterMs` in seconds rounded up (`ceil(retryAfterMs / 1000)`, written in decimal digits). Only requests that reached this step are counted, and each of them consumes its slot for good, whatever happens next: a request that then fails on a missing key, a missing model or an upstream failure has used its slot. A request answered at steps 1 to 8 consumes nothing.
10. **Key.** The user key is the value of the header `x-ilabs-api-key` (header names are case-insensitive; the value is taken as the runtime delivers it: a runtime removes surrounding spaces itself, which the contract neither requires nor pins) when it is present and not empty. The key used for the upstream call is the user key if there is one, otherwise the server key (E1), otherwise there is none and the answer is `503` `unavailable` (no upstream call). A user key works without any server key and replaces the server key for this call only.
11. **Upstream.** Build the upstream request (below), call `deps.fetch` once with an `AbortSignal` that fires after 20,000 ms in `init.signal`, and map the outcome as written in "Upstream outcomes". There is no retry.

### Response rules

- R1. Every response, whatever its status (`204`, `404`, `403`, ...), carries `vary: Origin` and `cache-control: no-store`.
- R2. A response that has a body carries `content-type: application/json` and the body is exactly one of the JSON documents of the protocol, no other key. The `204` preflight has no body and no `content-type`.
- R3. CORS: when the request has an `Origin` header whose value is allowlisted, the response (any status, preflight included) carries `access-control-allow-origin` equal to that origin, copied exactly. In every other case (no `Origin`, or not allowlisted) the header is absent. `access-control-allow-credentials` is never sent. A `403` for a non-allowlisted origin therefore carries no CORS header, and neither does any response to a request without `Origin`.
- R4. `retry-after` is sent on `429` only, and only when `retryAfterMs` is known: the value is `ceil(retryAfterMs / 1000)` in decimal digits (`0` for `0`).
- R5. No response header or body ever contains the user key or the server key, and the header `x-ilabs-api-key` is never echoed. Upstream error bodies and upstream headers are never forwarded.

### Reading an integer

`maxTokens` (handler) and `retryAfterMs` (client) are read the same way. A JSON number is an integer when its exact decimal value, taken from the literal text of the JSON, has no fractional part. No floating-point number is used to decide or to compare: `1500.0`, `1.5e3`, `1E3`, `25.6e1` and `-0` are integers (1500, 1500, 1000, 256 and 0); `1500.5`, `1500.0000000000000001`, `1e-400` and `5e-1` are not. Integers of any size are integers, and a limit or a cap is then applied to the exact value: `1e400` and `4294967297` are integers above every limit of this contract. `-0` is `0`. A value that is not a JSON number (`null`, a string, a boolean, an array, an object) is not an integer. An implementation keeps the literal text or uses an arbitrary-precision decimal: a `double`, a 32-bit or a 64-bit integer parse is wrong.

## Rate limiter

`createLimiter(limit, windowMs)` returns `check(key, now) -> { allowed: boolean, retryAfterMs?: number }`; `now` is an integer number of milliseconds. Per key the limiter holds a window `{ start, count }`:

1. If the key has no window, or `now >= start + windowMs`, the key gets a new window `{ start: now, count: 0 }` (the old one is dropped).
2. If `count < limit`: `count` grows by one and the call is allowed (`{ allowed: true }`, no `retryAfterMs`).
3. Otherwise the call is denied: `{ allowed: false, retryAfterMs: start + windowMs - now }`. A denied call changes nothing: it does not count and does not move the window.

So the first call of a key opens its window (`start` is that call's time, not an aligned boundary), the `limit + 1`th call inside the window is denied, and a call exactly at `start + windowMs` already belongs to the next window. A denied call always has `retryAfterMs >= 1` and `<= windowMs`. Keys are opaque strings compared exactly (`__proto__`, `constructor`, `toString` and the empty string are ordinary keys). `limit` is an integer `>= 0`; with `0` every call is denied (the first call still opens a window and is denied with `retryAfterMs = windowMs`). Time never goes backwards for one key (the behavior otherwise is not pinned). A window that is still live (`now < start + windowMs`) is never evicted, whatever the number of keys; a window that has expired may be evicted at any time (the memory bound is a unit-test rule, see the end).

## The Gemini exchange

### Upstream request

`POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` (`{model}` is `GEMINI_MODEL` encoded as E2 says). The handler sets exactly two headers: `content-type: application/json` and `x-goog-api-key: <the key of step 10>`. The key is never put in the URL and `x-ilabs-api-key` is never forwarded. The body is the JSON object

```json
{
  "systemInstruction": { "parts": [{ "text": "<system contents joined>" }] },
  "contents": [{ "role": "user" | "model", "parts": [{ "text": "<content>" }] }],
  "generationConfig": { "maxOutputTokens": <maxTokens> }
}
```

- The `system` messages, in order of appearance wherever they are in the list, are joined with the two characters `\n\n` (a newline twice) into the one text of `systemInstruction`. With no `system` message the key `systemInstruction` is absent.
- Every other message becomes one element of `contents`, in order: role `user` stays `user`, role `assistant` becomes `model`; the one part holds the content verbatim (no trimming, no normalization). Consecutive messages with the same role are not merged.
- `generationConfig` has only `maxOutputTokens`. There is no other key in the body (no `temperature`, `safetySettings`, `model`).

### Upstream outcomes

The fetch outcome maps as follows (the first matching row):

| Outcome | Answer |
|---|---|
| the fetch rejects with a timeout (an error named `TimeoutError` or `AbortError`) | `504` `timeout` |
| the fetch rejects with anything else | `503` `unavailable` |
| status 200 | the response mapping below |
| status 429 | `429` `rate_limit`, with `retryAfterMs` when the retry delay rules find one |
| any other status (400, 401, 403, 404, 5xx, 204, 3xx, ...) | `503` `unavailable` |

An upstream `504` is therefore `503`: `504` is produced only by the gateway's own timeout. The fixtures script a timeout only as `throws: "timeout"` (the harness rejects with an error named `TimeoutError`); an `AbortError`, and the rule that other errors are network failures even when their message mentions a timeout, are unit-test rules. The upstream body is read as bytes and decoded as UTF-8 without dropping a leading byte order mark (`Response.text()` drops it: do not use it); a body that cannot be read at all is treated like a body that is not JSON (`502` on a `200`, no delay information on a `429`, `503` otherwise).

### Upstream response mapping (status 200)

Each failure is `502` `invalid_output`, and the answer never contains upstream text on failure.

1. The body must parse as JSON, strictly as in handler step 6 (a leading byte order mark, a trailing comma, text after the value: not JSON; the last duplicate key wins), and be an object (empty body, HTML, an array: failure).
2. `candidates` must be a non-empty array. Only `candidates[0]` is read, whatever the others hold. A blocked prompt (`promptFeedback.blockReason`, no candidates) fails here.
3. `candidates[0]` must be an object. Its `finishReason` must be absent, JSON `null` (which counts as absent), `STOP` or `MAX_TOKENS` (case-sensitive); any other value of any JSON type (`SAFETY`, `RECITATION`, `OTHER`, `stop`, the empty string, a number, an array) fails.
4. The text is the concatenation, with no separator and in order, of the `text` of every element of `content.parts` that has a `text` string (elements without a string `text` are skipped). A missing or non-object `content`, a missing or non-array `parts` give the empty text, which is `invalid_output` (step 5).
5. The empty text fails (including a `MAX_TOKENS` candidate that produced nothing). Any non-empty text succeeds, whitespace-only included: `200` `{ "text": <text>, "provider": "gateway" }`. Other keys of the upstream body (`usageMetadata`, `modelVersion`) are ignored.

### Retry delay (upstream 429)

`retryAfterMs` is the first of these that applies; if none does it is omitted (and so is the `retry-after` header).

1. The body is JSON (strict, as in handler step 6), an object whose `error` is an object whose `details` is an array. The elements are scanned in order. An element is skipped unless it is an object whose `@type` is exactly the string `type.googleapis.com/google.rpc.RetryInfo` (no prefix, no suffix, no case change) and whose `retryDelay` is a string matching exactly `^[0-9]+(\.[0-9]{1,9})?s$`: digits, optionally a dot and one to nine digits, then a lowercase `s`. So `7s`, `007s`, `1.0000s` and `0.000000001s` are delays; `7`, `-1s`, `+7s`, `.5s`, `1.s`, `7S`, ` 7s`, `7s `, `7s\n`, `7e0s`, `1.0000000001s` (ten fraction digits), `s`, the empty string, a number and an Arabic-Indic digit are not. The first element that passes both tests gives the delay; later elements are not looked at (an element that fails is skipped and the scan goes on).
2. The upstream header `retry-after`: its name is looked up case-insensitively (when two names differ only in case, the one that appears last wins) and its value must match exactly `^[0-9]+$`: at least one ASCII digit `0-9` and nothing else (no sign, no space, no fraction, no exponent, no empty value, no digit of another script, no list). Leading zeros are allowed and the value is the number it spells (`0003` is 3). The delay is that many seconds. An HTTP date or anything else is ignored, as if absent.

`retryDelay` is converted to milliseconds in exact decimal arithmetic, rounded up, never through floating point: with `I` the digits before the point and `F` the digits after it (empty if none), let `first3` be the first three digits of `F` padded on the right with `0` to three digits and `rest` the digits of `F` after the third; `ms = I * 1000 + first3 + (1 if rest has a digit other than 0, else 0)`. So `7s` is 7000, `7.5s` 7500, `0.25s` 250, `0.0011s` 2 (1.1 ms rounded up), `1.000000001s` 1001, `0s` 0. The header form is `seconds * 1000` (multiplied exactly: the digits may be far more than any integer type holds, so use big integers or compare as text after stripping the leading zeros). Both results are capped at 3,600,000 ms after that exact computation (`3600` is exactly the cap, `3601` is capped). `0` is a value, not "absent": it is forwarded as `retryAfterMs: 0` and `retry-after: 0`.

## The client: `HttpProvider`

`HttpProvider({ id?, endpoint, transport, apiKey?, timeoutMs? })` implements the `Provider` of the `providers` contract over an injected transport. The default `id` is `gateway`, the default `timeoutMs` 25,000. The transport takes a request `{ url, method: "POST", headers, body, timeoutMs }` (`method` is implied in Kotlin) and returns `{ status, headers, body }` (`body` is text and never null: no body is the empty string; `headers` maps names to single values, names as the transport spells them, values used as given and never trimmed), or rejects: with a timeout error (`TransportTimeoutError` in TypeScript, `TransportTimeoutException` in Kotlin) or with anything else (a network failure).

`complete(request)` does exactly one transport call:

1. **URL.** `endpoint` with every trailing `/` removed, then `/v1/complete`. `https://gw.example.test`, `https://gw.example.test/` and `https://gw.example.test///` give the same URL; a path prefix is kept (`https://gw.example.test/api/` gives `https://gw.example.test/api/v1/complete`).
2. **Headers.** Exactly `content-type: application/json`, plus `x-ilabs-api-key: <apiKey>` when `apiKey` contains at least one character other than space, tab, CR and LF (an empty or whitespace-only `apiKey` counts as absent; any other `apiKey` is sent exactly as given, never trimmed). Header names are lowercase. No other header.
3. **Body.** The JSON text of the request: an object with `messages` (every message with exactly `role` and `content`, as given) and `maxTokens` only when the request has one (present means not absent and not null; any integer is forwarded unchanged, `0`, `-3` and `5000` included; see clarification 42). The key never appears in the body and no other key is ever added. The client validates and normalizes nothing: a bogus role, an empty content or an empty `messages` list are forwarded as given and still make one transport call (the gateway validates).
4. **Timeout.** `timeoutMs` is passed to the transport unchanged.
5. **Transport failure.** A timeout rejection is `timeout`; any other rejection is `unavailable`. Neither carries `retryAfterMs`.
6. **Status 200** (exactly 200; `201` and `204` are not success). The body must parse as a JSON object (see rule 9) whose `text` is a string (the empty string is a valid text, whitespace is kept as is); otherwise `invalid_output`, an `error` key included: a `200` whose body is `{"error": ...}` has no text. Other keys are ignored. The result is `{ text, provider }` with `provider` the body's `provider` when it is a JSON string with at least one character other than space, tab, CR and LF (used as given, spaces included), else the configured `id`; `null`, numbers, booleans, arrays, objects, the empty string and whitespace-only strings are not usable.
7. **Any other status.** The status only says "not a success": the kind comes from the body. If the body parses as a JSON object whose `error` is an object whose `kind` is exactly one of `rate_limit`, `timeout`, `invalid_output`, `unavailable` (case-sensitive), the error has that kind. Anything else (non-JSON, `null`, a string, a number, an array, no `error`, an `error` that is not an object, a `kind` at the top level, an unknown or non-string `kind`, an empty body) is `unavailable`. Other keys (`message`, ...) are ignored.
8. **`retryAfterMs`.** Only the kind `rate_limit` carries it (a `retryAfterMs` in the body of any other kind is dropped). It is the body's `error.retryAfterMs` when that is a JSON number that is an integer `>= 0` (read as "Reading an integer": `1500.0`, `1.5e3`, `-0` are integers, `1e400` is an integer above the cap, `1500.0000000000000001` and `1e-400` are not; `null`, `true`, a string and an array are not numbers); otherwise, the response header `retry-after` (name looked up case-insensitively; when two names differ only in case the last one in the map wins) when its value matches exactly `^[0-9]+$` (no sign, no space, no empty value, no fraction, no other digit script; leading zeros allowed), as that many seconds times 1000 computed exactly; otherwise it is absent. `0` is a value and wins. Both sources are capped at 3,600,000 ms after the exact computation (no 32-bit or 64-bit wrap: `4294967297`, 23-digit integers and `9223372036854776` seconds are all capped). The header fallback applies whenever the body's kind is `rate_limit`, whatever the HTTP status; a `retry-after` header is ignored when the kind is anything else.
9. **JSON.** Every body the client parses is read strictly as RFC 8259, exactly as handler step 6 says: four whitespace characters only, no trimming, a byte order mark or a no-break space is not whitespace, no comments, no trailing commas, no single quotes, no `NaN`, no leading zeros; when a key is repeated the last one wins. A body that is not JSON is handled as the rules above say for each status (`invalid_output` on `200`, `unavailable` otherwise).

## Fixture format

Every file is `contracts/gateway/<name>.json`, exactly `JSON.stringify(fixture, null, 2) + "\n"` (2-space indentation, LF). The top level has `kind` (`handler`, `client` or `limiter`), `name` (equal to the file name without `.json`) and the keys of its kind. File names start with the kind.

### `handler`

```json
{
  "kind": "handler",
  "name": "handler-rate-denied",
  "env": { "GEMINI_API_KEY": "FIXTURE_SERVER_KEY", "GEMINI_MODEL": "fixture-model-1", "ALLOWED_ORIGINS": "https://app.example.test" },
  "request": { "method": "POST", "path": "/v1/complete", "headers": { "cf-connecting-ip": "203.0.113.7" }, "body": { "messages": [{ "role": "user", "content": "hello" }] } },
  "limiterPreload": 10,
  "upstream": [],
  "expect": { "status": 429, "body": { "error": { "kind": "rate_limit", "retryAfterMs": 60000 } }, "headers": { "retry-after": "60" }, "upstreamCalls": 0 }
}
```

| Key | Meaning |
|---|---|
| `env` | `GEMINI_API_KEY?` (absent allowed), `GEMINI_MODEL`, `ALLOWED_ORIGINS` (a string, possibly empty) |
| `request` | `method`; `path` (starts with `/`, may carry a query string; the URL is `https://gateway.example.test` + `path`); `headers` (name to value; names are case-insensitive, fixtures may use any case); `body`: a string (sent as is), an object (sent as its compact JSON text) or `null` (no body) |
| `before?` | a list of requests (same shape as `request`) sent first, in order, through the same handler, limiter and upstream script; their responses are not checked. Fixtures use it for requests that must leave the rate limiter untouched (and once as a positive control) |
| `limiterPreload?` | integer 0 to 10 (default 0): before the request, `check(key, T)` was called this many times and all were allowed; `T` is `now - limiterPreloadAgeMs` |
| `limiterPreloadAgeMs?` | integer 0 to 60,000 (default 0) |
| `limiterPreloadKey?` | the key the preload is applied to; default: the limiter key of the request itself (step 9) |
| `upstream` | the script of the fake upstream (a list, possibly empty): the n-th call of `deps.fetch` in the whole fixture consumes entry n. An entry is `{ status, body?, headers?, bodyThrows? }` (`body` a string sent as is or an object sent as its JSON text; absent means the empty text; `headers` name to value, applied in the order of the object with set semantics, so of two names that differ only in case the last wins; `bodyThrows: true` makes reading the body fail midway) or `{ throws: "timeout" \| "network" }` |
| `expect.status` | the exact status |
| `expect.body?` | the JSON the response body must equal exactly (deep equality: no extra key, no missing key). Absent: the response body must be empty |
| `expect.headers?` | name (case-insensitive) to exact value; the value `null` means "the header must be absent" |
| `expect.upstreamCalls` | `0` or `1`: how many times `deps.fetch` was called |
| `expect.upstream?` | required exactly when `upstreamCalls` is `1`: `{ model, key, maxOutputTokens, contentsCount, systemInstruction?, contents? }`. `model` is the raw model name: the URL must be exactly the base, `encodeURIComponent(model)` and `:generateContent`; `key` the marker found in `x-goog-api-key`; `maxOutputTokens` and `contentsCount` (length of `contents`) come from the body; `systemInstruction`, when listed, is the system text (a string) or `null` for "the key must be absent"; `contents`, when listed, is the exact list of `{ role, text }` of the contents |

### `client`

```json
{
  "kind": "client",
  "name": "client-success",
  "endpoint": "https://gateway.example.test/",
  "request": { "messages": [{ "role": "user", "content": "hello" }] },
  "transport": [{ "status": 200, "body": { "text": "Hi", "provider": "gateway" } }],
  "expect": {
    "result": { "text": "Hi", "provider": "gateway" },
    "requests": [{ "url": "https://gateway.example.test/v1/complete", "method": "POST", "headers": { "content-type": "application/json" }, "body": { "messages": [{ "role": "user", "content": "hello" }] }, "timeoutMs": 25000 }]
  }
}
```

`endpoint`; `id?`, `apiKey?`, `timeoutMs?` (the options of the provider; absent means "not given"); `request` (a `providers` request); `transport`: exactly one entry, `{ status, body?, headers? }` (`body` a string as is or an object as its JSON text, absent = empty text; header names and values are given to the client as written, mixed case, spaces and non-ASCII characters included, in the order of the object) or `{ throws: "timeout" | "network" }`. `expect.result` is `{ text, provider }` or `{ error: { kind, retryAfterMs? } }`; `expect.requests` lists the transport calls the client made (always exactly one): `url`, `method` (always `POST`; Kotlin ignores it), `headers` (the complete map, lowercase names), `body` (the JSON the body text must parse to, compared by deep equality) and `timeoutMs`.

### `limiter`

`{ "kind": "limiter", "name", "limit", "windowMs", "calls": [{ "key", "now" }], "expect": [{ "allowed", "retryAfterMs"? }] }`: a fresh limiter, the calls in order, one expectation per call. `retryAfterMs` is present exactly on denied calls.

## Comparison and harness

- Handler harness: a fresh limiter `createLimiter(10, 60000)` per fixture; the clock `deps.now()` is the constant `1000000`; the preload is applied as the table says; then the `before` requests (if any) are sent, then `request`; `expect` describes the answer to `request`, and `upstreamCalls` and `expect.upstream` count and describe the upstream calls of the whole fixture (a `before` request of this folder reaches the upstream in one fixture only); `deps.fetch` is a fake that records each call (URL, `method`, headers, body) and answers from `upstream` (`throws: "timeout"` rejects with an error whose `name` is `TimeoutError`, `throws: "network"` with a `TypeError`); a call beyond the script fails the fixture with `upstream called more than scripted`. Every upstream call must be a `POST` with exactly the two headers of the Gemini exchange and must receive an `init.signal` that is an `AbortSignal` and is not aborted; the harness checks that for every fixture, `x-ilabs-api-key` absent from the headers included. The harness only scripts a timeout as the scripted `throws: "timeout"`: the handler must not need to see a real clock.
- Response checks, for every handler fixture: `status` exact; the body as `expect.body` says; every header of `expect.headers`; and, whatever the fixture lists, rules R1 (`vary: Origin`, `cache-control: no-store`), R2 (`content-type: application/json` exactly when the body is not empty), R3's `access-control-allow-credentials` absent, R4 (`retry-after` absent unless the status is `429`) and `allow` absent unless the status is `405`, and R5: neither `FIXTURE_SERVER_KEY` nor `FIXTURE_USER_KEY` appears in the body or in any header name or value of the response, and `x-ilabs-api-key` and `x-goog-api-key` are not response headers. `upstreamCalls` exact; `expect.upstream` as the table says.
- Client harness: the fake transport records each request and answers from `transport` (`throws: "timeout"` rejects with the timeout error of the implementation, `"network"` with another error). `expect.result` is compared exactly: `text` and `provider` equal, or `error.kind` equal and `error.retryAfterMs` equal when listed and absent when not listed. `expect.requests` as described above.
- Limiter harness: per call, `allowed` equal and `retryAfterMs` equal when listed, absent when not listed.
- Every file is read, its `name` must equal the file name without `.json`, and the unknown keys, missing keys and wrong types below are rejected on the raw JSON before anything runs.
- Guard: each test asserts `fixtures.length >= 549` over all files of the folder (a test that runs a subset, such as the client fixtures, asserts the count of its kind: handler `>= 381`, client `>= 149`, limiter `>= 19`). A harness aggregates failures: Kotlin reports them together. The counts are lower bounds so that a new fixture does not break the guards; the TypeScript harness also checks that the table below lists exactly the files of the folder and states their counts, so a new fixture needs its row (and the counts) here.

## Malformed fixtures

`runFixture` fails with `invalid fixture: <reason>` (an `Error` in TypeScript, an `IllegalStateException` in Kotlin) when the fixture itself is unusable. The reasons are identical in every harness:

- `unknown fixture kind: <kind>`;
- `unknown key: <key>` (the offending key name only; keys of `env`, `request`, `expect`, an `upstream` entry, a `transport` entry, a call and `expect.upstream` are all checked);
- `missing key: <key>` (a required key is absent);
- `wrong type: <key>` (a value of the wrong JSON type, for example `upstreamCalls` that is not an integer);
- `limiterPreload must be an integer from 0 to 10`;
- `limiterPreloadAgeMs must be an integer from 0 to 60000`;
- `upstreamCalls must be 0 or 1`;
- `expect.upstream is required when upstreamCalls is 1` and `expect.upstream is not allowed when upstreamCalls is 0`;
- `upstream entry <n> has neither status nor throws` (`n` 1-based; `bodyThrows` must be a boolean) and `unknown throw kind: <kind>`;
- `transport needs exactly one entry`;
- `limiter calls and expect differ in length`.

A fixture never relies on these: every fixture of this folder is well formed.

## Clarifications

These make the Rules exact where two implementations could otherwise differ. Several go beyond the design's wording; each says so.

1. **Allowlist entries are validated (beyond the design).** An entry that is not a plain origin is ignored (E4), so a mistaken `*`, `null` or a trailing slash in the variable never opens the Worker: `handler-origin-wildcard-entry-ignored`, `handler-origin-null-entry-ignored`, `handler-origin-entry-with-trailing-slash-ignored`. Entries are trimmed and empty entries dropped, so an empty `Origin` can never match one (`handler-origin-empty-entry-never-matches-empty-origin`, `handler-origin-allowlist-entries-trimmed`). Matching is exact: `handler-origin-case-differs`, `handler-origin-scheme-differs`, `handler-origin-port-differs`, `handler-origin-subdomain-of-allowed`, `handler-origin-allowed-as-prefix`.
2. **Present beats missing.** The presence of the header decides, not its value: an empty `Origin` is `403` (`handler-origin-empty-string`), no header is allowed (`handler-origin-missing-allowed`), also with an empty allowlist (`handler-origin-missing-allowed-with-empty-allowlist`). Native clients send no `Origin`.
3. **Routing before origin (beyond the design).** `404` and `405` are decided before the origin, so a non-allowlisted origin on a wrong path sees `404`, not `403` (`handler-route-404-before-origin`, `handler-route-405-before-origin`); the CORS header rule R3 still applies to them (`handler-route-404-echoes-allowlisted-origin`). The design's table has no `404` and `405`: they use `kind` `unavailable`.
4. **The origin is checked before everything that costs.** A bad origin with a garbage body is `403` (`handler-origin-403-before-body`), with an exhausted limiter is `403` (`handler-origin-403-before-rate-limit`); an invalid body with an exhausted limiter is `400` (`handler-rate-invalid-body-not-limited`, `handler-rate-over-limit-not-limited`); a keyless Worker with an exhausted limiter is `429` (`handler-rate-before-key`), a keyless Worker with an invalid body is `400` (`handler-key-after-validation`). That is the order of the steps.
5. **Content type and unknown keys (beyond the design).** The `Content-Type` of the request is not checked (`handler-body-without-content-type-accepted`, `handler-body-text-plain-accepted`); the origin check, not the content type, is what the gateway relies on. Unknown keys are ignored, never forwarded and never rejected (`handler-model-from-env-not-request`, `handler-key-from-body-ignored`, `handler-key-from-query-ignored`, `handler-shape-message-extra-keys-ignored`).
6. **Sizes (beyond the design's wording).** The body limit counts bytes, the others count UTF-16 code units: `handler-body-exactly-64kib-accepted` (65,536 bytes, valid JSON padded with trailing spaces) is `200` and `handler-body-64kib-plus-one-rejected` (65,537) is `400`; `handler-body-multibyte-counts-bytes` is `400` although every character limit holds, and `handler-body-multibyte-under-byte-limit` is `200` although its bytes exceed its characters three times (so the character limits are not byte limits). `handler-limit-surrogate-pairs-count-two`, `handler-limit-surrogate-pairs-at-limit` and `handler-limit-total-counts-code-units` pin the code unit count (`😀` is 2), per message and in total.
7. **Boundaries.** One message of 8,000 / 8,001 characters: `200` / `400` (`handler-limit-message-8000-accepted`, `handler-limit-message-8001-rejected`). Total of exactly 32,000 / 32,001: `handler-limit-total-32000-accepted`, `handler-limit-total-32001-rejected` (the `system` messages count). The total over many small messages: `handler-limit-50x640-accepted`, `handler-limit-50x641-rejected`. Messages: 0 / 1 / 50 / 51 (`handler-shape-messages-empty`, `handler-shape-one-message-accepted`, `handler-shape-50-messages-accepted`, `handler-shape-51-messages-rejected`). `maxTokens`: 1 and 1,024 accepted, 0 and 1,025 rejected, default 256 (`handler-maxtokens-*`).
8. **Empty content and system-only requests are rejected (beyond the design).** An empty `content` would be an empty upstream part and a request with only `system` messages has no `contents`; both are `400` here instead of an upstream error that would surface as `503` (`handler-shape-content-empty-rejected`, `handler-shape-only-system-rejected`).
9. **`maxTokens` is judged by value.** `256.0` and `1e2` are integers (`handler-maxtokens-float-notation-integer`, `handler-maxtokens-exponent-integer`); `null` is not "absent" (`handler-maxtokens-null-rejected`); a quoted number is not a number (`handler-maxtokens-string-rejected`).
10. **The rate limit counts only requests that reach step 9.** An invalid request is answered `400` even from an exhausted key and costs nothing; preflight, `404`, `405` and `403` cost nothing either (`handler-rate-invalid-body-consumes-nothing`, `handler-rate-over-limit-consumes-nothing`, `handler-rate-preflight-consumes-nothing`, `handler-rate-unknown-path-consumes-nothing`, `handler-rate-wrong-method-consumes-nothing`, `handler-rate-bad-origin-consumes-nothing`, with the positive control `handler-rate-earlier-valid-request-counts`). The limiter key is `cf-connecting-ip` or `unknown`: a missing and an empty header share the `unknown` bucket, `x-forwarded-for` is never used (`handler-rate-missing-ip-shares-unknown-bucket`, `handler-rate-empty-ip-shares-unknown-bucket`, `handler-rate-ignores-x-forwarded-for`); different IPs have separate buckets (`handler-rate-other-ip-not-limited`, `handler-rate-unknown-bucket-separate-from-ips`). The limit applies with a user key as well (`handler-rate-user-key-still-limited`).
11. **`Retry-After` is rounded up (beyond the design: the exact rule).** `ceil(retryAfterMs / 1000)`: `59,500` ms is `60`, `1,001` is `2`, `1,000` is `1`, `999` is `1`, `1` is `1`, `0` is `0` (`handler-rate-retry-after-*`, `handler-upstream-429-*`). `retryAfterMs` itself is never rounded.
12. **Window edge.** A preload `59,999` ms old still denies with `retryAfterMs: 1`; a preload exactly `60,000` ms old is a new window and the request is answered (`handler-rate-retry-after-1ms`, `handler-rate-window-edge-allows`; the limiter fixtures pin the same edge for any window size).
13. **Key resolution.** User key (non-empty header) before server key before nothing (`handler-key-user-replaces-server`, `handler-key-user-without-server-key`, `handler-key-neither-unavailable`). An empty header and an empty `GEMINI_API_KEY` both mean "absent" (`handler-key-user-empty-falls-back-to-server`, `handler-key-server-empty-string-is-no-key`, `handler-key-user-empty-without-server-key`). Header and key lookups are case-insensitive for names (`handler-key-header-name-case-insensitive`).
14. **Only the first candidate is read.** `handler-upstream-first-candidate-only-ok` (the second is blocked: still `200` with the first text), `handler-upstream-second-candidate-text-ignored` (the second text is not appended) and `handler-upstream-first-candidate-blocked` (the second is fine: `502`).
15. **Blocked, empty and unreadable are all `502 invalid_output`, never a crash and never a `200` with empty text:** `handler-upstream-finish-safety`, `handler-upstream-finish-other`, `handler-upstream-finish-lowercase-stop`, `handler-upstream-candidates-empty`, `handler-upstream-no-candidates-key`, `handler-upstream-prompt-blocked`, `handler-upstream-candidate-without-content`, `handler-upstream-empty-text`, `handler-upstream-max-tokens-empty-text`, `handler-upstream-not-json`, `handler-upstream-empty-body`, `handler-upstream-json-array`. A whitespace-only text is text (`handler-upstream-whitespace-text-accepted`).
16. **Upstream statuses.** Only `429` has its own answer; every other non-200 is `503` and an upstream `504` is `503` (`handler-upstream-status-504-is-503`). No upstream header (`retry-after` on a `5xx`) and no upstream body is forwarded (`handler-upstream-500-retry-after-not-forwarded`, `handler-upstream-401-body-not-forwarded`, `handler-upstream-403-user-key-echo-not-forwarded`).
17. **The retry delay is parsed in exact decimal arithmetic and rounded up.** `handler-upstream-429-retry-delay-fraction-rounds-up` (`0.0011s` is 2 ms), `handler-upstream-429-retry-delay-nanoseconds` (`1.000000001s` is 1001 ms), `handler-upstream-429-retry-delay-float-trap` (`2.007s` is 2007 ms, where `2.007 * 1000` in doubles is `2007.0000000000002`), `handler-upstream-429-retry-delay-fractional` (`7.5s`), `handler-upstream-429-retry-delay-subsecond` (`0.25s`: 250 ms, `retry-after: 1`), `handler-upstream-429-retry-delay-zero` (`0s`: 0 is a value). Forms that do not match the pattern are not delays and the search goes on: `handler-upstream-429-retry-delay-without-unit`, `handler-upstream-429-retry-delay-no-leading-digit`, `handler-upstream-429-invalid-retry-delay-falls-back-to-header`. The cap: `handler-upstream-429-retry-delay-capped`, `handler-upstream-429-retry-delay-huge-capped`, `handler-upstream-429-header-capped`.
18. **Source order of the delay.** The body's `RetryInfo` wins over the header (`handler-upstream-429-body-wins-over-header`); the first valid `RetryInfo` among the details counts, wherever it is (`handler-upstream-429-retry-info-after-other-detail`); a detail of another `@type` is not a delay (`handler-upstream-429-other-detail-type-ignored`); an HTTP date header is not a delay (`handler-upstream-429-header-http-date-ignored`); no information gives a plain `429` with no `retryAfterMs` and no `retry-after` (`handler-upstream-429-without-retry-info`, `handler-upstream-429-non-json-body`).
19. **Timeout classification.** `504` only for a timeout of the upstream call; a network failure is `503` (`handler-upstream-timeout`, `handler-upstream-network-failure`). The client mirrors it: a timeout of the transport is `timeout`, anything else `unavailable` (`client-transport-timeout`, `client-transport-network-failure`).
20. **The client reads the kind from the body (beyond the design).** A status other than `200` only says "failure"; `error.kind` of the body names it, and a body that does not name a known kind is `unavailable`: `client-error-kind-comes-from-body` (status 500, body kind `rate_limit`), `client-error-non-json-body`, `client-error-unknown-kind`, `client-error-missing-kind`, `client-error-kind-not-string`, `client-error-body-is-array`, `client-error-empty-body`, `client-error-429-non-json-with-retry-after-header`. Only `200` is success: `client-status-201-is-not-success`, `client-status-204-is-not-success`, `client-status-302-is-not-success`. Gateway statuses map as written: `client-status-400`, `client-status-403`, `client-status-404-non-json`, `client-status-429`, `client-status-502`, `client-status-503`, `client-status-504`.
21. **`retryAfterMs` in the client (beyond the design).** Forwarded for `rate_limit` only (`client-retry-after-dropped-for-other-kinds`); body before header (`client-retry-after-body-wins-over-header`); `0` wins (`client-retry-after-zero-wins-over-header`); an unusable body value (negative, fractional, a string) falls back to the header, then to absent (`client-retry-after-negative-falls-back-to-header`, `client-retry-after-negative-without-header`, `client-retry-after-fractional-ignored`, `client-retry-after-string-ignored`); the header name is looked up case-insensitively (`client-retry-after-header-name-case-insensitive`); an HTTP date is ignored (`client-retry-after-header-http-date-ignored`); both sources are capped (`client-retry-after-body-capped`, `client-retry-after-header-capped`, which also pins "no integer overflow").
22. **`provider` of the result.** The body's non-empty string, otherwise the configured `id`, which defaults to `gateway`: `client-provider-from-response-wins-over-id`, `client-provider-missing-uses-id`, `client-provider-missing-uses-default-id`, `client-provider-empty-uses-id`, `client-provider-not-string-uses-id`, `client-provider-custom-from-response`.
23. **Endpoint normalization.** Every trailing slash is dropped (`client-url-trailing-slash`, `client-url-many-trailing-slashes`); a path prefix is kept (`client-url-path-prefix`, `client-url-path-prefix-trailing-slash`); a local development endpoint with a port works (`client-url-local-dev-endpoint`).
24. **Client request.** Exactly the two headers or one (`client-header-api-key-sent`, `client-header-api-key-empty-not-sent`, the baseline), the key never in the body (`client-header-api-key-sent`), `maxTokens` only when present (`client-body-max-tokens-forwarded`, `client-success`), roles and text verbatim (`client-body-messages-verbatim`), the timeout passed through (`client-timeout-custom`, `client-success`).
25. **A `200` that is not `{ text: string }` is `invalid_output`:** `client-success-text-not-string`, `client-success-text-missing`, `client-success-text-null`, `client-success-not-json`, `client-success-body-is-array`, `client-success-body-is-null`, `client-success-empty-body`; the empty text itself is valid (`client-success-empty-text-accepted`).
26. **Integers are read by exact decimal value, never through a double (ruling R1).** See "Reading an integer". `maxTokens`: `handler-maxtokens-float-notation-integer`, `handler-maxtokens-1024-point-zero`, `handler-maxtokens-exponent-1024`, `handler-maxtokens-exponent-uppercase`, `handler-maxtokens-exponent-shifted-fraction`, `handler-maxtokens-exponent-zero`, `handler-maxtokens-minus-exponent-fraction` are accepted; `handler-maxtokens-near-integer-fraction` (a double reads it as 256), `handler-maxtokens-tiny-exponent-fraction`, `handler-maxtokens-negative-exponent-to-fraction`, `handler-maxtokens-just-over-1024-fraction`, `handler-maxtokens-exponent-overflow`, `handler-maxtokens-exponent-huge-digits` (no memory blow-up for a huge exponent), `handler-maxtokens-minus-zero`, `handler-maxtokens-array`, `handler-maxtokens-object` are 400. `retryAfterMs` in the client: `client-retry-after-body-point-zero-integer`, `client-retry-after-body-exponent-integer`, `client-retry-after-body-uppercase-exponent`, `client-retry-after-body-exponent-shifted`, `client-retry-after-body-minus-zero`, `client-retry-after-body-point-zero-zero` are integers; `client-retry-after-body-near-integer-falls-back`, `client-retry-after-body-tiny-exponent-falls-back`, `client-retry-after-body-small-fraction-exponent-falls-back` are not (the header is used); `client-retry-after-body-exponent-overflow-capped`, `client-retry-after-body-32-bit-wrap-capped`, `client-retry-after-body-2-pow-31-capped`, `client-retry-after-body-23-digits-capped` are integers above the cap and never fall back to the header; `client-retry-after-body-exactly-cap`, `client-retry-after-body-cap-plus-one`, `client-retry-after-body-cap-minus-one` pin the boundary; `client-retry-after-body-null-falls-back`, `client-retry-after-body-true-falls-back`, `client-retry-after-body-array-falls-back`, `client-retry-after-body-object-falls-back` are not numbers.
27. **JSON is strict RFC 8259 for every body the contract parses (ruling R2).** Handler: `handler-body-leading-nbsp`, `handler-body-leading-form-feed`, `handler-body-leading-vertical-tab`, `handler-body-leading-ideographic-space`, `handler-body-trailing-nbsp`, `handler-body-leading-bom` (a BOM is not whitespace), `handler-body-comment`, `handler-body-comment-inside`, `handler-body-trailing-comma`, `handler-body-trailing-comma-array`, `handler-body-single-quotes`, `handler-body-unquoted-keys`, `handler-body-nan-literal`, `handler-body-infinity-literal`, `handler-body-leading-zero-number`, `handler-body-plus-sign-number`, `handler-body-hex-number`, `handler-body-raw-control-char-in-string` are all 400, and `handler-body-json-whitespace-all-four` (the four JSON whitespace characters) is accepted. Duplicate keys, last wins: `handler-body-duplicate-messages-last-wins`, `handler-body-duplicate-messages-last-wins-empty`, `client-success-duplicate-text-key-last-wins`, `client-error-duplicate-kind-last-wins`, `client-retry-after-body-duplicate-key-last-wins`. A `__proto__` key is an ordinary key (`handler-body-top-level-proto-key`). Escapes decode before the limits and the forwarding (`handler-body-escaped-unicode-content`, `handler-body-lone-surrogate-escape-content`). The upstream body is strict too (`handler-upstream-body-bom-prefixed`, `handler-upstream-body-trailing-comma`, `handler-upstream-trailing-garbage-json`). Client: `client-success-trailing-comma`, `client-success-single-quotes`, `client-success-unquoted-key`, `client-success-trailing-text`, `client-success-nan`, `client-success-comment`, `client-success-leading-zero-number`, `client-success-bom-prefix`, `client-success-nbsp-around` are `invalid_output`; `client-error-trailing-comma`, `client-error-bom-prefix`, `client-error-leading-zero-retry-after-is-not-json` are `unavailable`; `client-success-whitespace-around-json` is fine. A byte that is not valid UTF-8 cannot be written in a fixture: the request body case is a unit test (`400`).
28. **Header rules (ruling R3).** A numeric header (`retry-after` from the upstream or the transport) is only `^[0-9]+$`: handler `handler-upstream-429-header-trailing-junk-ignored`, `handler-upstream-429-header-decimal-ignored`, `handler-upstream-429-header-plus-sign-ignored`, `handler-upstream-429-header-negative-ignored`, `handler-upstream-429-header-exponent-ignored`, `handler-upstream-429-header-list-ignored`, `handler-upstream-429-header-hex-ignored`; client `client-retry-after-header-leading-space-ignored`, `client-retry-after-header-trailing-space-ignored`, `client-retry-after-header-plus-sign-ignored`, `client-retry-after-header-empty-ignored`, `client-retry-after-header-decimal-ignored`, `client-retry-after-header-arabic-indic-digit-ignored`, `client-retry-after-header-fullwidth-digit-ignored`, `client-retry-after-header-exponent-ignored`, `client-retry-after-header-negative-ignored`, `client-retry-after-header-trailing-junk-ignored`, `client-retry-after-header-list-ignored`. Leading zeros are compared by value (`handler-upstream-429-header-leading-zeros`, `handler-upstream-429-header-many-leading-zeros`, `client-retry-after-header-leading-zeros`, `client-retry-after-header-23-leading-zeros`, `client-retry-after-header-all-zeros`); `0` is a value (`handler-upstream-429-header-zero-is-a-value`, `client-retry-after-header-zero`, `handler-upstream-429-body-wins-over-zero-header`). The cap applies after an exact multiplication by 1000: `handler-upstream-429-header-exactly-cap`, `handler-upstream-429-header-just-over-cap`, `client-retry-after-header-exactly-cap`, `client-retry-after-header-cap-plus-one-second`, `client-retry-after-header-32-bit-wrap-capped`, `client-retry-after-header-64-bit-wrap-capped`, `client-retry-after-header-2-pow-63-capped`. Names are case-insensitive (`client-retry-after-header-upper-case-name`) and when two names differ only in case the last one wins (`handler-upstream-429-header-name-case-last-wins`, `handler-upstream-429-header-name-case-last-wins-reversed`, `client-retry-after-header-case-duplicates-last-wins`, `client-retry-after-header-case-duplicates-last-wins-reversed`). In the client the fallback ignores the status when the body kind is `rate_limit` (`client-retry-after-header-independent-of-status-503`, `client-retry-after-header-independent-of-status-500-body-wins`) and is ignored for another kind (`client-retry-after-header-ignored-for-other-kind-with-header`). Header values are used as the runtime delivers them: a runtime trims surrounding spaces, so the handler fixtures never put a space around a value, and the client fixtures (where the transport map is given as is) pin that nothing is trimmed.
29. **Allowlist entries (ruling R4).** An entry matches only an Origin that is exactly equal to it, and is valid only in the E4 shape. Invalid, hence ignored: `handler-origin-entry-leading-newline-not-trimmed`, `handler-origin-entry-crlf-not-trimmed`, `handler-origin-entry-nbsp-not-trimmed`, `handler-origin-entry-trailing-slash-same-origin-value`, `handler-origin-entry-empty-port`, `handler-origin-entry-six-digit-port`, `handler-origin-entry-port-zero`, `handler-origin-entry-port-65536`, `handler-origin-entry-port-leading-zero`, `handler-origin-entry-uppercase-scheme`, `handler-origin-entry-uppercase-host`, `handler-origin-entry-uppercase-host-lowercase-origin`, `handler-origin-entry-uppercase-scheme-lowercase-origin`, `handler-origin-entry-wildcard-subdomain-literal`, `handler-origin-entry-userinfo`, `handler-origin-entry-underscore-host`, `handler-origin-entry-query`, `handler-origin-entry-fragment`, `handler-origin-entry-empty-host`, `handler-origin-entry-other-scheme`, `handler-origin-entry-ipv6-uppercase-hex`; the list splits on commas only (`handler-origin-entry-semicolon-list`, `handler-origin-entry-space-separated-second`, `handler-origin-entry-space-separated-first`); valid and exact: `handler-origin-entry-port-65535`, `handler-origin-entry-port-1`, `handler-origin-entry-ipv6-without-port`, `handler-origin-entry-ipv6-dotted-tail`, `handler-origin-entry-localhost-port`, `handler-origin-entry-valid-entry-among-invalid`; no default-port stripping (`handler-origin-entry-explicit-default-port-matches-exactly`, `handler-origin-entry-explicit-default-port-entry-plain-origin`, `handler-origin-entry-plain-entry-origin-with-default-port`). IPv6 hex digits are lowercase because hosts are lowercase and nothing is case-folded (the ruling names lowercase letters for hosts and says no case folding anywhere; the same reading applies to the brackets).
30. **`retryDelay` (ruling R5).** The pattern is `^[0-9]+(\.[0-9]{1,9})?s$`, read as exact decimal seconds and rounded up to a millisecond: `handler-upstream-429-delay-trailing-zero-fraction` (`1.0000s` is valid: four fraction digits are within one to nine; it is 1000 ms), `handler-upstream-429-delay-fraction-001-then-zero`, `handler-upstream-429-delay-nine-digit-tiny-fraction`, `handler-upstream-429-delay-leading-zeros`, `handler-upstream-429-retry-delay-float-trap`. Not delays, so ignored as if absent (here the header takes over): `handler-upstream-429-delay-dot-without-fraction-falls-back-to-header`, `handler-upstream-429-delay-ten-fraction-digits-falls-back-to-header`, `handler-upstream-429-delay-uppercase-unit-falls-back-to-header`, `handler-upstream-429-delay-leading-space-falls-back-to-header`, `handler-upstream-429-delay-trailing-space-falls-back-to-header`, `handler-upstream-429-delay-trailing-newline-falls-back-to-header`, `handler-upstream-429-delay-exponent-falls-back-to-header`, `handler-upstream-429-delay-plus-sign-falls-back-to-header`, `handler-upstream-429-delay-non-ascii-digit-falls-back-to-header`, `handler-upstream-429-delay-empty-falls-back-to-header`, `handler-upstream-429-delay-only-unit-falls-back-to-header`, `handler-upstream-429-delay-number-not-string-falls-back`. The cap boundary: `handler-upstream-429-delay-exactly-cap`, `handler-upstream-429-delay-just-over-cap`, `handler-upstream-429-delay-just-under-cap`. Detail scanning: `handler-upstream-429-invalid-retryinfo-skipped-next-valid-used`, `handler-upstream-429-first-valid-retryinfo-wins`, `handler-upstream-429-detail-not-object-skipped`; the `@type` is exact (`handler-upstream-429-type-suffix-not-retryinfo`, `handler-upstream-429-type-prefix-not-retryinfo`, `handler-upstream-429-type-case-sensitive`); the body shape is required (`handler-upstream-429-details-not-array`, `handler-upstream-429-body-is-array`, `handler-upstream-429-error-is-array`, `handler-upstream-429-retryinfo-at-top-level`, `handler-upstream-429-retryinfo-at-top-level-without-error`).
31. **Limiter keys and eviction (ruling R6).** Keys are opaque strings (`limiter-prototype-property-names-are-plain-keys`); a live window is never evicted (`limiter-live-windows-are-never-evicted`; the volume version with thousands of keys is a unit test); an expired window starts afresh whatever else happened (`limiter-expired-key-after-many-others`); time 0 is an ordinary time (`limiter-first-call-at-time-zero-opens-window`); a limit of 0 denies everything (`limiter-limit-zero-denies-everything`).
32. **`finishReason`, content, unreadable bodies, the model (ruling R7).** JSON `null` counts as absent (`handler-upstream-finish-null-is-absent`); `""`, a number, an array and `FINISH_REASON_UNSPECIFIED` fail (`handler-upstream-finish-empty-string`, `handler-upstream-finish-number`, `handler-upstream-finish-array-of-stop`, `handler-upstream-finish-unspecified`); a missing or non-object `content` and a non-array `parts` are `invalid_output` (`handler-upstream-candidate-without-content`, `handler-upstream-content-is-array`, `handler-upstream-content-null`, `handler-upstream-parts-not-array`, `handler-upstream-parts-null`); odd candidates and parts (`handler-upstream-candidate-is-array`, `handler-upstream-candidate-null`, `handler-upstream-parts-with-null-and-empty-text`, `handler-upstream-body-array-wrapping-candidates`). A body that cannot be read: `handler-upstream-body-unreadable-on-200` (`502`), `handler-upstream-body-unreadable-on-500` (`503`), `handler-upstream-429-body-unreadable-uses-header`, `handler-upstream-429-body-unreadable-without-header`. An empty model (after trimming spaces and tabs) is a deployment error: `handler-model-empty-is-503`, `handler-model-blank-is-503` (no upstream call; the slot is used). The model segment is percent-encoded with `encodeURIComponent` semantics: `handler-model-with-slash-percent-encoded`, `handler-model-with-percent-sign-encoded`, `handler-model-with-space-and-unicode-encoded`, `handler-model-unreserved-marks-not-encoded`.
33. **Path (ruling R8, with one disagreement).** No normalization is added by the contract: `handler-route-double-slash-prefix`, `handler-route-double-slash-inside`, `handler-route-percent-encoded-letter`, `handler-route-semicolon-suffix`, `handler-route-trailing-slash-is-404` are `404`; the query and fragment are ignored (`handler-route-fragment-after-query-ignored`, `handler-route-query-string-ignored`). Dot segments (`/v1/../v1/complete`) cannot be pinned as `404`: the WHATWG URL parser of the runtime resolves them before any handler (and any `Request` object) sees the path, so a handler cannot tell them from the resolved path; the contract says so and pins no fixture. A lying `Content-Length` stays a unit-test rule.
34. **The rate-limit slot (ruling R9).** A request that passes step 8 consumes a slot even when it then ends in `503`: `handler-rate-keyless-request-consumes-slot`, `handler-rate-upstream-failure-consumes-slot`, `handler-rate-keyless-10th-request-is-503-not-429`; requests rejected at steps 1 to 8 consume nothing (`handler-rate-invalid-body-consumes-nothing` and its siblings).
35. **Timeout observability (ruling R10).** The harness checks that every upstream call receives a live `init.signal`; timeouts are detected from the scripted `throws: "timeout"` only. That the signal fires after 20,000 ms, the `AbortError` name and the rule that other errors (even with "timeout" in the message) are network failures are unit tests.
36. **Client request and result fields (ruling R11).** A whitespace-only `apiKey` is absent and any other is sent as given (`client-header-api-key-whitespace-only-not-sent`, `client-header-api-key-tab-newline-not-sent`, `client-header-api-key-with-spaces-sent-verbatim`). The client forwards what it is given (`client-body-bogus-role-and-empty-content-forwarded`, `client-body-max-tokens-5000-forwarded`, `client-body-max-tokens-negative-forwarded`, `client-body-empty-messages-forwarded`, `client-body-unicode-content-verbatim`). `provider` must be a string with a non-whitespace character: `client-provider-whitespace-only-uses-id`, `client-provider-null-uses-id`, `client-provider-true-uses-id`, `client-provider-array-uses-id`, `client-provider-object-uses-id`, `client-provider-with-spaces-kept-verbatim`. `text` stays as given (`client-success-text-verbatim`) and must be a string (`client-success-text-true`, `client-success-text-array`, `client-success-text-object`). A `200` carrying only an `error` object is `invalid_output`, extra keys are ignored (`client-success-error-object-only`, `client-success-extra-keys-ignored`). Error bodies that are not an object with an `error` object holding a known `kind` are `unavailable`: `client-error-kind-at-top-level`, `client-error-kind-wrong-case`, `client-error-error-is-string`, `client-error-error-is-array-of-objects`, `client-error-error-is-null`, `client-error-body-is-null`, `client-error-body-is-string`, `client-error-body-is-number`, `client-error-body-is-true`.
37. **More upstream statuses and small mappings (ruling R12).** `408`, `422`, `499`, `502`, `524` and a `301` that carries `retry-after` and `location` are all `503` with no `retry-after` (`handler-upstream-status-408-is-503`, `handler-upstream-status-422-is-503`, `handler-upstream-status-499-is-503`, `handler-upstream-status-502-is-503`, `handler-upstream-status-524-is-503`, `handler-upstream-status-301-with-retry-after-is-503`). Request keys that look like Gemini fields never reach the upstream (`handler-top-level-gemini-keys-ignored`, `handler-message-level-parts-key-ignored`); content is forwarded as given (`handler-content-single-space-accepted`, `handler-content-single-newline-accepted`, `handler-content-no-normalization`); roles are exact (`handler-shape-role-leading-space`, `handler-shape-role-trailing-newline`, `handler-shape-role-model`); system messages obey the per-message limit (`handler-limit-system-message-8000-accepted`, `handler-limit-system-message-8001-rejected`) and are joined in order wherever they are (`handler-map-system-last-and-interleaved`); an `OPTIONS` with a 70,000-byte body is still `204` (`handler-preflight-oversized-body`, and `handler-body-oversized-garbage-is-400` for the `POST`); limiter keys keep their case (`handler-rate-ipv6-case-sensitive`) and a literal `unknown` header shares the unknown bucket (`handler-rate-literal-unknown-ip-header-shares-bucket`).
38. **Client review, R1.** A client lets any error that is not a transport timeout or a transport failure (any `Exception`/`Error` in TypeScript that the transport throws) map to `unavailable`. A Kotlin client additionally never intercepts `CancellationException` (it is rethrown unchanged) and never intercepts a JVM `Error`. A TypeScript client has no cancellation to propagate: an `AbortError` thrown by the transport is a transport failure, and maps to `unavailable` unless the transport converts it to `TransportTimeoutError`.
39. **Client review, R2.** A client builds the request body before it calls the transport. A failure while building the body (for example an unserializable message) is a programming error and is thrown to the caller, never mapped to `unavailable`.
40. **Client review, R3.** `timeoutMs` is a positive integer number of milliseconds (TypeScript: a safe integer greater than 0). A client rejects any other value when it is constructed.
41. **Client review, R4.** A missing or null `apiKey` means no key. The `x-ilabs-api-key` header is sent only when the key contains at least one character other than space, tab, CR and LF.
42. **Client review, R5.** `maxTokens`, when present, is a finite integer. A client rejects NaN, infinities and non-integers before sending. A null `maxTokens` is treated as absent.
43. **Client review, R6.** The body is compact JSON with the member order `messages`, then `maxTokens` when present, with each message as `role` then `content`. A string is escaped with `\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, and `\u00XX` in lowercase hex for every other character below U+0020 and for each unpaired surrogate (`\ud800` style). Characters from U+0020 on are written as UTF-8 unescaped, including DEL and U+2028.
44. **Client review, R7.** A transport reports a timeout by throwing `TransportTimeoutError` (`TransportTimeoutException`). The client does not interpret any other error, including platform timeout types.
45. **Client review, R8.** A response body that starts with a byte order mark is invalid JSON, so it is `invalid_output`.
46. **Client review, R9.** The response header map is iterated in arrival order. When a name occurs more than once, the last occurrence wins; a transport that cannot preserve arrival order must merge duplicates itself.
47. **Client review, R10.** Implementations must read the response in time linear in its size: reading a number or a header must not backtrack.

## Pinned by unit tests, not fixtures

- The Worker never throws: `handle` returns a `Response` for any `Request` (a property-style loop over random methods, paths, header sets and bodies, valid JSON or not); an unexpected internal error is `503` `unavailable` with the usual error body.
- The limiter keeps memory bounded: after 100,000 distinct keys whose windows have expired, the number of stored windows is small (expired windows are evicted on use); a denied call does not grow it; a key used again after expiry starts a new window.
- Rate-limit slots, in volume: ten preflights, ten `404`s, ten `405`s, ten `403`s and ten `400`s from one IP followed by ten valid requests from the same IP are all answered; the eleventh valid one is `429` (the fixtures pin one cheap request each).
- Neither key ever appears in any response body or header across the whole fixture run (the harness check above, asserted over every fixture), nor in any log line the Worker writes.
- The upstream call is made with `AbortSignal.timeout(20_000)` (or an equivalent 20,000 ms signal) through `deps.fetch`; the handler makes at most one `deps.fetch` call per request.
- `Content-Length` is not consulted: a lying header does not change the decision (a Workers runtime may overwrite the header anyway, so no fixture carries one).
- `HttpProvider` options: an `endpoint` that is empty or only slashes is rejected at construction (`RangeError` in TypeScript, `IllegalArgumentException` in Kotlin), as is `timeoutMs <= 0`; a `CancellationException` (Kotlin) or any non-transport error is not mapped, it propagates unchanged; the request object passed in is not mutated.
- `TransportTimeoutError` / `TransportTimeoutException` are the only errors that mean `timeout`; a transport error whose message mentions a timeout but is another type is `unavailable`.
- A request body that is not valid UTF-8 (a lone `0xFF` byte, a truncated multi-byte sequence) is `400` `invalid_output`; a fixture cannot hold it.
- The upstream call receives an `AbortSignal` that fires at 20,000 ms (checked with a fake timer where the runtime allows); a rejection named `AbortError` is `504` `timeout` like `TimeoutError`; any other rejection, whatever its message says (`fetch failed: connect timeout`), is `503` `unavailable`.
- The limiter map stays small after 100,000 expired keys while never dropping a live window (the volume version of `limiter-live-windows-are-never-evicted`, with thousands of live keys).
- `HttpProvider`: `id` absent is `gateway`, an empty `id` is rejected at construction like an empty endpoint; the object handed to `complete` carries no key beyond `messages` and `maxTokens` into the body even when it has more (TypeScript); the transport `headers` and `body` are never null.
- The default `id` is `gateway` and the default timeout is 25,000 ms (`client-success` pins the timeout, `client-provider-missing-uses-default-id` the id).

## Worked examples

**Retry delay (`handler-upstream-429-retry-delay-fraction-rounds-up`).** The upstream answers `429` with `details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "0.0011s" }]`. `I = 0`, `F = 0011`, `first3 = 001`, `rest = 1` (a digit other than `0`), so `ms = 0 * 1000 + 1 + 1 = 2`. The gateway answers `429`, header `retry-after: 1` (`ceil(2 / 1000)`), body `{ "error": { "kind": "rate_limit", "retryAfterMs": 2 } }`.

**Limiter window (`limiter-late-call-starts-new-window-at-its-time`).** `limit = 1`, `windowMs = 1000`. At `0` the key opens the window `{ start: 0, count: 0 }` and is allowed (`count` 1). At `2500` the window has expired (`2500 >= 0 + 1000`), so a new window starts at `2500` and the call is allowed. At `3400` the window `{ start: 2500, count: 1 }` is full: denied with `retryAfterMs = 2500 + 1000 - 3400 = 100`. At `3500` (`>= 3500`) a new window starts: allowed.

**Preload (`handler-rate-retry-after-rounds-up-1001ms`).** `limiterPreload: 10` at `limiterPreloadAgeMs: 58999` means the window started 58,999 ms before `now` (`1,000,000`); the request is the eleventh call: `retryAfterMs = (941001 + 60000) - 1000000 = 1001` and `retry-after: 2`.

**Client failure (`client-error-kind-comes-from-body`).** The transport answers status `500` with the body `{"error":{"kind":"rate_limit"}}` and no `retry-after` header: the result is `{ error: { kind: "rate_limit" } }`, with no `retryAfterMs`.

## Fixtures

549 fixtures: 381 `handler`, 149 `client`, 19 `limiter`. Each fixture pins one rule (the rows say which); a few rows say they pin an order by breaking two rules at once.

| Fixture | Kind | Rule it pins |
|---|---|---|
| `handler-route-baseline-ok` | `handler` | baseline: a valid request is answered 200 with vary and no CORS header |
| `handler-route-unknown-path` | `handler` | a path other than /v1/complete is 404 unavailable (step 1) |
| `handler-route-trailing-slash-is-404` | `handler` | no trailing-slash normalization: /v1/complete/ is 404 |
| `handler-route-root-is-404` | `handler` | the root path is 404 |
| `handler-route-path-case-sensitive` | `handler` | the path is case-sensitive: /V1/complete is 404 |
| `handler-route-query-string-ignored` | `handler` | the query string is not part of the path: /v1/complete?debug=1 is served |
| `handler-route-get-is-405` | `handler` | GET is 405 unavailable with allow: POST, OPTIONS (step 2) |
| `handler-route-put-is-405` | `handler` | PUT is 405 |
| `handler-route-head-is-405` | `handler` | HEAD is 405 with an empty-bodied request |
| `handler-route-path-checked-before-method` | `handler` | path before method: GET /nope is 404, not 405 |
| `handler-route-404-before-origin` | `handler` | path before origin: a bad origin on a wrong path sees 404 and no CORS header |
| `handler-route-405-before-origin` | `handler` | method before origin: a bad origin with GET sees 405 |
| `handler-route-404-echoes-allowlisted-origin` | `handler` | CORS rule R3 holds for every status: a 404 for an allowlisted origin echoes it |
| `handler-origin-missing-allowed` | `handler` | no Origin header (native clients, curl) is allowed and gets no CORS header |
| `handler-origin-allowlisted-echoed` | `handler` | an allowlisted Origin is echoed exactly in access-control-allow-origin |
| `handler-origin-second-entry-echoed` | `handler` | every entry of the list is matched, not only the first |
| `handler-origin-header-name-case-insensitive` | `handler` | the Origin header name is case-insensitive |
| `handler-origin-not-allowlisted` | `handler` | a non-allowlisted Origin is 403 unavailable with no CORS header, no upstream call (step 3) |
| `handler-origin-empty-string` | `handler` | an empty Origin value is present and not allowlisted: 403, never 'missing' |
| `handler-origin-null-string` | `handler` | the Origin value null is not allowlisted: 403 |
| `handler-origin-trailing-slash` | `handler` | an Origin with a trailing slash is not the allowlisted origin: 403 |
| `handler-origin-with-path` | `handler` | an Origin with a path is not allowlisted: 403 |
| `handler-origin-case-differs` | `handler` | origins are compared case-sensitively: another host case is 403 |
| `handler-origin-scheme-differs` | `handler` | another scheme is 403 |
| `handler-origin-port-differs` | `handler` | another port is 403 |
| `handler-origin-subdomain-of-allowed` | `handler` | a subdomain of an allowlisted host is not allowlisted |
| `handler-origin-allowed-as-prefix` | `handler` | an Origin that merely starts with an allowlisted origin is not allowlisted |
| `handler-origin-wildcard-entry-ignored` | `handler` | an allowlist entry * is ignored: no wildcards (E4) |
| `handler-origin-null-entry-ignored` | `handler` | an allowlist entry null never allows the Origin null (E4) |
| `handler-origin-entry-with-trailing-slash-ignored` | `handler` | an allowlist entry with a trailing slash is invalid and ignored, so the plain origin is not allowed either |
| `handler-origin-empty-allowlist` | `handler` | an empty allowlist allows no Origin |
| `handler-origin-missing-allowed-with-empty-allowlist` | `handler` | an empty allowlist still serves requests without Origin |
| `handler-origin-empty-entry-never-matches-empty-origin` | `handler` | empty list entries are dropped, so an empty Origin never matches one |
| `handler-origin-allowlist-entries-trimmed` | `handler` | list entries are trimmed of spaces and tabs |
| `handler-origin-ipv6-entry` | `handler` | a bracketed IPv6 origin is a plain origin and can be allowlisted |
| `handler-origin-403-before-body` | `handler` | order: a bad origin with an unparsable body is 403, not 400 |
| `handler-origin-403-before-rate-limit` | `handler` | order: a bad origin with an exhausted limiter is 403, not 429 |
| `handler-preflight-allowlisted` | `handler` | OPTIONS from an allowlisted origin is 204, empty body, echoes the origin and lists methods, headers and max age (step 4) |
| `handler-preflight-without-origin` | `handler` | OPTIONS without Origin is also 204, with no allow-origin header |
| `handler-preflight-bad-origin` | `handler` | OPTIONS from a non-allowlisted origin is 403, not 204 |
| `handler-preflight-not-rate-limited` | `handler` | a preflight is answered even when the client exhausted its limit |
| `handler-preflight-ignores-body` | `handler` | a preflight never reads its body |
| `handler-preflight-other-path-404` | `handler` | OPTIONS on another path is 404 (path before method) |
| `handler-preflight-no-credentials-header` | `handler` | the preflight never sends access-control-allow-credentials |
| `handler-body-null-is-empty` | `handler` | no body is an empty body: 400 |
| `handler-body-empty-string` | `handler` | an empty body text is 400 |
| `handler-body-not-json` | `handler` | text that is not JSON is 400 |
| `handler-body-truncated-json` | `handler` | truncated JSON is 400 |
| `handler-body-trailing-garbage` | `handler` | text after the JSON value is 400 |
| `handler-body-json-array` | `handler` | a top-level array is 400 |
| `handler-body-json-null` | `handler` | a top-level null is 400 |
| `handler-body-json-string` | `handler` | a top-level string is 400 |
| `handler-body-json-number` | `handler` | a top-level number is 400 |
| `handler-body-exactly-64kib-accepted` | `handler` | a body of exactly 65,536 bytes is accepted (step 5) |
| `handler-body-64kib-plus-one-rejected` | `handler` | a body of 65,537 bytes is 400 with no upstream call |
| `handler-body-multibyte-counts-bytes` | `handler` | the body limit counts bytes: 22,000 three-byte characters exceed it though every character limit holds |
| `handler-body-multibyte-under-byte-limit` | `handler` | 21,000 three-byte characters in three messages are accepted: character limits are not byte limits |
| `handler-body-leading-whitespace-accepted` | `handler` | whitespace around the JSON value is fine |
| `handler-body-without-content-type-accepted` | `handler` | the request Content-Type is not checked: a missing one is accepted |
| `handler-body-text-plain-accepted` | `handler` | a text/plain Content-Type is accepted too |
| `handler-model-from-env-not-request` | `handler` | the model is GEMINI_MODEL; a model key in the request is ignored |
| `handler-model-from-env` | `handler` | the upstream URL uses GEMINI_MODEL as written |
| `handler-shape-missing-messages` | `handler` | an object without messages is 400 (step 7) |
| `handler-shape-messages-not-array-string` | `handler` | messages that is a string is 400 |
| `handler-shape-messages-not-array-object` | `handler` | messages that is an object is 400 |
| `handler-shape-messages-null` | `handler` | messages that is null is 400 |
| `handler-shape-messages-empty` | `handler` | an empty messages array is 400 |
| `handler-shape-one-message-accepted` | `handler` | exactly one message is accepted |
| `handler-shape-50-messages-accepted` | `handler` | exactly 50 messages are accepted |
| `handler-shape-51-messages-rejected` | `handler` | 51 messages are 400 |
| `handler-shape-message-is-string` | `handler` | a message that is a string is 400 |
| `handler-shape-message-is-null` | `handler` | a message that is null is 400 |
| `handler-shape-message-is-array` | `handler` | a message that is an array is 400 |
| `handler-shape-role-unknown` | `handler` | a role outside the three is 400 |
| `handler-shape-role-case-sensitive` | `handler` | roles are case-sensitive: User is 400 |
| `handler-shape-role-missing` | `handler` | a message without role is 400 |
| `handler-shape-role-not-string` | `handler` | a role that is not a string is 400 |
| `handler-shape-content-missing` | `handler` | a message without content is 400 |
| `handler-shape-content-number` | `handler` | content that is a number is 400 |
| `handler-shape-content-null` | `handler` | content that is null is 400 |
| `handler-shape-content-parts-array` | `handler` | content in the parts style (an array) is 400 |
| `handler-shape-content-empty-rejected` | `handler` | an empty content is 400 (clarification 8) |
| `handler-shape-only-system-rejected` | `handler` | a request with only system messages is 400 (clarification 8) |
| `handler-shape-assistant-only-accepted` | `handler` | a request whose only message is from the assistant has contents and is accepted |
| `handler-shape-message-extra-keys-ignored` | `handler` | unknown keys inside a message are ignored |
| `handler-shape-extra-top-level-keys-ignored` | `handler` | unknown top-level keys are ignored |
| `handler-maxtokens-default` | `handler` | an absent maxTokens is 256 |
| `handler-maxtokens-forwarded` | `handler` | a valid maxTokens is the upstream maxOutputTokens |
| `handler-maxtokens-1-accepted` | `handler` | maxTokens 1 is accepted |
| `handler-maxtokens-1024-accepted` | `handler` | maxTokens 1,024 is accepted |
| `handler-maxtokens-0-rejected` | `handler` | maxTokens 0 is 400 |
| `handler-maxtokens-1025-rejected` | `handler` | maxTokens 1,025 is 400, not clamped |
| `handler-maxtokens-negative-rejected` | `handler` | maxTokens -1 is 400 |
| `handler-maxtokens-fraction-rejected` | `handler` | maxTokens 1.5 is 400 |
| `handler-maxtokens-string-rejected` | `handler` | a quoted maxTokens is 400 |
| `handler-maxtokens-null-rejected` | `handler` | maxTokens null is 400, not 'absent' |
| `handler-maxtokens-boolean-rejected` | `handler` | maxTokens true is 400 |
| `handler-maxtokens-huge-rejected` | `handler` | a very large maxTokens is 400 |
| `handler-maxtokens-float-notation-integer` | `handler` | 256.0 is an integer by value and accepted |
| `handler-maxtokens-exponent-integer` | `handler` | 1e2 is an integer by value (100) |
| `handler-limit-message-8000-accepted` | `handler` | one message of exactly 8,000 characters is accepted (step 8) |
| `handler-limit-message-8001-rejected` | `handler` | one message of 8,001 characters is 400 |
| `handler-limit-total-32000-accepted` | `handler` | a total of exactly 32,000 characters over four messages (one system) is accepted |
| `handler-limit-total-32001-rejected` | `handler` | a total of 32,001 characters is 400: system messages count |
| `handler-limit-total-counts-code-units` | `handler` | the total counts UTF-16 code units: four messages of 4,000 emoji plus one emoji are 32,002 units (16,001 code points): 400 |
| `handler-limit-50x640-accepted` | `handler` | 50 messages of 640 characters (32,000 in total) are accepted |
| `handler-limit-50x641-rejected` | `handler` | 50 messages of 641 characters (32,050) are 400: the total is over all messages |
| `handler-limit-surrogate-pairs-count-two` | `handler` | 4,001 emoji are 8,002 UTF-16 code units: 400 |
| `handler-limit-surrogate-pairs-at-limit` | `handler` | 4,000 emoji are exactly 8,000 code units: accepted |
| `handler-rate-10th-request-accepted` | `handler` | the 10th request of the window is answered (preload 9) |
| `handler-rate-11th-request-denied` | `handler` | the 11th request is 429 with retryAfterMs 60000 and retry-after 60 (step 9) |
| `handler-rate-retry-after-rounds-up-500ms-age` | `handler` | age 500 ms: retryAfterMs 59500, retry-after 60 |
| `handler-rate-retry-after-rounds-up-1001ms` | `handler` | age 58,999 ms: retryAfterMs 1001, retry-after rounds up to 2 |
| `handler-rate-retry-after-exact-1000ms` | `handler` | age 59,000 ms: retryAfterMs 1000, retry-after exactly 1 |
| `handler-rate-retry-after-999ms` | `handler` | age 59,001 ms: retryAfterMs 999, retry-after rounds up to 1 |
| `handler-rate-retry-after-1ms` | `handler` | age 59,999 ms: still denied, retryAfterMs 1, retry-after 1 |
| `handler-rate-window-edge-allows` | `handler` | age exactly 60,000 ms: the window has ended and the request is answered |
| `handler-rate-other-ip-not-limited` | `handler` | another IP has its own bucket |
| `handler-rate-missing-ip-shares-unknown-bucket` | `handler` | no cf-connecting-ip: the unknown bucket, here exhausted |
| `handler-rate-empty-ip-shares-unknown-bucket` | `handler` | an empty cf-connecting-ip is the unknown bucket as well |
| `handler-rate-unknown-bucket-separate-from-ips` | `handler` | the unknown bucket is not any IP's bucket: exhausting an IP does not limit requests without the header |
| `handler-rate-ignores-x-forwarded-for` | `handler` | x-forwarded-for is never the limiter key: the request is in the unknown bucket |
| `handler-rate-invalid-body-consumes-nothing` | `handler` | an invalid request earlier in the window does not consume a slot (preload 9, then one invalid, then the 10th valid is answered) |
| `handler-rate-over-limit-consumes-nothing` | `handler` | an over-limit request earlier does not consume a slot |
| `handler-rate-preflight-consumes-nothing` | `handler` | a preflight earlier does not consume a slot |
| `handler-rate-unknown-path-consumes-nothing` | `handler` | a 404 earlier does not consume a slot |
| `handler-rate-wrong-method-consumes-nothing` | `handler` | a 405 earlier does not consume a slot |
| `handler-rate-bad-origin-consumes-nothing` | `handler` | a 403 earlier does not consume a slot |
| `handler-rate-earlier-valid-request-counts` | `handler` | positive control for the before list: an earlier valid request is counted (preload 9 + it = 10, so the next one is 429); its upstream call is the one counted |
| `handler-rate-invalid-body-not-limited` | `handler` | an invalid body from an exhausted client is 400: validation comes first |
| `handler-rate-over-limit-not-limited` | `handler` | an over-limit message from an exhausted client is 400 |
| `handler-rate-before-key` | `handler` | an exhausted client without any key is 429, not 503: the limiter comes before the key |
| `handler-rate-user-key-still-limited` | `handler` | a user key does not bypass the limiter |
| `handler-rate-response-carries-cors` | `handler` | a 429 for an allowlisted origin echoes it and carries vary |
| `handler-key-server-key-used` | `handler` | the server key is used when there is no user key |
| `handler-key-user-replaces-server` | `handler` | a user key replaces the server key for the call (step 10) |
| `handler-key-user-without-server-key` | `handler` | a user key works when the Worker has no server key |
| `handler-key-neither-unavailable` | `handler` | no server key and no user key is 503 unavailable with no upstream call |
| `handler-key-server-empty-string-is-no-key` | `handler` | an empty GEMINI_API_KEY is no key |
| `handler-key-user-empty-falls-back-to-server` | `handler` | an empty x-ilabs-api-key is no user key: the server key is used |
| `handler-key-user-empty-without-server-key` | `handler` | an empty user key and no server key is 503 |
| `handler-key-header-name-case-insensitive` | `handler` | the header name x-ilabs-api-key is case-insensitive |
| `handler-key-after-validation` | `handler` | an invalid body with no key is 400: validation comes before the key |
| `handler-key-from-body-ignored` | `handler` | a key in the request body is never used |
| `handler-key-from-query-ignored` | `handler` | a key in the query string is never used |
| `handler-key-user-key-not-echoed-on-upstream-401` | `handler` | an upstream 401 that echoes the user key is 503 with the plain error body |
| `handler-map-system-instruction` | `handler` | one system message becomes systemInstruction; the rest becomes contents |
| `handler-map-system-messages-joined` | `handler` | system messages are joined with two newlines, wherever they are |
| `handler-map-assistant-becomes-model` | `handler` | assistant becomes the role model; user stays user |
| `handler-map-no-system-no-instruction` | `handler` | without a system message the systemInstruction key is absent |
| `handler-map-consecutive-roles-not-merged` | `handler` | two user messages in a row stay two contents |
| `handler-map-content-verbatim` | `handler` | content is forwarded verbatim: spaces, newlines and emoji are kept |
| `handler-upstream-multiple-parts-concatenated` | `handler` | the text is the parts concatenated with no separator |
| `handler-upstream-parts-without-text-skipped` | `handler` | parts without a string text are skipped |
| `handler-upstream-finish-max-tokens-accepted` | `handler` | MAX_TOKENS with text is a success |
| `handler-upstream-finish-absent-accepted` | `handler` | an absent finishReason is a success |
| `handler-upstream-whitespace-text-accepted` | `handler` | a whitespace-only text is text |
| `handler-upstream-first-candidate-only-ok` | `handler` | only candidates[0] is read: a blocked second candidate does not matter |
| `handler-upstream-second-candidate-text-ignored` | `handler` | only candidates[0] is read: the text of a second candidate is not appended |
| `handler-upstream-first-candidate-blocked` | `handler` | only candidates[0] is read: a blocked first candidate fails though the second is fine |
| `handler-upstream-finish-safety` | `handler` | finishReason SAFETY is 502 invalid_output |
| `handler-upstream-finish-other` | `handler` | finishReason OTHER is 502 |
| `handler-upstream-finish-lowercase-stop` | `handler` | finishReason is case-sensitive: stop is 502 |
| `handler-upstream-candidates-empty` | `handler` | candidates: [] is 502 |
| `handler-upstream-no-candidates-key` | `handler` | an object without candidates is 502 |
| `handler-upstream-prompt-blocked` | `handler` | a blocked prompt (promptFeedback, no candidates) is 502 |
| `handler-upstream-candidates-not-array` | `handler` | candidates that is not an array is 502 |
| `handler-upstream-candidate-without-content` | `handler` | a candidate without content has empty text: 502 |
| `handler-upstream-parts-not-array` | `handler` | parts that is not an array is empty text: 502 |
| `handler-upstream-text-not-string` | `handler` | a part whose text is not a string is skipped, leaving empty text: 502 |
| `handler-upstream-empty-text` | `handler` | an empty text is 502, never a 200 with empty text |
| `handler-upstream-max-tokens-empty-text` | `handler` | MAX_TOKENS that produced nothing is 502 |
| `handler-upstream-not-json` | `handler` | a 200 whose body is not JSON is 502 |
| `handler-upstream-empty-body` | `handler` | a 200 with an empty body is 502 |
| `handler-upstream-json-array` | `handler` | a 200 whose body is a JSON array is 502 |
| `handler-upstream-429-retry-delay-whole-seconds` | `handler` | RetryInfo 7s is 7000 ms, retry-after 7 |
| `handler-upstream-429-retry-delay-fractional` | `handler` | RetryInfo 7.5s is 7500 ms, retry-after rounds up to 8 |
| `handler-upstream-429-retry-delay-subsecond` | `handler` | RetryInfo 0.25s is 250 ms, retry-after 1 |
| `handler-upstream-429-retry-delay-fraction-rounds-up` | `handler` | RetryInfo 0.0011s is 1.1 ms rounded up to 2 ms (exact decimal) |
| `handler-upstream-429-retry-delay-nanoseconds` | `handler` | RetryInfo 1.000000001s is 1001 ms (a trailing digit past the third rounds up) |
| `handler-upstream-429-retry-delay-float-trap` | `handler` | RetryInfo 2.007s is exactly 2007 ms (a floating-point 2.007 * 1000 is 2007.0000000000002 and would round up to 2008), retry-after 3 |
| `handler-upstream-429-retry-delay-zero` | `handler` | RetryInfo 0s is a value: retryAfterMs 0, retry-after 0 |
| `handler-upstream-429-retry-delay-capped` | `handler` | RetryInfo 7200s is capped to 3,600,000 ms, retry-after 3600 |
| `handler-upstream-429-retry-delay-huge-capped` | `handler` | a retryDelay of twenty digits is capped without overflow |
| `handler-upstream-429-header-only` | `handler` | no body info: the retry-after header in seconds gives 30,000 ms |
| `handler-upstream-429-body-wins-over-header` | `handler` | RetryInfo is used before the header |
| `handler-upstream-429-invalid-retry-delay-falls-back-to-header` | `handler` | an invalid retryDelay is skipped and the header is used |
| `handler-upstream-429-retry-delay-without-unit` | `handler` | retryDelay 7 (no s) is not a delay |
| `handler-upstream-429-retry-delay-no-leading-digit` | `handler` | retryDelay .5s is not a delay (the pattern needs digits first) |
| `handler-upstream-429-retry-delay-negative` | `handler` | retryDelay -1s is not a delay |
| `handler-upstream-429-header-capped` | `handler` | a retry-after header of twenty digits is capped without overflow |
| `handler-upstream-429-header-http-date-ignored` | `handler` | an HTTP-date retry-after is not a delay |
| `handler-upstream-429-without-retry-info` | `handler` | a 429 with no delay information is a plain rate_limit with no retryAfterMs and no retry-after |
| `handler-upstream-429-non-json-body` | `handler` | a 429 whose body is not JSON is a plain rate_limit |
| `handler-upstream-429-retry-info-after-other-detail` | `handler` | the first valid RetryInfo counts wherever it is among the details |
| `handler-upstream-429-other-detail-type-ignored` | `handler` | a detail of another @type is not a delay even with a retryDelay |
| `handler-upstream-status-400-is-503` | `handler` | an upstream 400 is 503 unavailable |
| `handler-upstream-status-401-is-503` | `handler` | an upstream 401 is 503 |
| `handler-upstream-status-403-is-503` | `handler` | an upstream 403 is 503 |
| `handler-upstream-status-404-is-503` | `handler` | an upstream 404 (unknown model) is 503 |
| `handler-upstream-status-500-is-503` | `handler` | an upstream 500 is 503 |
| `handler-upstream-status-503-is-503` | `handler` | an upstream 503 is 503 |
| `handler-upstream-status-504-is-503` | `handler` | an upstream 504 is 503: 504 is only the gateway's own timeout |
| `handler-upstream-status-204-is-503` | `handler` | an upstream 2xx other than 200 is 503 |
| `handler-upstream-status-302-is-503` | `handler` | an upstream redirect is 503 |
| `handler-upstream-401-body-not-forwarded` | `handler` | an upstream error body is never forwarded: the answer is exactly the plain error |
| `handler-upstream-403-user-key-echo-not-forwarded` | `handler` | an upstream 403 echoing the user key is answered without it |
| `handler-upstream-500-retry-after-not-forwarded` | `handler` | an upstream retry-after on a 5xx is neither forwarded nor turned into retryAfterMs |
| `handler-upstream-timeout` | `handler` | the upstream call timing out is 504 timeout |
| `handler-upstream-network-failure` | `handler` | a network failure is 503 unavailable |
| `limiter-deny-after-limit` | `limiter` | the (limit+1)th call inside the window is denied with the whole window as retryAfterMs |
| `limiter-retry-after-arithmetic` | `limiter` | retryAfterMs is start + windowMs - now |
| `limiter-window-edge-999-denied-1000-allowed` | `limiter` | now = start + windowMs - 1 is denied with 1; now = start + windowMs starts a new window |
| `limiter-denied-call-does-not-move-window` | `limiter` | a denied call changes nothing: the window still ends at start + windowMs |
| `limiter-window-starts-at-first-call` | `limiter` | the window starts at the first call, not at an aligned boundary |
| `limiter-new-window-resets-count` | `limiter` | a new window starts from zero |
| `limiter-keys-are-independent` | `limiter` | each key has its own window |
| `limiter-keys-are-case-sensitive` | `limiter` | keys are exact strings |
| `limiter-late-call-starts-new-window-at-its-time` | `limiter` | after a long gap the new window starts at the late call's own time |
| `limiter-window-of-one-millisecond` | `limiter` | a window of 1 ms: the second call at the same time is denied with 1, the next ms is a new window |
| `limiter-large-epoch-times` | `limiter` | epoch-sized times: the arithmetic and the edge hold |
| `limiter-ten-per-minute` | `limiter` | the production constants: 10 per 60,000 ms, the 11th denied until the window ends |
| `limiter-interleaved-keys-own-windows` | `limiter` | keys opened at different times end at different times |
| `limiter-full-count-after-reset` | `limiter` | after a reset the whole limit is available again, and the next call is denied again |
| `client-success` | `client` | baseline: one POST to /v1/complete with the JSON header and the default 25,000 ms timeout, result from the body |
| `client-url-trailing-slash` | `client` | an endpoint with a trailing slash gives the same URL |
| `client-url-many-trailing-slashes` | `client` | every trailing slash is dropped |
| `client-url-path-prefix` | `client` | a path prefix is kept |
| `client-url-path-prefix-trailing-slash` | `client` | a path prefix with a trailing slash gives the same URL |
| `client-url-local-dev-endpoint` | `client` | a local development endpoint with a port |
| `client-header-api-key-sent` | `client` | an apiKey is sent in x-ilabs-api-key and nowhere else (not in the body) |
| `client-header-api-key-empty-not-sent` | `client` | an empty apiKey sends no header |
| `client-body-max-tokens-forwarded` | `client` | maxTokens is forwarded in the body when the request has it |
| `client-body-messages-verbatim` | `client` | roles and texts are forwarded verbatim |
| `client-timeout-custom` | `client` | a configured timeoutMs is passed to the transport |
| `client-provider-from-response-wins-over-id` | `client` | the response's provider wins over the configured id |
| `client-provider-missing-uses-id` | `client` | a response without provider uses the configured id |
| `client-provider-missing-uses-default-id` | `client` | without a configured id the default is gateway |
| `client-provider-empty-uses-id` | `client` | an empty provider string is not used |
| `client-provider-not-string-uses-id` | `client` | a provider that is not a string is not used |
| `client-provider-custom-from-response` | `client` | any non-empty provider string of the response is used |
| `client-success-empty-text-accepted` | `client` | an empty text is a valid text |
| `client-success-text-not-string` | `client` | a 200 whose text is not a string is invalid_output |
| `client-success-text-missing` | `client` | a 200 without text is invalid_output |
| `client-success-text-null` | `client` | a 200 whose text is null is invalid_output |
| `client-success-not-json` | `client` | a 200 that is not JSON is invalid_output |
| `client-success-body-is-array` | `client` | a 200 whose body is a JSON array is invalid_output |
| `client-success-body-is-null` | `client` | a 200 whose body is JSON null is invalid_output |
| `client-success-empty-body` | `client` | a 200 with an empty body is invalid_output |
| `client-status-400` | `client` | 400 with an invalid_output body is invalid_output |
| `client-status-403` | `client` | 403 with an unavailable body is unavailable |
| `client-status-404-non-json` | `client` | 404 with a non-JSON body is unavailable |
| `client-status-429` | `client` | 429 with a rate_limit body and retryAfterMs forwards it |
| `client-status-502` | `client` | 502 with an invalid_output body is invalid_output |
| `client-status-503` | `client` | 503 with an unavailable body is unavailable |
| `client-status-504` | `client` | 504 with a timeout body is timeout |
| `client-status-201-is-not-success` | `client` | only 200 is success: a 201 carrying text is not |
| `client-status-204-is-not-success` | `client` | a 204 with no body is unavailable |
| `client-status-302-is-not-success` | `client` | a redirect is unavailable |
| `client-error-kind-comes-from-body` | `client` | the kind comes from the body, not the status: status 500 with a rate_limit body is rate_limit |
| `client-error-non-json-body` | `client` | an error status with a non-JSON body is unavailable |
| `client-error-unknown-kind` | `client` | an unknown kind is unavailable |
| `client-error-missing-kind` | `client` | an error object without kind is unavailable |
| `client-error-kind-not-string` | `client` | a kind that is not a string is unavailable |
| `client-error-body-is-array` | `client` | an error body that is an array is unavailable |
| `client-error-empty-body` | `client` | an error status with an empty body is unavailable |
| `client-error-429-non-json-with-retry-after-header` | `client` | a 429 whose body is not JSON is unavailable, and its retry-after header is not used |
| `client-error-extra-keys-ignored` | `client` | other keys of the error body (message, details) are ignored |
| `client-retry-after-dropped-for-other-kinds` | `client` | retryAfterMs is forwarded for rate_limit only: a timeout body's value is dropped |
| `client-retry-after-header-fallback` | `client` | without a body value the retry-after header (seconds) gives retryAfterMs |
| `client-retry-after-header-name-case-insensitive` | `client` | the header name is looked up case-insensitively |
| `client-retry-after-body-wins-over-header` | `client` | the body's retryAfterMs wins over the header |
| `client-retry-after-zero-wins-over-header` | `client` | 0 is a value and wins over the header |
| `client-retry-after-negative-falls-back-to-header` | `client` | a negative body value is unusable: the header is used |
| `client-retry-after-negative-without-header` | `client` | a negative body value with no header leaves retryAfterMs absent |
| `client-retry-after-fractional-ignored` | `client` | a fractional retryAfterMs is not an integer: ignored |
| `client-retry-after-string-ignored` | `client` | a retryAfterMs that is a string is ignored |
| `client-retry-after-header-http-date-ignored` | `client` | an HTTP-date retry-after is ignored |
| `client-retry-after-body-capped` | `client` | a body retryAfterMs above 3,600,000 is capped |
| `client-retry-after-header-capped` | `client` | a twenty-digit retry-after header is capped without overflow |
| `client-transport-timeout` | `client` | a transport timeout is the kind timeout, with no retryAfterMs |
| `client-transport-network-failure` | `client` | any other transport failure is unavailable |
| `handler-origin-entry-leading-newline-not-trimmed` | `handler` | only ASCII space and tab are trimmed: an entry with a leading newline is invalid |
| `handler-origin-entry-crlf-not-trimmed` | `handler` | a trailing CR LF is not trimmed: the entry is invalid |
| `handler-origin-entry-nbsp-not-trimmed` | `handler` | a leading no-break space is not trimmed: the entry is invalid |
| `handler-origin-entry-trailing-slash-same-origin-value` | `handler` | an entry with a trailing slash is invalid even when the Origin carries the same slash |
| `handler-origin-entry-empty-port` | `handler` | an entry with an empty port is invalid |
| `handler-origin-entry-six-digit-port` | `handler` | a port of six digits is invalid |
| `handler-origin-entry-port-zero` | `handler` | port 0 is invalid |
| `handler-origin-entry-port-65536` | `handler` | port 65536 is invalid |
| `handler-origin-entry-port-leading-zero` | `handler` | a port with a leading zero is invalid |
| `handler-origin-entry-port-65535` | `handler` | port 65535 is valid |
| `handler-origin-entry-port-1` | `handler` | port 1 is valid |
| `handler-origin-entry-uppercase-scheme` | `handler` | an entry with an uppercase scheme is invalid |
| `handler-origin-entry-uppercase-host` | `handler` | an entry with an uppercase host is invalid: no case folding, hosts are lowercase |
| `handler-origin-entry-uppercase-host-lowercase-origin` | `handler` | no case folding: an uppercase-host entry is invalid and does not match the lowercase Origin either |
| `handler-origin-entry-uppercase-scheme-lowercase-origin` | `handler` | no case folding: an uppercase-scheme entry does not match the lowercase Origin |
| `handler-origin-entry-wildcard-subdomain-literal` | `handler` | a wildcard host is invalid even when the Origin is the same literal |
| `handler-origin-entry-userinfo` | `handler` | an entry with user info is invalid |
| `handler-origin-entry-underscore-host` | `handler` | an underscore is not a host character |
| `handler-origin-entry-query` | `handler` | an entry with a query is invalid |
| `handler-origin-entry-fragment` | `handler` | an entry with a fragment is invalid |
| `handler-origin-entry-empty-host` | `handler` | an entry with no host is invalid |
| `handler-origin-entry-other-scheme` | `handler` | only http and https are valid schemes |
| `handler-origin-entry-semicolon-list` | `handler` | the list is split on commas only: a semicolon list is one invalid entry |
| `handler-origin-entry-space-separated-second` | `handler` | the list is split on commas only: a space-separated pair is one invalid entry (second origin) |
| `handler-origin-entry-space-separated-first` | `handler` | the list is split on commas only: a space-separated pair is one invalid entry (first origin) |
| `handler-origin-entry-explicit-default-port-matches-exactly` | `handler` | an explicit :443 entry matches the Origin carrying :443 |
| `handler-origin-entry-explicit-default-port-entry-plain-origin` | `handler` | no default-port stripping: an entry with :443 does not match an Origin without a port |
| `handler-origin-entry-plain-entry-origin-with-default-port` | `handler` | no default-port stripping: a plain entry does not match an Origin with :443 |
| `handler-origin-entry-ipv6-without-port` | `handler` | a bracketed IPv6 literal without a port is valid |
| `handler-origin-entry-ipv6-dotted-tail` | `handler` | an IPv6 literal with a dotted tail is valid |
| `handler-origin-entry-ipv6-uppercase-hex` | `handler` | an IPv6 literal with uppercase hex is invalid: lowercase only |
| `handler-origin-entry-localhost-port` | `handler` | localhost with a port is valid |
| `handler-origin-entry-valid-entry-among-invalid` | `handler` | invalid entries are skipped and the valid one still matches |
| `handler-body-leading-nbsp` | `handler` | a no-break space before the JSON is not whitespace: 400 |
| `handler-body-leading-form-feed` | `handler` | a form feed before the JSON is not whitespace: 400 |
| `handler-body-leading-vertical-tab` | `handler` | a vertical tab before the JSON is not whitespace: 400 |
| `handler-body-leading-ideographic-space` | `handler` | U+3000 before the JSON is not whitespace: 400 |
| `handler-body-trailing-nbsp` | `handler` | a no-break space after the JSON is not whitespace: 400 |
| `handler-body-leading-bom` | `handler` | a UTF-8 byte order mark is not whitespace: 400 |
| `handler-body-comment` | `handler` | comments are not JSON: 400 |
| `handler-body-comment-inside` | `handler` | a comment inside the object is not JSON: 400 |
| `handler-body-trailing-comma` | `handler` | a trailing comma is not JSON: 400 |
| `handler-body-trailing-comma-array` | `handler` | a trailing comma in an array is not JSON: 400 |
| `handler-body-single-quotes` | `handler` | single-quoted strings are not JSON: 400 |
| `handler-body-unquoted-keys` | `handler` | unquoted keys are not JSON: 400 |
| `handler-body-nan-literal` | `handler` | NaN is not JSON: 400 |
| `handler-body-infinity-literal` | `handler` | Infinity is not JSON: 400 |
| `handler-body-leading-zero-number` | `handler` | a number with a leading zero is not JSON: 400 |
| `handler-body-plus-sign-number` | `handler` | a number with a plus sign is not JSON: 400 |
| `handler-body-hex-number` | `handler` | a hexadecimal number is not JSON: 400 |
| `handler-body-raw-control-char-in-string` | `handler` | an unescaped newline inside a string is not JSON: 400 |
| `handler-body-duplicate-messages-last-wins-empty` | `handler` | duplicate keys: the last value wins, here an empty messages array: 400 |
| `handler-body-duplicate-messages-last-wins` | `handler` | duplicate keys: the last value wins, here the valid messages |
| `handler-body-json-whitespace-all-four` | `handler` | the four JSON whitespace characters around the value are accepted |
| `handler-body-top-level-proto-key` | `handler` | a __proto__ key at the top level is an ordinary ignored key |
| `handler-body-lone-surrogate-escape-content` | `handler` | an escaped lone surrogate is one code unit and is forwarded as given |
| `handler-body-escaped-unicode-content` | `handler` | JSON escapes decode before the limits and the forwarding |
| `handler-body-oversized-garbage-is-400` | `handler` | a body over 64 KiB is 400 whatever it holds |
| `handler-top-level-gemini-keys-ignored` | `handler` | Gemini-looking top-level keys in the request are ignored and never reach the upstream |
| `handler-message-level-parts-key-ignored` | `handler` | parts and name inside a message are ignored |
| `handler-content-single-space-accepted` | `handler` | a one-space content is valid and forwarded |
| `handler-content-single-newline-accepted` | `handler` | a one-newline content is valid and forwarded |
| `handler-content-no-normalization` | `handler` | content is forwarded with no normalization (combining marks, ligatures, CR LF, NUL, lone surrogate, NBSP) |
| `handler-shape-role-leading-space` | `handler` | roles are not trimmed: ' user' is 400 |
| `handler-shape-role-trailing-newline` | `handler` | roles are not trimmed: 'user\n' is 400 |
| `handler-shape-role-model` | `handler` | model is not a role: 400 |
| `handler-limit-system-message-8000-accepted` | `handler` | a system message of 8,000 characters is accepted |
| `handler-limit-system-message-8001-rejected` | `handler` | the per-message limit applies to system messages: 8,001 is 400 |
| `handler-map-system-last-and-interleaved` | `handler` | system messages anywhere are joined in order; the others keep their order |
| `handler-maxtokens-1024-point-zero` | `handler` | 1024.0 is an integer by exact decimal value |
| `handler-maxtokens-exponent-1024` | `handler` | 1.024e3 is exactly 1024 |
| `handler-maxtokens-exponent-uppercase` | `handler` | 1E2 is exactly 100 |
| `handler-maxtokens-exponent-shifted-fraction` | `handler` | 25.6e1 is exactly 256 |
| `handler-maxtokens-exponent-zero` | `handler` | 1e0 is 1 |
| `handler-maxtokens-minus-exponent-fraction` | `handler` | 2560e-1 is exactly 256 |
| `handler-maxtokens-just-over-1024-fraction` | `handler` | 1024.000001 is not an integer |
| `handler-maxtokens-near-integer-fraction` | `handler` | 256.00000000000000001 is not an integer by exact value (a double reading would say 256) |
| `handler-maxtokens-exponent-overflow` | `handler` | 1e400 is an integer far above 1,024: 400 |
| `handler-maxtokens-exponent-huge-digits` | `handler` | 1e999999999 is far above 1,024: 400, with no memory blow-up |
| `handler-maxtokens-tiny-exponent-fraction` | `handler` | 1e-400 is not an integer: 400 |
| `handler-maxtokens-minus-zero` | `handler` | -0 is 0, below the minimum 1: 400 |
| `handler-maxtokens-array` | `handler` | an array holding 256 is not a number: 400 |
| `handler-maxtokens-object` | `handler` | an object is not a number: 400 |
| `handler-maxtokens-negative-exponent-to-fraction` | `handler` | 5e-1 is 0.5: 400 |
| `handler-preflight-oversized-body` | `handler` | a preflight with a 70,000-byte body is still 204: the body is never read for the size check |
| `handler-route-double-slash-prefix` | `handler` | no path normalization: //v1/complete is 404 |
| `handler-route-double-slash-inside` | `handler` | no path normalization: /v1//complete is 404 |
| `handler-route-percent-encoded-letter` | `handler` | no percent-decoding: /v1/%63omplete is 404 |
| `handler-route-semicolon-suffix` | `handler` | no path parameter stripping: /v1/complete;x=1 is 404 |
| `handler-route-fragment-after-query-ignored` | `handler` | a query that looks like a path and a fragment are not part of the path |
| `handler-rate-keyless-request-consumes-slot` | `handler` | a request that passes step 8 consumes a slot even when it ends in 503 for a missing key (preload 9, one keyless request, then the next is 429) |
| `handler-rate-upstream-failure-consumes-slot` | `handler` | a request that ends in an upstream 503 still consumed its slot |
| `handler-rate-keyless-10th-request-is-503-not-429` | `handler` | the 10th request of a keyless Worker passes the limiter and is 503 |
| `handler-rate-ipv6-case-sensitive` | `handler` | limiter keys are case-sensitive: 2001:DB8::1 is not 2001:db8::1 |
| `handler-rate-literal-unknown-ip-header-shares-bucket` | `handler` | a client that really sends cf-connecting-ip: unknown shares the unknown bucket |
| `handler-model-empty-is-503` | `handler` | an empty GEMINI_MODEL is a deployment error: 503 before any upstream call |
| `handler-model-blank-is-503` | `handler` | a GEMINI_MODEL of spaces is empty after trim: 503, no upstream call |
| `handler-model-with-slash-percent-encoded` | `handler` | a model name with a slash is percent-encoded as one path segment (encodeURIComponent) |
| `handler-model-with-percent-sign-encoded` | `handler` | a percent sign in the model name is itself encoded (m%2Fx becomes m%252Fx) |
| `handler-model-with-space-and-unicode-encoded` | `handler` | a space and a non-ASCII letter are percent-encoded as UTF-8 |
| `handler-model-unreserved-marks-not-encoded` | `handler` | ! ~ * ' ( ) - _ . stay literal in the model segment |
| `handler-upstream-finish-null-is-absent` | `handler` | finishReason null counts as absent: 200 |
| `handler-upstream-finish-empty-string` | `handler` | finishReason '' is a present value that is not listed: 502 |
| `handler-upstream-finish-number` | `handler` | finishReason 1 is not listed: 502 |
| `handler-upstream-finish-array-of-stop` | `handler` | finishReason ['STOP'] is not the string STOP: 502 |
| `handler-upstream-finish-unspecified` | `handler` | finishReason FINISH_REASON_UNSPECIFIED is not listed: 502 |
| `handler-upstream-candidate-is-array` | `handler` | candidates[0] that is an array is not an object: 502 |
| `handler-upstream-candidate-null` | `handler` | a null first candidate fails even when the second is fine: 502 |
| `handler-upstream-content-is-array` | `handler` | content that is an array has no parts: 502 |
| `handler-upstream-content-null` | `handler` | content null has no parts: 502 |
| `handler-upstream-parts-null` | `handler` | parts null is not an array: 502 |
| `handler-upstream-parts-with-null-and-empty-text` | `handler` | parts that are null, have empty or non-string text are skipped or empty; the rest concatenate |
| `handler-upstream-body-array-wrapping-candidates` | `handler` | a 200 whose body is an array is not an object: 502 |
| `handler-upstream-trailing-garbage-json` | `handler` | a 200 body with text after the JSON value is not JSON: 502 |
| `handler-upstream-body-unreadable-on-200` | `handler` | a 200 whose body cannot be read is unreadable: 502 |
| `handler-upstream-body-bom-prefixed` | `handler` | a UTF-8 BOM before the upstream JSON is not JSON: 502 |
| `handler-upstream-body-trailing-comma` | `handler` | an upstream body that is not strict JSON (trailing comma) is 502 |
| `handler-upstream-body-unreadable-on-500` | `handler` | a 500 whose body cannot be read is just 503 |
| `handler-upstream-429-body-unreadable-uses-header` | `handler` | a 429 whose body cannot be read has no body information: the header is still used |
| `handler-upstream-429-body-unreadable-without-header` | `handler` | a 429 whose body cannot be read and no header is a plain 429 |
| `handler-upstream-status-408-is-503` | `handler` | an upstream 408 is 503 unavailable with no retry-after |
| `handler-upstream-status-422-is-503` | `handler` | an upstream 422 is 503 unavailable with no retry-after |
| `handler-upstream-status-499-is-503` | `handler` | an upstream 499 is 503 unavailable with no retry-after |
| `handler-upstream-status-502-is-503` | `handler` | an upstream 502 is 503 unavailable with no retry-after |
| `handler-upstream-status-524-is-503` | `handler` | an upstream 524 is 503 unavailable with no retry-after |
| `handler-upstream-status-301-with-retry-after-is-503` | `handler` | an upstream 301 carrying retry-after and location is 503 and forwards nothing |
| `handler-upstream-429-delay-trailing-zero-fraction` | `handler` | 1.0000s is exactly 1000 ms (four fraction digits are valid), retry-after 1 |
| `handler-upstream-429-delay-fraction-001-then-zero` | `handler` | 1.0010s is exactly 1001 ms: a trailing zero past the third digit does not round up |
| `handler-upstream-429-delay-nine-digit-tiny-fraction` | `handler` | 0.000000001s is 0.000001 ms: rounded up to 1 ms |
| `handler-upstream-429-delay-leading-zeros` | `handler` | 007s is 7000 ms: leading zeros are fine |
| `handler-upstream-429-delay-just-over-cap` | `handler` | 3600.001s is 3,600,001 ms: capped to 3,600,000, retry-after 3600 |
| `handler-upstream-429-delay-exactly-cap` | `handler` | 3600s is exactly the cap |
| `handler-upstream-429-delay-just-under-cap` | `handler` | 3599.999s is 3,599,999 ms, retry-after rounds up to 3600 |
| `handler-upstream-429-delay-dot-without-fraction-falls-back-to-header` | `handler` | 1.s is not a delay (a dot needs fraction digits) |
| `handler-upstream-429-delay-ten-fraction-digits-falls-back-to-header` | `handler` | 1.0000000001s has ten fraction digits: not a delay |
| `handler-upstream-429-delay-uppercase-unit-falls-back-to-header` | `handler` | 7S is not a delay |
| `handler-upstream-429-delay-leading-space-falls-back-to-header` | `handler` |  7s is not a delay |
| `handler-upstream-429-delay-trailing-space-falls-back-to-header` | `handler` | 7s with a trailing space is not a delay |
| `handler-upstream-429-delay-trailing-newline-falls-back-to-header` | `handler` | 7s with a trailing newline is not a delay |
| `handler-upstream-429-delay-exponent-falls-back-to-header` | `handler` | 7e0s is not a delay |
| `handler-upstream-429-delay-plus-sign-falls-back-to-header` | `handler` | +7s is not a delay |
| `handler-upstream-429-delay-non-ascii-digit-falls-back-to-header` | `handler` | an Arabic-Indic digit is not a digit here |
| `handler-upstream-429-delay-empty-falls-back-to-header` | `handler` | an empty retryDelay is not a delay |
| `handler-upstream-429-delay-only-unit-falls-back-to-header` | `handler` | s alone is not a delay |
| `handler-upstream-429-delay-number-not-string-falls-back` | `handler` | a numeric retryDelay is not a string: ignored, the header is used |
| `handler-upstream-429-invalid-retryinfo-skipped-next-valid-used` | `handler` | an invalid RetryInfo is skipped and the search goes on with the next detail |
| `handler-upstream-429-first-valid-retryinfo-wins` | `handler` | of several valid RetryInfo details only the first counts |
| `handler-upstream-429-type-suffix-not-retryinfo` | `handler` | an @type with an extra suffix is not RetryInfo |
| `handler-upstream-429-type-prefix-not-retryinfo` | `handler` | an @type with an extra prefix is not RetryInfo |
| `handler-upstream-429-type-case-sensitive` | `handler` | @type is compared exactly, case included |
| `handler-upstream-429-details-not-array` | `handler` | error.details that is not an array carries no delay |
| `handler-upstream-429-body-is-array` | `handler` | a 429 body that is an array carries no delay |
| `handler-upstream-429-error-is-array` | `handler` | error that is an array carries no delay |
| `handler-upstream-429-retryinfo-at-top-level` | `handler` | a RetryInfo outside error.details carries no delay |
| `handler-upstream-429-retryinfo-at-top-level-without-error` | `handler` | a body with details at the top level and no error key carries no delay |
| `handler-upstream-429-detail-not-object-skipped` | `handler` | details elements that are not objects are skipped |
| `handler-upstream-429-header-leading-zeros` | `handler` | a retry-after header 007 is 7 seconds |
| `handler-upstream-429-header-zero-is-a-value` | `handler` | a retry-after header 0 is a value: retryAfterMs 0, retry-after 0 |
| `handler-upstream-429-header-exactly-cap` | `handler` | a retry-after header 3600 is exactly the cap |
| `handler-upstream-429-header-just-over-cap` | `handler` | a retry-after header 3601 is capped to 3,600,000 |
| `handler-upstream-429-header-many-leading-zeros` | `handler` | 23 zeros then 3 is 3 seconds, not a huge number |
| `handler-upstream-429-body-wins-over-zero-header` | `handler` | RetryInfo wins over a header 0 |
| `handler-upstream-429-header-trailing-junk-ignored` | `handler` | a retry-after header '30abc' is not only ASCII digits: ignored |
| `handler-upstream-429-header-decimal-ignored` | `handler` | a retry-after header '3.5' is not only ASCII digits: ignored |
| `handler-upstream-429-header-plus-sign-ignored` | `handler` | a retry-after header '+30' is not only ASCII digits: ignored |
| `handler-upstream-429-header-negative-ignored` | `handler` | a retry-after header '-30' is not only ASCII digits: ignored |
| `handler-upstream-429-header-exponent-ignored` | `handler` | a retry-after header '1e3' is not only ASCII digits: ignored |
| `handler-upstream-429-header-list-ignored` | `handler` | a retry-after header '3, 4' is not only ASCII digits: ignored |
| `handler-upstream-429-header-hex-ignored` | `handler` | a retry-after header '0x10' is not only ASCII digits: ignored |
| `handler-upstream-429-header-name-case-last-wins` | `handler` | two header names differing only in case: the last in the fixture object wins (5) |
| `handler-upstream-429-header-name-case-last-wins-reversed` | `handler` | two header names differing only in case: the last in the fixture object wins (30) |
| `limiter-prototype-property-names-are-plain-keys` | `limiter` | keys are opaque strings: __proto__, constructor, toString, hasOwnProperty, valueOf, the empty string and prototype are ordinary keys |
| `limiter-live-windows-are-never-evicted` | `limiter` | a window that has not expired is never evicted, whatever the number of keys: 24 keys open at t = 0..23 and are all still denied at t = 500..523 |
| `limiter-expired-key-after-many-others` | `limiter` | an expired key starts a new window even after many other keys were used |
| `limiter-first-call-at-time-zero-opens-window` | `limiter` | time 0 is a time like any other: the first call at 0 opens a window |
| `limiter-limit-zero-denies-everything` | `limiter` | a limit of 0 denies every call (the first call opens a window and is denied with the whole window) |
| `client-retry-after-body-point-zero-integer` | `client` | 1500.0 is an integer by exact decimal value: 1500 |
| `client-retry-after-body-exponent-integer` | `client` | 1.5e3 is exactly 1500 |
| `client-retry-after-body-uppercase-exponent` | `client` | 1E3 is exactly 1000 |
| `client-retry-after-body-exponent-shifted` | `client` | 0.5e1 is exactly 5 |
| `client-retry-after-body-minus-zero` | `client` | -0 is 0 and wins over the header |
| `client-retry-after-body-point-zero-zero` | `client` | 0.0 is 0 and wins over the header |
| `client-retry-after-body-near-integer-falls-back` | `client` | 1500.0000000000000001 is not an integer by exact value: the header is used |
| `client-retry-after-body-tiny-exponent-falls-back` | `client` | 1e-400 is not an integer: the header is used |
| `client-retry-after-body-small-fraction-exponent-falls-back` | `client` | 1.5e-3 is 0.0015: the header is used |
| `client-retry-after-body-exponent-overflow-capped` | `client` | 1e400 is an integer above the cap: capped, never the header |
| `client-retry-after-body-32-bit-wrap-capped` | `client` | 4294967297 is capped, not wrapped to 1 |
| `client-retry-after-body-2-pow-31-capped` | `client` | 2147483648 is capped |
| `client-retry-after-body-23-digits-capped` | `client` | a 23-digit integer is capped, never the header |
| `client-retry-after-body-exactly-cap` | `client` | 3600000 is exactly the cap |
| `client-retry-after-body-cap-plus-one` | `client` | 3600001 is capped to 3,600,000 |
| `client-retry-after-body-cap-minus-one` | `client` | 3599999 is below the cap and kept |
| `client-retry-after-body-null-falls-back` | `client` | a null retryAfterMs is not an integer: the header is used |
| `client-retry-after-body-true-falls-back` | `client` | true is not an integer: the header is used |
| `client-retry-after-body-array-falls-back` | `client` | [1500] is not an integer: the header is used |
| `client-retry-after-body-object-falls-back` | `client` | {} is not an integer: the header is used |
| `client-retry-after-body-duplicate-key-last-wins` | `client` | duplicate keys: the last retryAfterMs (7) wins |
| `client-retry-after-header-independent-of-status-503` | `client` | the header fallback applies to any status when the body kind is rate_limit (503) |
| `client-retry-after-header-independent-of-status-500-body-wins` | `client` | a 500 with a rate_limit body and retryAfterMs 5: the body wins over the header |
| `client-retry-after-header-upper-case-name` | `client` | the header name RETRY-AFTER is found |
| `client-retry-after-header-case-duplicates-last-wins` | `client` | two names differing only in case: the last one in the object wins (4) |
| `client-retry-after-header-case-duplicates-last-wins-reversed` | `client` | two names differing only in case: the last one in the object wins (3) |
| `client-retry-after-header-leading-zeros` | `client` | 0003 is 3 seconds |
| `client-retry-after-header-23-leading-zeros` | `client` | 23 zeros then 3 is 3 seconds, not 'too long' |
| `client-retry-after-header-all-zeros` | `client` | a header of only zeros is 0 |
| `client-retry-after-header-zero` | `client` | a header 0 is a value |
| `client-retry-after-header-exactly-cap` | `client` | a header 3600 is exactly the cap |
| `client-retry-after-header-cap-plus-one-second` | `client` | a header 3601 is capped |
| `client-retry-after-header-32-bit-wrap-capped` | `client` | a header 2147484 seconds (over 2^31 ms) is capped |
| `client-retry-after-header-64-bit-wrap-capped` | `client` | a header 9223372036854776 seconds (over 2^63 ms) is capped |
| `client-retry-after-header-2-pow-63-capped` | `client` | a header 9223372036854775808 is capped |
| `client-retry-after-header-leading-space-ignored` | `client` | a retry-after header " 3" is not only ASCII digits: no retryAfterMs |
| `client-retry-after-header-trailing-space-ignored` | `client` | a retry-after header "3 " is not only ASCII digits: no retryAfterMs |
| `client-retry-after-header-plus-sign-ignored` | `client` | a retry-after header "+3" is not only ASCII digits: no retryAfterMs |
| `client-retry-after-header-empty-ignored` | `client` | a retry-after header "" is not only ASCII digits: no retryAfterMs |
| `client-retry-after-header-decimal-ignored` | `client` | a retry-after header "1.5" is not only ASCII digits: no retryAfterMs |
| `client-retry-after-header-arabic-indic-digit-ignored` | `client` | a retry-after header "٣" is not only ASCII digits: no retryAfterMs |
| `client-retry-after-header-fullwidth-digit-ignored` | `client` | a retry-after header "３" is not only ASCII digits: no retryAfterMs |
| `client-retry-after-header-exponent-ignored` | `client` | a retry-after header "1e3" is not only ASCII digits: no retryAfterMs |
| `client-retry-after-header-negative-ignored` | `client` | a retry-after header "-3" is not only ASCII digits: no retryAfterMs |
| `client-retry-after-header-trailing-junk-ignored` | `client` | a retry-after header "3abc" is not only ASCII digits: no retryAfterMs |
| `client-retry-after-header-list-ignored` | `client` | a retry-after header "3, 4" is not only ASCII digits: no retryAfterMs |
| `client-retry-after-header-ignored-for-other-kind-with-header` | `client` | a retry-after header is ignored when the body kind is not rate_limit (unavailable) |
| `client-success-trailing-comma` | `client` | a trailing comma is not JSON: invalid_output |
| `client-success-single-quotes` | `client` | single quotes are not JSON: invalid_output |
| `client-success-unquoted-key` | `client` | an unquoted key is not JSON: invalid_output |
| `client-success-trailing-text` | `client` | text after the JSON value is not JSON: invalid_output |
| `client-success-nan` | `client` | NaN is not JSON: invalid_output |
| `client-success-comment` | `client` | a comment is not JSON: invalid_output |
| `client-success-leading-zero-number` | `client` | a number with a leading zero is not JSON: invalid_output |
| `client-success-bom-prefix` | `client` | a byte order mark before the JSON is not JSON: invalid_output |
| `client-success-nbsp-around` | `client` | a no-break space around the JSON is not whitespace: invalid_output |
| `client-success-error-object-only` | `client` | a 200 whose body is an error object has no text: invalid_output |
| `client-success-text-true` | `client` | a text that is true is not a string: invalid_output |
| `client-success-text-array` | `client` | a text that is an array is not a string: invalid_output |
| `client-success-text-object` | `client` | a text that is an object is not a string: invalid_output |
| `client-success-whitespace-around-json` | `client` | the four JSON whitespace characters around the body are fine |
| `client-success-duplicate-text-key-last-wins` | `client` | duplicate keys: the last text wins |
| `client-success-extra-keys-ignored` | `client` | extra keys, an error key included, do not change a success |
| `client-success-text-verbatim` | `client` | the text is returned verbatim, whitespace included |
| `client-provider-whitespace-only-uses-id` | `client` | a whitespace-only provider is not used |
| `client-provider-null-uses-id` | `client` | a null provider is not a string |
| `client-provider-true-uses-id` | `client` | a boolean provider is not a string |
| `client-provider-array-uses-id` | `client` | an array provider is not a string |
| `client-provider-object-uses-id` | `client` | an object provider is not a string |
| `client-provider-with-spaces-kept-verbatim` | `client` | a provider with a non-whitespace character is used as given, spaces included |
| `client-error-kind-at-top-level` | `client` | a kind at the top level is not an error object: unavailable |
| `client-error-kind-wrong-case` | `client` | kinds are case-sensitive: RATE_LIMIT is unavailable |
| `client-error-error-is-string` | `client` | error that is a string is unavailable |
| `client-error-error-is-array-of-objects` | `client` | error that is an array is unavailable |
| `client-error-error-is-null` | `client` | error that is null is unavailable |
| `client-error-body-is-null` | `client` | a body that is JSON null is unavailable |
| `client-error-body-is-string` | `client` | a body that is a JSON string is unavailable |
| `client-error-body-is-number` | `client` | a body that is a JSON number is unavailable |
| `client-error-body-is-true` | `client` | a body that is JSON true is unavailable |
| `client-error-trailing-comma` | `client` | an error body that is not strict JSON (trailing comma) is unavailable |
| `client-error-bom-prefix` | `client` | an error body with a BOM before the JSON is unavailable |
| `client-error-duplicate-kind-last-wins` | `client` | duplicate keys in an error: the last kind wins |
| `client-error-leading-zero-retry-after-is-not-json` | `client` | a retryAfterMs with a leading zero makes the body invalid JSON: unavailable |
| `client-body-bogus-role-and-empty-content-forwarded` | `client` | the client does not validate: a bogus role, empty content and maxTokens 0 are forwarded unchanged |
| `client-body-max-tokens-5000-forwarded` | `client` | maxTokens above the gateway limit is forwarded unchanged |
| `client-body-max-tokens-negative-forwarded` | `client` | a negative maxTokens is forwarded unchanged |
| `client-body-empty-messages-forwarded` | `client` | an empty messages list still makes one transport call with the list as given |
| `client-header-api-key-whitespace-only-not-sent` | `client` | a whitespace-only apiKey counts as absent: no header |
| `client-header-api-key-tab-newline-not-sent` | `client` | an apiKey of tab and newline counts as absent: no header |
| `client-body-unicode-content-verbatim` | `client` | emoji, euro, quotes, backslash, newline and NUL in a content are forwarded unchanged (the transport body is JSON-escaped) |
| `client-header-api-key-with-spaces-sent-verbatim` | `client` | an apiKey with a non-whitespace character is sent exactly as given, spaces included |

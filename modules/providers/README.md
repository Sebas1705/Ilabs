# providers

Small building blocks for calling AI providers reliably, with identical behavior in Kotlin and TypeScript. The behavior is pinned by the shared fixtures in [`contracts/providers`](../../contracts/providers/README.md); read that README for the exact rules (retry waits, error handling, fixture format).

## The three providers

| Provider | What it does |
|---|---|
| `MockProvider(id, script)` | Deterministic provider for tests and demos: call N consumes `script[N-1]`, then fails with `unavailable`. No API key needed. |
| `RetryingProvider(inner, options)` | Retries `rate_limit` and `timeout` with exponential backoff (or the error's `retryAfterMs`), clamped to `maxDelayMs`. The `sleep` function is injected so tests never wait. |
| `FallbackProvider(providers)` | Tries providers in order, moving on after `rate_limit`, `timeout` and `unavailable`; `invalid_output` stops the chain. |

Each implementation lives in its own folder: `modules/providers/ts` (package `@ilabs/providers`) and `modules/providers/kotlin` (package `es.sebas1705.ilabs.providers`, KMP for Android and JVM).

## TypeScript

```ts
import { FallbackProvider, MockProvider, RetryingProvider } from "@ilabs/providers";

const primary = new RetryingProvider(
  new MockProvider("primary", [{ error: { kind: "rate_limit" } }, { response: "hello" }]),
  {
    maxAttempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
);
const chain = new FallbackProvider([primary, new MockProvider("backup", [{ response: "hi" }])]);

const reply = await chain.complete({ messages: [{ role: "user", content: "Say hello" }] });
console.log(reply.text, reply.provider); // "hello" "primary"
```

## Kotlin

```kotlin
import es.sebas1705.ilabs.providers.*
import kotlinx.coroutines.delay

suspend fun demo() {
    val primary = RetryingProvider(
        MockProvider(
            "primary",
            listOf(ScriptEntry(error = ScriptError(ErrorKind.RATE_LIMIT)), ScriptEntry(response = "hello")),
        ),
        RetryOptions(maxAttempts = 3, baseDelayMs = 100, maxDelayMs = 1000, sleep = { ms -> delay(ms) }),
    )
    val chain = FallbackProvider(listOf(primary, MockProvider("backup", listOf(ScriptEntry(response = "hi")))))

    val reply = chain.complete(CompletionRequest(listOf(Message(Role.USER, "Say hello"))))
    println("${reply.text} ${reply.provider}") // hello primary
}
```

Failures are reported as `ProviderError` (TypeScript) or `ProviderException` (Kotlin) carrying a `kind` and an optional `retryAfterMs`. Any other exception is rethrown unchanged.

## HttpProvider (TypeScript)

`HttpProvider` calls the iLabs gateway (`POST {endpoint}/v1/complete`) through an injected transport, so it runs in a browser, Node or a test without a network. It maps the gateway's answer to the same `ProviderError` kinds as the other providers; the rules (status handling, `retryAfterMs` and `Retry-After`, strict JSON) live in [`contracts/gateway/README.md`](../../contracts/gateway/README.md) and are pinned by its `client-*.json` fixtures (`runClientFixture`).

```ts
import { HttpProvider, TransportTimeoutError } from "@ilabs/providers";

const gateway = new HttpProvider({
  endpoint: "https://gateway.example.test",
  apiKey: userKey, // optional: sent as x-ilabs-api-key (bring your own key)
  transport: async (req) => {
    try {
      const res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal: AbortSignal.timeout(req.timeoutMs),
      });
      return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
    } catch (e) {
      if (e instanceof DOMException && e.name === "TimeoutError") throw new TransportTimeoutError();
      throw e; // any other rejection is a network failure (`unavailable`)
    }
  },
});

const reply = await gateway.complete({ messages: [{ role: "user", content: "Say hello" }], maxTokens: 64 });
console.log(reply.text, reply.provider); // the gateway's text and "gateway" (the default id)
```

Compose it like any other provider, for example `new RetryingProvider(gateway, options)` so a gateway `429` with `retryAfterMs` waits as the server asks (up to the retry's `maxDelayMs`), and `new FallbackProvider([retrying, mock])` to fall back to a mock. The transport owns the timeout: `timeoutMs` (default 25,000, a positive integer) is passed in the request and the transport must enforce it. Without the gateway deployed (see [`demos/gateway-worker`](../../demos/gateway-worker/README.md)) use a fake transport, as the tests do.

## HttpProvider (Kotlin)

`HttpProvider` is the Kotlin twin of the TypeScript class above: same contract, same fixtures (`GatewayClientContract`). The transport is a `fun interface` with a `suspend` method (a lambda converts); throw `TransportTimeoutException` for a timeout, anything else counts as unavailable.

```kotlin
val gateway = HttpProvider(
    id = "gateway",
    endpoint = "https://gateway.example.com",
    transport = { request ->
        // Perform request.url, request.headers, request.body and request.timeoutMs, then:
        HttpResponse(status = 200, headers = emptyMap(), body = "{\"text\":\"Hi\"}")
    },
    apiKey = null, // optional
    timeoutMs = 30_000, // optional, positive
)
```

Coroutine cancellation is never mapped: `CancellationException` is rethrown unchanged.

## Contract

[`contracts/providers/README.md`](../../contracts/providers/README.md) defines the behavior and the fixture format. Both implementations must pass every fixture in that folder.

# iLabs

iLabs ("i" as in AI) is a collection of small, reusable AI modules written in Kotlin and TypeScript, each with a visible demo.

**Status:** early. Seven modules are done, each with a web demo page and an Android demo screen: providers, structured, context, evals, rag, guardrails and vision. On top of them sit an **Assistant** demo (an eighth page on the web and an eighth screen on Android) that chains several modules in one chat, and an optional [gateway Worker](demos/gateway-worker/README.md) so the demos can talk to a real model without holding its key.

## Modules

| Module | Status | What it is |
|---|---|---|
| [providers](modules/providers/README.md) | done | Mock, retrying and fallback AI providers, plus `HttpProvider` for the gateway below, identical in Kotlin and TypeScript |
| [structured](modules/structured/README.md) | done | Structured output: extract JSON from a reply, validate it against a schema and repair it, identical in Kotlin and TypeScript |
| [context](modules/context/README.md) | done | Context windows and token budgeting: sliding window and summarization of long conversations, identical in Kotlin and TypeScript |
| [evals](modules/evals/README.md) | done | Deterministic evals: run a suite of cases against several providers, grade every reply (string, length, JSON and judge graders) and summarize, identical in Kotlin and TypeScript |
| [rag](modules/rag/README.md) | done | Retrieval-augmented generation at teaching scale: chunk documents, retrieve with BM25, dense vectors or their fusion, compose a numbered-sources context, check citations and measure retrieval, identical in Kotlin and TypeScript |
| [guardrails](modules/guardrails/README.md) | done | Guardrails around a model call: find personal data and secrets, redact them reversibly, score prompt-injection signals, apply a block/redact/flag policy on input and output, detect a leaked canary and measure the detectors, identical in Kotlin and TypeScript |
| [vision](modules/vision/README.md) | done | Vision plumbing around a model: preprocess an image (resize, centre crop or letterbox, normalization), read classifier and detector outputs (softmax, top-k, box decoding, NMS), map boxes back to the original image and measure the result (IoU, average precision), with the model behind a one-method interface and small real models in the demos, identical in Kotlin and TypeScript |

## Layout

```
modules/<name>/{kotlin,ts}   one module, one implementation per language
demos/{android,web}          visible demos that use the modules (the Assistant is the eighth in each)
demos/gateway-worker/        the Cloudflare Worker that fronts Gemini (not deployed by default)
contracts/<name>/            shared JSON contracts and fixtures (the gateway one has three implementations)
demos/vision-assets/         samples, labels, model cards and recorded outputs of the vision demos
docs/                        design spec, plans and ADRs
```

## No API keys needed

The demos run with a mock provider, so you can try everything without any API key. Even the Assistant starts on a scripted mock. The `vision` demos need no key and no model file either: their default backend replays raw model outputs recorded once and committed.

## Assistant demo and the gateway Worker

The **Assistant** (web page `#/assistant`, Android screen "Assistant") is a chat that runs one turn through `guardrails` (redaction of personal data before it leaves the device), `context` (a sliding window under a token budget), `providers` (retry, waiting the server's `retryAfterMs` but never more than 8 s in either demo, then a fallback to the mock) and `evals` (a small suite replayed against the same chain). A trace shows every step. It has three backends:

- **Mock** (default): scripted replies and no network. The third call is rate limited on purpose, so the retry shows up in the trace.
- **Worker**: [`HttpProvider`](modules/providers/README.md#httpprovider-typescript) calls the gateway at an endpoint you give (web: default from `VITE_GATEWAY_ENDPOINT`; Android: typed in the screen). If the gateway fails the mock answers and the trace says so.
- **My key**: the same gateway with your own Gemini key, sent in the `x-ilabs-api-key` header and kept only in memory.

Both demos wait at most 8 s between two attempts, whatever the server asks (`RetryingProvider` honors `retryAfterMs` up to its `maxDelayMs`, which is 8,000 ms here). The Worker's own rate limit can ask for up to 60 s, so after one 8 s wait the second attempt is often `429` again and the mock answers.

To point the web demo at a gateway, set `VITE_GATEWAY_ENDPOINT` to its `https://` URL (or `http://localhost:8787` for `wrangler dev`). It is read at build time, not at run time: put it on the command line (`VITE_GATEWAY_ENDPOINT=https://ilabs-gateway.example.workers.dev corepack pnpm --filter @ilabs/demo-web dev`, the same for `build`) or in a git-ignored `demos/web/.env.local` (`VITE_GATEWAY_ENDPOINT=...`), and rebuild after changing it. It only fills the endpoint field's default: you can still type another one on the page. The page's origin (for local development `http://localhost:5173`) must be listed in the Worker's `ALLOWED_ORIGINS`, or the browser blocks the call.

The [gateway Worker](demos/gateway-worker/README.md) validates and caps each request, applies an origin allowlist and a best-effort rate limit, makes one call to a Gemini model fixed on the server and maps every outcome to the provider error kinds. Its protocol is pinned by [`contracts/gateway`](contracts/gateway/README.md), which the Worker, the TypeScript `HttpProvider` and the Kotlin `HttpProvider` all pass.

Honest limits: nothing is deployed by default, so Worker and My key need an endpoint you deploy yourself (the Worker README has the owner steps). The allowlist is not authentication, the limiter is per isolate, and the guardrails run in the client and can be bypassed by calling the Worker directly. Automated checks script the network and Gemini: a real Gemini call and a real Cloudflare deploy have not been verified.

## Models for the vision demos (optional)

The `vision` demos also have a **Real model** mode that runs small open models (a classifier and a detector, ONNX for the web demo and TFLite for the Android demo, about 4 to 28 MB each, as `--check` prints them in MiB). The model files are never committed: download them into the git-ignored `demos/vision-assets/models/` and every file is verified against a pinned SHA-256. Run it from the repository root with a current Node LTS:

```sh
node scripts/vision-models.mjs                  # download every missing model (resumable)
node scripts/vision-models.mjs --runtime onnx   # only the web models (or --runtime tflite)
node scripts/vision-models.mjs --check          # list what is present and whether it matches
```

In dev the web demo serves them at `/vision-models/`; for a deployed page set `VITE_VISION_MODELS_BASE` to the URL that serves them (CORS required for another origin). Then restart the web dev server or rebuild the Android app. Without the files the demos stay on the recorded backend and say so; your own image has no recording, so it always needs the real model. Sources, licenses and checksums are in [`demos/vision-assets/README.md`](demos/vision-assets/README.md). The models are small and make mistakes: see the [honest limits](modules/vision/README.md#honest-limits-first).

## Prerequisites

- Node.js with corepack (the repo pins pnpm 12 through the `packageManager` field)
- JDK 21 and the Android SDK (set `ANDROID_HOME` or `sdk.dir` in `local.properties`), for the Kotlin module and the Android demo

## Run it

```sh
corepack pnpm install                           # install the TypeScript workspace
corepack pnpm -r typecheck                      # TypeScript type checks
corepack pnpm -r test                           # TypeScript tests (modules, web demo and gateway Worker)
corepack pnpm --filter @ilabs/gateway-worker smoke   # the Worker end to end against a fake Gemini, no key
corepack pnpm --filter @ilabs/demo-web dev      # web demo at http://localhost:5173
./gradlew :modules:providers-kotlin:jvmTest     # Kotlin tests against the shared providers fixtures
./gradlew :modules:structured-kotlin:jvmTest    # Kotlin tests against the shared structured fixtures
./gradlew :modules:context-kotlin:jvmTest       # Kotlin tests against the shared context fixtures
./gradlew :modules:evals-kotlin:jvmTest         # Kotlin tests against the shared evals fixtures
./gradlew :modules:rag-kotlin:jvmTest           # Kotlin tests against the shared rag fixtures
./gradlew :modules:guardrails-kotlin:jvmTest    # Kotlin tests against the shared guardrails fixtures
./gradlew :modules:vision-kotlin:jvmTest        # Kotlin tests against the shared vision fixtures
./gradlew jvmContractTests                      # run all Kotlin module tests (includes the gateway client fixtures)
./gradlew :demos:android:testDebugUnitTest      # Android demo unit tests (includes the Assistant)
./gradlew :demos:android:installDebug           # Android demo on a connected device or emulator
```

## Docs

- [Design spec](docs/superpowers/specs/2026-11-11-ilabs-design.md)
- [Gateway and full-stack demo design](docs/superpowers/specs/2026-11-28-gateway-fullstack-design.md)
- [Gateway contract](contracts/gateway/README.md)
- [ADR 0001: Contracts first, deterministic only](docs/adr/0001-contracts-first.md)

## License

MIT. See [LICENSE](LICENSE).

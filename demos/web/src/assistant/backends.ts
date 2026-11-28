import {
  FallbackProvider,
  HttpProvider,
  MockProvider,
  RetryingProvider,
  TransportTimeoutError,
  type CompletionRequest,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
  type Provider,
  type ScriptEntry,
} from "@ilabs/providers";
import type { Lang } from "../i18n";
import { RecordingProvider, TracedProvider, type Tracer } from "./trace";

export type Backend = "mock" | "worker" | "key";

/** The labels of the two leaves of the chain, as the trace shows them. */
export const GATEWAY_LABEL = "gateway";
export const MOCK_LABEL = "mock";

/** The mock fails with `rate_limit` on this call (1-based) and the retry then succeeds. */
export const RATE_LIMIT_CALL = 3;
export const RATE_LIMIT_RETRY_AFTER_MS = 1500;
/** How many calls one scripted mock can serve before it runs dry (`unavailable`). */
const MOCK_CALLS = 500;

const REPLIES: Record<Lang, readonly string[]> = {
  en: [
    "Hi! I am a small assistant running on a scripted mock, so I always answer the same few things. Ask me anything.",
    "Sure. Here is one idea: write the task down in one sentence, then do the smallest next step.",
    "That is a good question. I cannot look it up offline, but I would start by splitting it into two smaller ones.",
    "Happy to help. Tell me a bit more about what you are trying to do and I will keep it short.",
    "Noted. Remember that every answer here is scripted, so the real fun starts with the Worker or your own key.",
  ],
  es: [
    "¡Hola! Soy un asistente pequeño que corre sobre un mock con respuestas fijas, así que siempre digo las mismas cosas. Pregúntame lo que quieras.",
    "Claro. Una idea: escribe la tarea en una frase y haz el siguiente paso más pequeño.",
    "Buena pregunta. Sin conexión no puedo consultarla, pero empezaría dividiéndola en dos más pequeñas.",
    "Encantado de ayudar. Cuéntame un poco más de lo que quieres hacer y respondo en corto.",
    "Anotado. Recuerda que todas las respuestas de aquí son guionizadas; lo interesante empieza con el Worker o con tu propia clave.",
  ],
};

/** The scripted replies, cycling, with one `rate_limit` (retry after 1500 ms) as the third call. */
export function mockScript(lang: Lang): ScriptEntry[] {
  const replies = REPLIES[lang];
  const script: ScriptEntry[] = [];
  let reply = 0;
  for (let call = 1; call <= MOCK_CALLS; call++) {
    if (call === RATE_LIMIT_CALL) {
      script.push({ error: { kind: "rate_limit", retryAfterMs: RATE_LIMIT_RETRY_AFTER_MS } });
    } else {
      script.push({ response: replies[reply++ % replies.length]! });
    }
  }
  return script;
}

/** A fresh scripted mock (it counts its calls, so one instance belongs to one conversation). */
export function createMock(lang: Lang): Provider {
  return new MockProvider(MOCK_LABEL, mockScript(lang));
}

export interface BuildConfig {
  endpoint: string;
  /** Only used by the `key` backend. Never put anywhere but the request header. */
  apiKey?: string;
  transport: HttpTransport;
  /** Waits between attempts: real in the app, instant in tests. */
  sleep: (ms: number) => Promise<void>;
  tracer: Tracer;
  /** The stateful mock of the conversation. */
  mock: Provider;
  /** Receives a copy of every request a leaf provider gets. */
  log?: CompletionRequest[];
}

const RETRY = { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 8000 } as const;

function leaf(label: string, inner: Provider, c: BuildConfig): Provider {
  return new TracedProvider(label, c.log ? new RecordingProvider(inner, c.log) : inner, c.tracer);
}

function retrying(inner: Provider, c: BuildConfig): Provider {
  return new RetryingProvider(inner, {
    ...RETRY,
    sleep: async (ms) => {
      c.tracer.push({ kind: "wait", ms, reason: c.tracer.lastFailure?.error ?? "rate_limit" });
      await c.sleep(ms);
    },
  });
}

/**
 * The provider chain of a backend, composed from the library: `Retrying(mock)` for the mock, and
 * `Fallback([Retrying(Http), Retrying(mock)])` for the worker and for the user's key.
 */
export function buildProvider(backend: Backend, c: BuildConfig): Provider {
  const mock = retrying(leaf(MOCK_LABEL, c.mock, c), c);
  if (backend === "mock") return mock;
  const http = new HttpProvider({
    id: GATEWAY_LABEL,
    endpoint: c.endpoint.trim(),
    transport: c.transport,
    ...(backend === "key" && c.apiKey !== undefined ? { apiKey: c.apiKey } : {}),
  });
  return new FallbackProvider([retrying(leaf(GATEWAY_LABEL, http, c), c), mock]);
}

/** The backend a turn really uses: the gateway ones need a valid endpoint, otherwise it is the mock. */
export function effectiveBackend(backend: Backend, gatewayOk: boolean): Backend {
  return backend !== "mock" && !gatewayOk ? "mock" : backend;
}

export type EndpointCheck = "empty" | "invalid" | "ok";

/** Hosts that may use plain `http://` (development only). */
const DEV_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "10.0.2.2"]);

const DNS_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6 = /^\[[0-9A-Fa-f:]*:[0-9A-Fa-f:]*(?:\.[0-9.]+)?\]$/;
const ENDPOINT_SHAPE = /^(https?):\/\/(\[[^\]\/?#@\s\\]*\]|[^\/:?#@\s\\\[\]]*)(?::([0-9]*))?(\/[^?#\s\\]*)?$/i;

function validHost(host: string): boolean {
  if (host.startsWith("[")) return IPV6.test(host);
  // Anything made only of digits and dots must be a dotted quad: `127.1` is not a host here.
  if (/^[0-9.]+$/.test(host)) {
    const m = IPV4.exec(host);
    return m !== null && m.slice(1).every((octet) => Number(octet) <= 255);
  }
  return host.length <= 253 && host.split(".").every((label) => DNS_LABEL.test(label));
}

/**
 * The one endpoint rule of both demos (the Android twin follows it to the letter): the scheme is case-insensitive;
 * `https://` takes any valid host, `http://` only `localhost`, `127.0.0.1` and `10.0.2.2`. A host is a DNS name
 * (letters, digits, hyphens and dots), a dotted-quad IPv4 or a bracketed IPv6. The port is optional (1 to 65535);
 * userinfo, query and fragment are not allowed; trailing slashes are trimmed later by the provider.
 */
export function checkEndpoint(raw: string): EndpointCheck {
  const value = raw.trim();
  if (value === "") return "empty";
  const m = ENDPOINT_SHAPE.exec(value);
  if (m === null) return "invalid";
  const scheme = m[1]!.toLowerCase();
  const host = m[2]!;
  const port = m[3];
  if (host === "" || !validHost(host)) return "invalid";
  if (port !== undefined && (port === "" || port.length > 5 || Number(port) < 1 || Number(port) > 65535)) return "invalid";
  if (scheme === "https") return "ok";
  return DEV_HOSTS.has(host.toLowerCase()) ? "ok" : "invalid";
}

/** The most the transport reads from a reply, in bytes. */
export const MAX_BODY_BYTES = 1_048_576;

/** An `HttpTransport` that also takes the signal of the caller: aborting it aborts the request in flight. */
export type SignalTransport = (req: HttpRequest, signal?: AbortSignal) => Promise<HttpResponse>;

function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/**
 * Reads at most `MAX_BODY_BYTES` of a reply, cancelling the stream as soon as it goes over. The bytes are decoded
 * with `ignoreBOM` so a leading BOM stays in the text (the gateway contract treats it as a failure).
 */
async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error("reply too large");
  }
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("reply too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

/**
 * The transport of the app: a thin `fetch` adapter. No cookies or credentials, redirects are never followed, the
 * timeout aborts the request and is reported as a `TransportTimeoutError`. When the caller's signal aborts, the
 * request is cancelled and a plain error is thrown. The reply is read as a stream with a
 * byte cap. Every other failure is a plain error with no detail (the provider maps it to `unavailable`).
 */
export function fetchTransport(fetchImpl: typeof fetch = (input, init) => fetch(input, init)): SignalTransport {
  return async (req, outer) => {
    const timeout = timeoutSignal(req.timeoutMs);
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (timeout.aborted || outer?.aborted) abort();
    timeout.addEventListener("abort", abort, { once: true });
    outer?.addEventListener("abort", abort, { once: true });
    try {
      const res = await fetchImpl(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        credentials: "omit",
        redirect: "manual",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      const body = await readCapped(res);
      const headers: Record<string, string> = {};
      res.headers.forEach((value, name) => {
        headers[name] = value;
      });
      return { status: res.status, headers, body };
    } catch (e) {
      if (outer?.aborted) throw new Error("request aborted");
      if (timeout.aborted) throw new TransportTimeoutError();
      throw new Error("network failure", { cause: e instanceof Error ? e.name : undefined });
    } finally {
      timeout.removeEventListener("abort", abort);
      outer?.removeEventListener("abort", abort);
    }
  };
}

/** A real wait that rejects when the signal aborts, so a retry loop stops instead of firing early. */
export function cancellableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("aborted", "AbortError"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** A real wait that ends early (resolves) when the signal aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

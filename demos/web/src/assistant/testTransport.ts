import { TransportTimeoutError, type HttpRequest, type HttpResponse, type HttpTransport } from "@ilabs/providers";

/** One scripted answer of the fake gateway. */
export type Step = HttpResponse | "timeout" | "network";

export const ok = (text: string): HttpResponse => ({ status: 200, headers: {}, body: JSON.stringify({ text, provider: "gateway" }) });
export const failure = (status: number, kind: string, retryAfterMs?: number, headers: Record<string, string> = {}): HttpResponse => ({
  status,
  headers,
  body: JSON.stringify({ error: { kind, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) } }),
});

/** A scripted fake transport that records every request; after the script ends it answers `unavailable`. No network. */
export function fakeTransport(steps: Step[]): { transport: HttpTransport; requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  let next = 0;
  const transport: HttpTransport = async (req) => {
    requests.push(req);
    const step = steps[next++] ?? failure(503, "unavailable");
    if (step === "timeout") throw new TransportTimeoutError();
    if (step === "network") throw new Error("network failure");
    return step;
  };
  return { transport, requests };
}

/** A transport that must never be called. */
export const noNetwork: HttpTransport = async () => {
  throw new Error("the test must not use the network");
};

/** A sleep that records the waits and returns at once. */
export function instantSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return { sleep: async (ms) => void waits.push(ms), waits };
}

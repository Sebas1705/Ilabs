import { EVAL_CASES, EVAL_EMAIL, FREE_TIER_PAUSE_MS, runEvals, type EvalRow, type RunEvalsOptions } from "./evalsSuite";
import { failure, fakeTransport, instantSleep, noNetwork, ok, type Step } from "./testTransport";

function options(over: Partial<RunEvalsOptions> = {}) {
  const slept = instantSleep();
  const pauses: number[] = [];
  const opts: RunEvalsOptions = {
    backend: "mock",
    endpoint: "https://gw.example.test",
    transport: noNetwork,
    sleep: slept.sleep,
    pause: async (ms) => void pauses.push(ms),
    lang: "en",
    budget: 600,
    redact: true,
    signal: new AbortController().signal,
    ...over,
  };
  return { opts, slept, pauses };
}

const statuses = (rows: EvalRow[]) => rows.map((r) => r.status);

describe("the assistant evals suite", () => {
  it("has five cases with distinct ids", () => {
    expect(EVAL_CASES).toHaveLength(5);
    expect(new Set(EVAL_CASES.map((c) => c.id)).size).toBe(5);
  });

  it("passes every case on the mock, offline, with no pause and the scripted retry", async () => {
    const { opts, slept, pauses } = options();
    const rows = await runEvals(opts);
    expect(statuses(rows)).toEqual(["pass", "pass", "pass", "pass", "pass"]);
    expect(pauses).toEqual([]);
    expect(slept.waits).toEqual([1500]);
    for (const row of rows) {
      expect(row.reply).toBeTruthy();
      expect(row.failed).toEqual([]);
      expect(row.leaked).toBe(false);
    }
  });

  it("passes every case on the mock in Spanish too; with redaction off the email and phone cases fail by design, because the secret reaches the provider", async () => {
    expect(statuses(await runEvals(options({ lang: "es" }).opts))).toEqual(["pass", "pass", "pass", "pass", "pass"]);
    // With redaction off the secrets do reach the provider: the request check catches it.
    const rows = await runEvals(options({ redact: false }).opts);
    expect(rows.find((r) => r.id === "email")).toMatchObject({ status: "fail", leaked: true });
    expect(rows.find((r) => r.id === "phone")).toMatchObject({ status: "fail", leaked: true });
    expect(rows.find((r) => r.id === "greeting")).toMatchObject({ status: "pass", leaked: false });
  });

  it("runs on a scripted worker, pauses 13 s between cases and passes with deterministic graders", async () => {
    const steps: Step[] = EVAL_CASES.map((c) => ok(`Reply to ${c.id}.`));
    const fake = fakeTransport(steps);
    const { opts, pauses } = options({ backend: "worker", transport: fake.transport });
    const rows = await runEvals(opts);
    expect(statuses(rows)).toEqual(["pass", "pass", "pass", "pass", "pass"]);
    expect(pauses).toEqual([FREE_TIER_PAUSE_MS, FREE_TIER_PAUSE_MS, FREE_TIER_PAUSE_MS, FREE_TIER_PAUSE_MS]);
    expect(fake.requests).toHaveLength(5);
    const emailBody = fake.requests[2]!.body;
    expect(emailBody).not.toContain(EVAL_EMAIL);
    expect(emailBody).toContain("<EMAIL_1>");
    expect(rows[2]!.leaked).toBe(false);
  });

  it("fails the email case when the worker echoes the email back, and the pause covers a longer retryAfterMs", async () => {
    const fake = fakeTransport([
      ok("Hello."),
      failure(429, "rate_limit", 20_000),
      failure(429, "rate_limit", 20_000),
      ok("Got it: <EMAIL_1>."),
    ]);
    const { opts, pauses } = options({ backend: "worker", transport: fake.transport });
    const rows = await runEvals(opts);
    // case 2 hit two rate limits and answered through the mock; case 3 echoed the placeholder, which the module restores
    expect(rows[1]!.status).toBe("pass");
    expect(rows[2]).toMatchObject({ id: "email", status: "fail", failed: ["notContains"], leaked: false });
    expect(pauses[0]).toBe(FREE_TIER_PAUSE_MS);
    expect(pauses[1]).toBe(20_000);
  });

  it("records an error row when the gateway answers invalid_output and goes on", async () => {
    const fake = fakeTransport([failure(502, "invalid_output"), ok("fine")]);
    const rows = await runEvals(options({ backend: "key", transport: fake.transport, apiKey: "K-TEST" }).opts);
    expect(rows[0]).toMatchObject({ id: "greeting", status: "error", error: "invalid_output" });
    expect(rows).toHaveLength(5);
    expect(JSON.stringify(rows)).not.toContain("K-TEST");
    expect(fake.requests[0]!.headers["x-ilabs-api-key"]).toBe("K-TEST");
  });

  it("stops after the case in flight when cancelled, and a cancel during the pause ends the run", async () => {
    const controller = new AbortController();
    const rows: EvalRow[] = [];
    const { opts } = options({ backend: "worker", transport: fakeTransport(EVAL_CASES.map(() => ok("hi"))).transport, signal: controller.signal });
    const out = await runEvals({
      ...opts,
      onRow: (row) => rows.push(row),
      pause: async () => controller.abort(),
    });
    expect(out).toHaveLength(1);
    expect(rows).toHaveLength(1);
  });

  it("reports progress through onStart", async () => {
    const started: number[] = [];
    await runEvals({ ...options().opts, onStart: (i) => started.push(i) });
    expect(started).toEqual([0, 1, 2, 3, 4]);
  });
});

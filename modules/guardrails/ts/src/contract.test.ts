import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runFixture, type Fixture, type FixtureRun } from "./contract.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../../contracts/guardrails");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort();
const raw = new Map(files.map((f) => [f, readFileSync(join(dir, f), "utf8")]));
const fixtures: Fixture[] = files.map((f) => JSON.parse(raw.get(f)!) as Fixture);

/** A fixture fragment as `JSON.parse` returns it (the tests mutate and index it freely). */
type Json = Record<string, ReturnType<typeof JSON.parse>>;

/** Compares a run with the fixture's expectation by the contract's comparison rules; throws on any mismatch. */
function checkRun(fx: Fixture, out: FixtureRun): void {
  const exp = fx.expect as Json;
  const kind = fx.setup.kind;
  expect(out.kind).toBe(kind);
  const hasClassifier = "classifier" in fx.setup;

  if ("error" in exp) {
    expect(out.output, `${fx.name}: expected error ${JSON.stringify(exp["error"])}`).toBeNull();
    expect(out.error, `${fx.name}: error`).not.toBeNull();
    expect(out.error!.kind, `${fx.name}: error kind`).toBe(exp["error"]["kind"]);
    if (kind === "guarded") {
      expect(out.calls, `${fx.name}: calls`).toBe(exp["calls"]);
      expect(Object.hasOwn(exp, "sent"), `${fx.name}: sent present exactly when calls is 1`).toBe(exp["calls"] === 1);
      expect(out.requests, `${fx.name}: requests`).toStrictEqual(exp["calls"] === 1 ? [{ messages: exp["sent"] }] : []);
      if ("classifierInputs" in exp) expect(out.classifierInputs, `${fx.name}: classifierInputs`).toStrictEqual(exp["classifierInputs"]);
      const two = out.second!;
      expect(two.error, `${fx.name}: GuardedProvider error`).not.toBeNull();
      expect(two.error!.kind, `${fx.name}: GuardedProvider error kind`).toBe(exp["error"]["kind"]);
      expect(two.calls, `${fx.name}: GuardedProvider calls`).toBe(exp["calls"]);
      expect(two.requests, `${fx.name}: GuardedProvider requests`).toStrictEqual(out.requests);
      if ("classifierInputs" in exp) expect(two.classifierInputs).toStrictEqual(exp["classifierInputs"]);
    } else {
      expect(out.second).toBeNull();
    }
    return;
  }

  expect(out.error, `${fx.name}: unexpected error ${JSON.stringify(out.error)}`).toBeNull();
  expect(Object.hasOwn(exp, "classifierInputs"), `${fx.name}: classifierInputs present exactly with a classifier`).toBe(hasClassifier);
  if (hasClassifier) expect(out.classifierInputs, `${fx.name}: classifierInputs`).toStrictEqual(exp["classifierInputs"]);
  const o = out.output!;
  switch (o.kind) {
    case "pii":
      expect(o.findings).toStrictEqual(exp["findings"]);
      break;
    case "redact":
      expect({ text: o.text, mapping: o.mapping }).toStrictEqual({ text: exp["text"], mapping: exp["mapping"] });
      break;
    case "restore":
      expect(o.text).toBe(exp["text"]);
      break;
    case "injection":
      expect(o.score).toBe(exp["score"]);
      expect(o.signals).toStrictEqual(exp["signals"]);
      break;
    case "check":
      expect(o.verdict).toBe(exp["verdict"]);
      expect(o.text).toBe(exp["text"]);
      expect(o.mapping).toStrictEqual(exp["mapping"]);
      expect(o.findings).toStrictEqual(exp["findings"]);
      break;
    case "policy":
      expect(exp["valid"]).toBe(true);
      break;
    case "canary":
      expect(o.messages).toStrictEqual(exp["messages"]);
      break;
    case "metrics":
      checkMetrics(fx.name, o, exp);
      break;
    case "eval":
      checkMetrics(`${fx.name} pii`, o.pii, exp["pii"]);
      checkMetrics(`${fx.name} injection`, o.injection, exp["injection"]);
      break;
    case "table":
      expect(o.table).toStrictEqual(exp);
      break;
    case "guarded": {
      const r = o.result;
      for (const k of ["text", "sent", "output"]) {
        expect(Object.hasOwn(r, k), `${fx.name}: ${k} present exactly when expected`).toBe(k in exp);
        if (k in exp) expect((r as Json)[k], `${fx.name}: ${k}`).toStrictEqual(exp[k]);
      }
      expect(r.status).toBe(exp["status"]);
      expect(r.input).toStrictEqual(exp["input"]);
      expect(r.calls).toBe(exp["calls"]);
      expect(r.mapping).toStrictEqual(exp["mapping"]);
      expect(r.outputMapping).toStrictEqual(exp["outputMapping"]);
      expect(out.calls, `${fx.name}: provider calls`).toBe(exp["calls"]);
      expect(out.requests, `${fx.name}: requests are exactly { messages: sent }`).toStrictEqual(exp["calls"] === 1 ? [{ messages: exp["sent"] }] : []);
      const two = out.second!;
      expect(two.error, `${fx.name}: GuardedProvider error`).toBeNull();
      expect(two.id, `${fx.name}: GuardedProvider id`).toBe("mock");
      expect(two.response!.provider).toBe("mock");
      expect(two.response!.text, `${fx.name}: GuardedProvider text`).toBe(exp["reply"]);
      expect(two.lastReport, `${fx.name}: lastReport`).toStrictEqual(r);
      expect(two.requests, `${fx.name}: GuardedProvider requests`).toStrictEqual(out.requests);
      if (hasClassifier) expect(two.classifierInputs, `${fx.name}: GuardedProvider classifierInputs`).toStrictEqual(exp["classifierInputs"]);
      break;
    }
  }
}

function checkMetrics(at: string, actual: Json, expected: Json): void {
  for (const k of ["precision", "recall", "f1"]) expect(actual[k], `${at}: ${k} by double value`).toBe(expected[k]);
  expect(actual["byKind"], `${at}: byKind`).toHaveLength(expected["byKind"].length);
  expected["byKind"].forEach((e: Json, i: number) => {
    const a = actual["byKind"][i];
    for (const k of ["kind", "precision", "recall", "f1", "expected", "found", "correct"]) expect(a[k], `${at}: byKind ${i} ${k}`).toBe(e[k]);
    expect(Object.keys(a).sort(), `${at}: byKind ${i} keys`).toEqual(["correct", "expected", "f1", "found", "kind", "precision", "recall"]);
  });
}

describe("guardrails contract fixtures", () => {
  it("loads all fixtures", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(265);
  });

  for (const fx of fixtures) {
    it(fx.name, async () => {
      checkRun(fx, await runFixture(fx));
    });
  }
});

describe("harness self-test: the comparators reject wrong data", () => {
  const byName = (n: string): Fixture => structuredClone(fixtures.find((f) => f.name === n)!);
  const runAndCheck = async (fx: Fixture, mutate: (exp: Json) => void, shouldPass: boolean) => {
    const out = await runFixture(fx);
    mutate(fx.expect as Json);
    if (shouldPass) checkRun(fx, out);
    else expect(() => checkRun(fx, out)).toThrow();
  };
  const rejects = (name: string, mutate: (e: Json) => void) => runAndCheck(byName(name), mutate, false);

  it("accepts the unmodified expectations", async () => {
    for (const n of ["pii-email-basic", "redact-numbering-per-kind", "injection-score-capped", "check-classifier-flagged", "guarded-ok-redact-and-restore", "guarded-provider-error", "metrics-partial", "eval-labelled-set", "table-pinned-constants", "canary-appended-to-first-system"]) {
      await runAndCheck(byName(n), () => {}, true);
    }
  });

  it("rejects wrong findings, offsets, text and kinds", async () => {
    await rejects("pii-email-basic", (e) => (e["findings"][0]["start"] += 1));
    await rejects("pii-email-basic", (e) => (e["findings"][0]["text"] += "x"));
    await rejects("pii-email-basic", (e) => (e["findings"][0]["kind"] = "phone"));
    await rejects("pii-email-basic", (e) => e["findings"].pop());
    await rejects("pii-email-basic", (e) => e["findings"].push(e["findings"][0]));
    await rejects("redact-numbering-per-kind", (e) => (e["text"] += " "));
    await rejects("redact-numbering-per-kind", (e) => e["mapping"].reverse());
    await rejects("restore-basic", (e) => (e["text"] = ""));
  });

  it("rejects a wrong score, signal order and signal span", async () => {
    await rejects("injection-score-capped", (e) => (e["score"] -= 1));
    await rejects("injection-signals-table-order", (e) => e["signals"].reverse());
    await rejects("injection-en-ignore-previous", (e) => (e["signals"][0]["end"] += 1));
  });

  it("rejects wrong verdicts, findings details and classifier inputs", async () => {
    await rejects("check-no-short-circuit", (e) => (e["verdict"] = "allow"));
    await rejects("check-deny-terms-token-sequence", (e) => e["findings"][0]["details"]["matches"].pop());
    await rejects("check-classifier-label-mismatch", (e) => delete e["findings"][0]["details"]["label"]);
    await rejects("check-classifier-label-mismatch", (e) => (e["findings"][1]["details"]["label"] = "x"));
    await rejects("check-classifier-flagged", (e) => e["classifierInputs"].push("extra"));
    await rejects("check-classifier-flagged", (e) => delete e["classifierInputs"]);
    await rejects("check-flag-keeps-text", (e) => (e["findings"][0]["fired"] = !e["findings"][0]["fired"]));
  });

  it("rejects wrong guarded keys, presence of optional keys, calls and replies", async () => {
    await rejects("guarded-ok-redact-and-restore", (e) => (e["text"] += "!"));
    await rejects("guarded-ok-redact-and-restore", (e) => delete e["text"]);
    await rejects("guarded-ok-redact-and-restore", (e) => (e["sent"][1]["content"] += " "));
    await rejects("guarded-ok-redact-and-restore", (e) => (e["reply"] += "!"));
    await rejects("guarded-ok-redact-and-restore", (e) => (e["calls"] = 0));
    await rejects("guarded-ok-redact-and-restore", (e) => (e["outputMapping"] = [["<EMAIL_9>", "x"]]));
    await rejects("guarded-blocked-input-zero-calls", (e) => (e["text"] = "x"));
    await rejects("guarded-blocked-input-zero-calls", (e) => (e["sent"] = []));
    await rejects("guarded-blocked-input-zero-calls", (e) => (e["reply"] = "other"));
    await rejects("guarded-blocked-output", (e) => (e["output"] = []));
    await rejects("guarded-provider-error", (e) => (e["error"]["kind"] = "rate_limit"));
    await rejects("guarded-provider-error", (e) => (e["calls"] = 0));
    await rejects("guarded-provider-error", (e) => delete e["sent"]);
    await rejects("guarded-no-classifier-zero-calls", (e) => (e["error"]["kind"] = "invalid_options"));
  });

  it("rejects wrong metric doubles by one ulp and wrong counts", async () => {
    await rejects("metrics-f1-one-division", (e) => (e["f1"] = 0.33333333333333337));
    await rejects("metrics-partial", (e) => (e["byKind"][0]["correct"] += 1));
    await rejects("metrics-partial", (e) => e["byKind"].reverse());
    await rejects("eval-labelled-set", (e) => (e["pii"]["precision"] = 0.76923076923077));
  });

  it("rejects a wrong table, canary message and wrong error kind", async () => {
    await rejects("table-pinned-constants", (e) => (e["injection"][0]["maxGap"] += 1));
    await rejects("table-pinned-constants", (e) => (e["injection"][0]["anchors"][0].pop()));
    await rejects("table-pinned-constants", (e) => e["secretPrefixes"].reverse());
    await rejects("table-pinned-constants", (e) => (e["canarySuffix"] += " "));
    await rejects("canary-appended-to-first-system", (e) => (e["messages"][0]["content"] += "\n"));
    await rejects("pii-kinds-empty-invalid", (e) => (e["error"]["kind"] = "invalid_policy"));
  });
});

const SETUP_KEYS: Record<string, string[]> = {
  pii: ["kind", "text", "kinds"],
  redact: ["kind", "text", "kinds", "mapping"],
  restore: ["kind", "text", "mapping"],
  injection: ["kind", "text"],
  check: ["kind", "text", "checks", "mapping", "classifier"],
  policy: ["kind", "policy"],
  guarded: ["kind", "request", "policy", "provider", "classifier", "blockedText"],
  canary: ["kind", "messages", "canary"],
  metrics: ["kind", "expected", "found"],
  eval: ["kind", "samples"],
  table: ["kind"],
};
const EXPECT_KEYS: Record<string, string[]> = {
  pii: ["findings"],
  redact: ["text", "mapping"],
  restore: ["text"],
  injection: ["score", "signals"],
  check: ["verdict", "text", "mapping", "findings", "classifierInputs"],
  policy: ["valid"],
  guarded: ["status", "text", "sent", "input", "output", "calls", "mapping", "outputMapping", "reply", "classifierInputs"],
  canary: ["messages"],
  metrics: ["precision", "recall", "f1", "byKind"],
  eval: ["pii", "injection"],
  table: ["piiKinds", "placeholderNames", "secretPrefixes", "dniLetters", "canaryPrefix", "canarySuffix", "canaryWhitespace", "defaultBlockedText", "metricKinds", "injection"],
};

describe("fixture files", () => {
  const keys = (o: unknown): string[] => Object.keys(o as object);
  const known = (name: string, actual: unknown, allowed: string[], where: string) => {
    expect(typeof actual === "object" && actual !== null && !Array.isArray(actual), `${name}: ${where} is an object`).toBe(true);
    expect(keys(actual).filter((k) => !allowed.includes(k)), `${name}: unknown key(s) in ${where}`).toEqual([]);
  };

  for (const file of files) {
    const fx = JSON.parse(raw.get(file)!) as Json;
    it(`${fx["name"]} is well formed`, () => {
      const name = fx["name"] as string;
      expect(`${name}.json`).toBe(file);
      expect(raw.get(file)!, `${name}: exactly JSON.stringify(x, null, 2) + LF`).toBe(JSON.stringify(fx, null, 2) + "\n");
      known(name, fx, ["name", "setup", "expect"], "fixture");
      const kind = fx["setup"]["kind"] as string;
      expect(Object.keys(SETUP_KEYS), `${name}: known kind`).toContain(kind);
      const setup = fx["setup"] as Json;
      known(name, setup, SETUP_KEYS[kind]!, "setup");
      const exp = fx["expect"] as Json;
      expect("classifierInputs" in exp, `${name}: classifierInputs present exactly with a classifier`).toBe("classifier" in setup);
      if ("error" in exp) {
        known(name, exp, kind === "guarded" ? ["error", "calls", "sent", "classifierInputs"] : ["error", "classifierInputs"], "expect");
        known(name, exp["error"], ["kind"], "expect.error");
      } else {
        known(name, exp, EXPECT_KEYS[kind]!, "expect");
        for (const k of EXPECT_KEYS[kind]!) {
          if (["text", "sent", "output", "classifierInputs"].includes(k) && (kind === "guarded" || kind === "check")) continue;
          expect(k in exp, `${name}: expect.${k}`).toBe(true);
        }
        expect("classifierInputs" in exp, `${name}: classifierInputs present exactly with a classifier`).toBe("classifier" in setup);
      }
      if (kind === "guarded") {
        known(name, setup["request"], ["messages"], "request");
        known(name, setup["provider"], ["script"], "provider");
        for (const m of setup["request"]["messages"]) known(name, m, ["role", "content"], "message");
        for (const e of setup["provider"]["script"]) {
          known(name, e, ["response", "error"], "script entry");
          if ("error" in e) known(name, e["error"], ["kind", "retryAfterMs"], "script error");
        }
        expect(setup["provider"]["script"].length, `${name}: provider script`).toBeGreaterThanOrEqual(0);
        for (const m of exp["sent"] ?? []) known(name, m, ["role", "content"], "sent message");
      }
      if ("classifier" in setup) {
        known(name, setup["classifier"], ["script"], "classifier");
        for (const e of setup["classifier"]["script"]) known(name, e, ["flagged", "label"], "classifier entry");
      }
      if (kind === "canary") for (const m of setup["messages"]) known(name, m, ["role", "content"], "message");
      if (kind === "metrics") for (const s of [...setup["expected"], ...setup["found"]]) known(name, s, ["kind", "start", "end"], "span");
      if (kind === "eval") {
        for (const s of setup["samples"]) {
          known(name, s, ["text", "expected"], "sample");
          for (const sp of s["expected"]) known(name, sp, ["kind", "start", "end"], "span");
        }
      }
      if ("findings" in exp && kind === "pii") for (const f of exp["findings"]) known(name, f, ["kind", "start", "end", "text"], "expected finding");
      if (kind === "injection") for (const s of exp["signals"] ?? []) known(name, s, ["id", "category", "start", "end"], "expected signal");
    });
  }
});

describe("runFixture rejects malformed fixtures", () => {
  const byName = (n: string): Json => structuredClone(fixtures.find((f) => f.name === n)!) as Json;
  const messageOf = async (fx: Json): Promise<string | undefined> => {
    const e = await runFixture(fx as Fixture).then(() => null, (x: unknown) => x);
    return (e as Error | null)?.message;
  };
  const expectInvalid = async (name: string, mutate: (fx: Json) => void, reason: string) => {
    const fx = byName(name);
    mutate(fx);
    expect(await messageOf(fx), `${name}: ${reason}`).toBe(`invalid fixture: ${reason}`);
  };

  it("rejects unknown setup kinds, also Object.prototype names", async () => {
    for (const kind of ["rerank", "constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
      await expectInvalid("pii-email-basic", (fx) => (fx["setup"]["kind"] = kind), `unknown setup kind: ${kind}`);
    }
  });

  it("a missing setup.kind is missing key: kind and a non-string one is wrong type: kind", async () => {
    await expectInvalid("pii-email-basic", (fx) => delete fx["setup"]["kind"], "missing key: kind");
    for (const kind of [5, null, true, ["pii"], {}]) {
      await expectInvalid("pii-email-basic", (fx) => (fx["setup"]["kind"] = kind), "wrong type: kind");
    }
  });

  it("name must be a string, and the whole setup is validated before the expectation", async () => {
    await expectInvalid("pii-email-basic", (fx) => (fx["name"] = 5), "wrong type: name");
    await expectInvalid("pii-email-basic", (fx) => (fx["setup"]["text"] = 5), "wrong type: text");
    await expectInvalid("pii-email-basic", (fx) => {
      fx["setup"]["text"] = 5;
      fx["expect"] = {};
    }, "wrong type: text");
    await expectInvalid("pii-email-basic", (fx) => {
      fx["setup"]["extra"] = 1;
      fx["expect"]["bogus"] = 1;
    }, "unknown key: extra");
    await expectInvalid("guarded-ok-redact-and-restore", (fx) => {
      fx["setup"]["request"]["messages"][0]["role"] = "tool";
      delete fx["expect"]["reply"];
    }, "wrong type: role");
  });

  it("an unknown role in a fixture message is wrong type: role", async () => {
    for (const name of ["guarded-ok-redact-and-restore", "canary-appended-to-first-system"]) {
      const path = name.startsWith("guarded") ? (fx: Json) => fx["setup"]["request"]["messages"] : (fx: Json) => fx["setup"]["messages"];
      await expectInvalid(name, (fx) => (path(fx)[0]["role"] = "tool"), "wrong type: role");
      await expectInvalid(name, (fx) => (path(fx)[0]["role"] = "System"), "wrong type: role");
    }
  });

  it("classifierInputs is required iff the setup has a classifier, error expectations included", async () => {
    await expectInvalid("check-no-classifier-error", (fx) => (fx["expect"]["classifierInputs"] = []), "unknown key: classifierInputs");
    await expectInvalid("guarded-provider-error", (fx) => (fx["expect"]["classifierInputs"] = []), "unknown key: classifierInputs");
    await expectInvalid("check-classifier-flagged", (fx) => {
      fx["expect"] = { error: { kind: "invalid_policy" } };
    }, "missing key: classifierInputs");
    await expectInvalid("guarded-classifier-call-order", (fx) => {
      fx["expect"] = { error: { kind: "timeout" }, calls: 0 };
    }, "missing key: classifierInputs");
  });

  it("an invalid checks list with a classifier gives an invalid_policy result and no classifier input", async () => {
    const fx = byName("check-classifier-flagged");
    fx["setup"]["checks"] = [{ kind: "nope", action: "block" }];
    fx["expect"] = { error: { kind: "invalid_policy" }, classifierInputs: [] };
    const out = await runFixture(fx as Fixture);
    expect(out.error).toStrictEqual({ kind: "invalid_policy" });
    expect(out.classifierInputs).toStrictEqual([]);
  });

  it("a script error retryAfterMs is an integral number or absent", async () => {
    await expectInvalid("guarded-provider-error", (fx) => (fx["setup"]["provider"]["script"][0]["error"]["retryAfterMs"] = null), "wrong type: retryAfterMs");
    await expectInvalid("guarded-provider-error", (fx) => (fx["setup"]["provider"]["script"][0]["error"]["retryAfterMs"] = 1.5), "wrong type: retryAfterMs");
    const ok = byName("guarded-provider-error");
    ok["setup"]["provider"]["script"][0]["error"]["retryAfterMs"] = 250;
    checkRun(ok as Fixture, await runFixture(ok as Fixture));
  });

  it("rejects unknown keys at every level, naming only the key", async () => {
    const cases: Array<[string, (fx: Json) => void, string]> = [
      ["pii-email-basic", (fx) => (fx["extra"] = 1), "extra"],
      ["pii-email-basic", (fx) => (fx["setup"]["mapping"] = []), "mapping"],
      ["pii-email-basic", (fx) => (fx["expect"]["extra"] = 1), "extra"],
      ["guarded-ok-redact-and-restore", (fx) => (fx["setup"]["request"]["model"] = "x"), "model"],
      ["guarded-ok-redact-and-restore", (fx) => (fx["setup"]["request"]["messages"][0]["name"] = "x"), "name"],
      ["guarded-ok-redact-and-restore", (fx) => (fx["setup"]["provider"]["id"] = "x"), "id"],
      ["guarded-ok-redact-and-restore", (fx) => (fx["setup"]["provider"]["script"][0]["extra"] = 1), "extra"],
      ["guarded-provider-error", (fx) => (fx["setup"]["provider"]["script"][0]["error"]["extra"] = 1), "extra"],
      ["guarded-classifier-call-order", (fx) => (fx["setup"]["classifier"]["extra"] = 1), "extra"],
      ["guarded-classifier-call-order", (fx) => (fx["setup"]["classifier"]["script"][0]["extra"] = 1), "extra"],
      ["eval-labelled-set", (fx) => (fx["setup"]["samples"][0]["extra"] = 1), "extra"],
      ["eval-labelled-set", (fx) => (fx["setup"]["samples"][0]["expected"][0]["extra"] = 1), "extra"],
      ["metrics-partial", (fx) => (fx["setup"]["expected"][0]["extra"] = 1), "extra"],
      ["table-pinned-constants", (fx) => (fx["setup"]["text"] = "x"), "text"],
      ["guarded-provider-error", (fx) => (fx["expect"]["extra"] = 1), "extra"],
      ["guarded-ok-redact-and-restore", (fx) => (fx["expect"]["classifierInputs"] = []), "classifierInputs"],
      ["canary-appended-to-first-system", (fx) => (fx["setup"]["messages"][0]["extra"] = 1), "extra"],
    ];
    for (const [name, mutate, key] of cases) await expectInvalid(name, mutate, `unknown key: ${key}`);
  });

  it("rejects missing required keys, naming only the key", async () => {
    const cases: Array<[string, (fx: Json) => void, string]> = [
      ["pii-email-basic", (fx) => delete fx["name"], "name"],
      ["pii-email-basic", (fx) => delete fx["setup"], "setup"],
      ["pii-email-basic", (fx) => delete fx["setup"]["text"], "text"],
      ["restore-basic", (fx) => delete fx["setup"]["mapping"], "mapping"],
      ["check-classifier-flagged", (fx) => delete fx["setup"]["checks"], "checks"],
      ["policy-valid-minimal", (fx) => delete fx["setup"]["policy"], "policy"],
      ["guarded-ok-redact-and-restore", (fx) => delete fx["setup"]["request"], "request"],
      ["guarded-ok-redact-and-restore", (fx) => delete fx["setup"]["provider"], "provider"],
      ["guarded-ok-redact-and-restore", (fx) => delete fx["setup"]["request"]["messages"], "messages"],
      ["guarded-ok-redact-and-restore", (fx) => delete fx["setup"]["request"]["messages"][0]["role"], "role"],
      ["guarded-ok-redact-and-restore", (fx) => delete fx["setup"]["request"]["messages"][1]["content"], "content"],
      ["guarded-ok-redact-and-restore", (fx) => delete fx["setup"]["provider"]["script"], "script"],
      ["guarded-classifier-call-order", (fx) => delete fx["setup"]["classifier"]["script"][0]["flagged"], "flagged"],
      ["guarded-classifier-call-order", (fx) => delete fx["setup"]["classifier"]["script"], "script"],
      ["canary-appended-to-first-system", (fx) => delete fx["setup"]["canary"], "canary"],
      ["canary-appended-to-first-system", (fx) => delete fx["setup"]["messages"], "messages"],
      ["metrics-partial", (fx) => delete fx["setup"]["found"], "found"],
      ["metrics-partial", (fx) => delete fx["setup"]["expected"][0]["start"], "start"],
      ["eval-labelled-set", (fx) => delete fx["setup"]["samples"], "samples"],
      ["eval-labelled-set", (fx) => delete fx["setup"]["samples"][0]["expected"], "expected"],
      ["eval-labelled-set", (fx) => delete fx["setup"]["samples"][0]["text"], "text"],
      ["eval-labelled-set", (fx) => delete fx["setup"]["samples"][0]["expected"][0]["kind"], "kind"],
      ["guarded-provider-error", (fx) => delete fx["setup"]["provider"]["script"][0]["error"]["kind"], "kind"],
      ["guarded-provider-error", (fx) => delete fx["expect"]["calls"], "calls"],
      ["check-classifier-flagged", (fx) => delete fx["expect"]["classifierInputs"], "classifierInputs"],
    ];
    for (const [name, mutate, key] of cases) await expectInvalid(name, mutate, `missing key: ${key}`);
  });

  it("checks JSON types in the harness: a wrong type is a malformed fixture", async () => {
    const cases: Array<[string, (fx: Json) => void, string]> = [
      ["pii-email-basic", (fx) => (fx["setup"]["text"] = 5), "text"],
      ["pii-kinds-only-listed", (fx) => (fx["setup"]["kinds"] = "email"), "kinds"],
      ["pii-kinds-only-listed", (fx) => (fx["setup"]["kinds"] = [1]), "kinds"],
      ["pii-email-basic", (fx) => (fx["setup"] = []), "setup"],
      ["redact-extends-mapping", (fx) => (fx["setup"]["mapping"] = "x"), "mapping"],
      ["redact-extends-mapping", (fx) => (fx["setup"]["mapping"] = [1]), "mapping"],
      ["redact-extends-mapping", (fx) => (fx["setup"]["mapping"] = [["a"]]), "mapping"],
      ["redact-extends-mapping", (fx) => (fx["setup"]["mapping"] = [["a", 1]]), "mapping"],
      ["guarded-ok-redact-and-restore", (fx) => (fx["setup"]["request"]["messages"] = {}), "messages"],
      ["guarded-ok-redact-and-restore", (fx) => (fx["setup"]["request"]["messages"][0]["content"] = 1), "content"],
      ["guarded-ok-redact-and-restore", (fx) => (fx["setup"]["request"]["messages"][0]["role"] = null), "role"],
      ["guarded-ok-redact-and-restore", (fx) => (fx["setup"]["request"]["messages"][0] = "x"), "messages"],
      ["guarded-ok-redact-and-restore", (fx) => (fx["setup"]["request"] = []), "request"],
      ["guarded-ok-redact-and-restore", (fx) => (fx["setup"]["provider"]["script"] = "x"), "script"],
      ["guarded-ok-redact-and-restore", (fx) => (fx["setup"]["provider"]["script"][0] = { response: 1 }), "response"],
      ["guarded-provider-error", (fx) => (fx["setup"]["provider"]["script"][0]["error"]["retryAfterMs"] = "x"), "retryAfterMs"],
      ["guarded-custom-blocked-text", (fx) => (fx["setup"]["blockedText"] = 1), "blockedText"],
      ["guarded-classifier-call-order", (fx) => (fx["setup"]["classifier"]["script"][0]["flagged"] = "yes"), "flagged"],
      ["check-classifier-label-match", (fx) => (fx["setup"]["classifier"]["script"][0]["label"] = 1), "label"],
      ["guarded-classifier-call-order", (fx) => (fx["setup"]["classifier"]["script"] = {}), "script"],
      ["canary-appended-to-first-system", (fx) => (fx["setup"]["canary"] = 5), "canary"],
      ["canary-appended-to-first-system", (fx) => (fx["setup"]["messages"] = "x"), "messages"],
      ["metrics-partial", (fx) => (fx["setup"]["expected"] = "x"), "expected"],
      ["metrics-partial", (fx) => (fx["setup"]["found"] = {}), "found"],
      ["metrics-partial", (fx) => (fx["setup"]["expected"][0]["start"] = 1.5), "start"],
      ["metrics-partial", (fx) => (fx["setup"]["expected"][0]["end"] = "3"), "end"],
      ["metrics-partial", (fx) => (fx["setup"]["expected"][0]["kind"] = 3), "kind"],
      ["eval-labelled-set", (fx) => (fx["setup"]["samples"] = {}), "samples"],
      ["eval-labelled-set", (fx) => (fx["setup"]["samples"][0]["text"] = 1), "text"],
      ["eval-labelled-set", (fx) => (fx["setup"]["samples"][0]["expected"] = "x"), "expected"],
      ["eval-labelled-set", (fx) => (fx["setup"]["samples"][0]["expected"][0]["end"] = null), "end"],
    ];
    for (const [name, mutate, key] of cases) await expectInvalid(name, mutate, `wrong type: ${key}`);
  });

  it("uses the pinned wording for script entries and classifier exhaustion", async () => {
    await expectInvalid("guarded-ok-redact-and-restore", (fx) => (fx["setup"]["provider"]["script"][0] = {}), "script entry 1 of provider mock has neither response nor error");
    await expectInvalid("guarded-ok-redact-and-restore", (fx) => (fx["setup"]["provider"]["script"][0] = { extra: 1 }), "script entry 1 of provider mock has neither response nor error");
    await expectInvalid("guarded-provider-error", (fx) => (fx["setup"]["provider"]["script"][0]["error"]["kind"] = "boom"), "unknown provider error kind: boom");
    await expectInvalid("guarded-classifier-call-order", (fx) => (fx["setup"]["classifier"]["script"] = fx["setup"]["classifier"]["script"].slice(0, 1)), "classifier script exhausted");
    await expectInvalid("check-classifier-flagged", (fx) => (fx["setup"]["classifier"]["script"] = []), "classifier script exhausted");
  });

  it("rejects an eval span outside its sample text (code points, not UTF-16 units)", async () => {
    await expectInvalid("eval-labelled-set", (fx) => (fx["setup"]["samples"][0]["expected"][0]["start"] = -1), "span outside sample text");
    await expectInvalid("eval-labelled-set", (fx) => (fx["setup"]["samples"][0]["expected"][0]["end"] = 9999), "span outside sample text");
    await expectInvalid("eval-labelled-set", (fx) => {
      const sp = fx["setup"]["samples"][0]["expected"][0];
      sp["start"] = 5;
      sp["end"] = 4;
    }, "span outside sample text");
    const ok = byName("eval-shift-length-plus-one");
    ok["setup"]["samples"] = [{ text: "😀", expected: [{ kind: "email", start: 0, end: 1 }] }];
    ok["expect"] = { pii: { precision: 1, recall: 0, f1: 0, byKind: [{ kind: "email", precision: 1, recall: 0, f1: 0, expected: 1, found: 0, correct: 0 }] }, injection: { precision: 1, recall: 1, f1: 1, byKind: [] } };
    checkRun(ok as Fixture, await runFixture(ok as Fixture));
    ok["setup"]["samples"][0]["expected"][0]["end"] = 2;
    expect(await messageOf(ok)).toBe("invalid fixture: span outside sample text");
  });

  it("rejects an expect with neither the keys of its kind nor error", async () => {
    await expectInvalid("pii-email-basic", (fx) => (fx["expect"] = {}), "expect has neither the keys of its kind nor error");
    await expectInvalid("pii-email-basic", (fx) => (fx["expect"] = { tokens: [] }), "expect has neither the keys of its kind nor error");
    await expectInvalid("guarded-ok-redact-and-restore", (fx) => delete fx["expect"]["reply"], "expect has neither the keys of its kind nor error");
    await expectInvalid("pii-email-basic", (fx) => (fx["expect"] = []), "wrong type: expect");
  });

  it("passes library errors through as results, not malformed fixtures", async () => {
    const fx = byName("pii-email-basic");
    fx["setup"]["kinds"] = ["nope"];
    fx["expect"] = { error: { kind: "invalid_options" } };
    const out = await runFixture(fx as Fixture);
    expect(out.error).toStrictEqual({ kind: "invalid_options" });
    const p = byName("policy-valid-minimal");
    p["setup"]["policy"] = 5;
    p["expect"] = { error: { kind: "invalid_policy" } };
    expect((await runFixture(p as Fixture)).error).toStrictEqual({ kind: "invalid_policy" });
    const g = byName("guarded-provider-error");
    g["setup"]["policy"] = { input: [{ kind: "x", action: "block" }], output: [] };
    g["expect"] = { error: { kind: "invalid_policy" }, calls: 0 };
    const gr = await runFixture(g as Fixture);
    expect(gr.error).toStrictEqual({ kind: "invalid_policy" });
    expect(gr.second!.error).toStrictEqual({ kind: "invalid_policy" });
  });

  it("does not convert non-library exceptions into results", async () => {
    // A classifier called more often than scripted is a malformed fixture, never an error result.
    const fx = byName("check-classifier-flagged");
    fx["setup"]["classifier"]["script"] = [];
    expect(await messageOf(fx)).toBe("invalid fixture: classifier script exhausted");
  });
});

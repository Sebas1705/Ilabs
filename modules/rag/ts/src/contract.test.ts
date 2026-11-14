import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runFixture, type Fixture, type FixtureRun } from "./contract.js";
import type { Hit, RetrievalMetrics } from "./types.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../../contracts/rag");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort();
const raw = new Map(files.map((f) => [f, readFileSync(join(dir, f), "utf8")]));
const fixtures: Fixture[] = files.map((f) => JSON.parse(raw.get(f)!) as Fixture);

const TOLERANCE = 1e-9;
type Json = Record<string, any>;

function compareHits(name: string, actual: Hit[], expected: Json[]): void {
  expect(actual, `${name}: number of hits`).toHaveLength(expected.length);
  expected.forEach((eh, i) => {
    const ah = actual[i]!;
    const at = `${name} hit ${i}`;
    expect(ah.chunkId, at).toBe(eh["chunkId"]);
    expect(ah.docId, at).toBe(eh["docId"]);
    expect(ah.rank, at).toBe(eh["rank"]);
    expect(Math.abs(ah.score - (eh["score"] as number)), `${at}: score ${ah.score} vs ${eh["score"]}`).toBeLessThanOrEqual(TOLERANCE);
    for (const k of ["bm25Rank", "denseRank"] as const) {
      expect(Object.hasOwn(ah, k), `${at}: ${k} present exactly when expected`).toBe(k in eh);
      if (k in eh) expect(ah[k], `${at}: ${k}`).toBe(eh[k]);
    }
  });
}

function compareMetrics(at: string, actual: RetrievalMetrics, expected: Json): void {
  expect(actual.recallAtK, `${at}: recallAtK by double value`).toBe(expected["recallAtK"]);
  expect(actual.precisionAtK, `${at}: precisionAtK by double value`).toBe(expected["precisionAtK"]);
  expect(actual.reciprocalRank, `${at}: reciprocalRank by double value`).toBe(expected["reciprocalRank"]);
  expect(actual.hit, `${at}: hit`).toBe(expected["hit"]);
}

function checkRequest(name: string, out: FixtureRun, exp: Json): void {
  const request = exp["request"] as { system: string; user: string } | undefined;
  if (request === undefined) {
    expect(out.requests, `${name}: no request recorded`).toEqual([]);
    return;
  }
  expect(out.requests, `${name}: exactly one request recorded`).toHaveLength(1);
  const req = out.requests[0]!;
  expect(Object.keys(req), `${name}: a request has exactly messages`).toEqual(["messages"]);
  expect(req.messages).toHaveLength(2);
  for (const m of req.messages) expect(Object.keys(m).sort(), `${name}: message keys`).toEqual(["content", "role"]);
  expect(req).toStrictEqual({
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.user },
    ],
  });
}

describe("rag contract fixtures", () => {
  it("loads all fixtures", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(144);
  });

  for (const fx of fixtures) {
    it(fx.name, async () => {
      checkRun(fx, await runFixture(fx));
    });
  }
});

/** Compares a run with the fixture's expectation by the contract's comparison rules; throws on any mismatch. */
function checkRun(fx: Fixture, out: FixtureRun): void {
      const exp = fx.expect as Json;
      const kind = fx.setup.kind;
      expect(out.kind).toBe(kind);

      if (kind === "answer") {
        expect(exp["calls"], `${fx.name}: answer fixtures declare calls`).toBeDefined();
        expect(out.calls, `${fx.name}: calls`).toBe(exp["calls"]);
        checkRequest(fx.name, out, exp);
      } else {
        expect(out.calls, `${fx.name}: only answer fixtures call a provider`).toBe(0);
      }

      if ("error" in exp) {
        const ee = exp["error"] as Json;
        expect(out.output, `${fx.name}: expected error ${JSON.stringify(ee)}`).toBeNull();
        expect(out.error).not.toBeNull();
        expect(out.error!.kind, `${fx.name}: error kind`).toBe(ee["kind"]);
        expect(Object.hasOwn(out.error!, "required"), `${fx.name}: required present exactly when expected`).toBe("required" in ee);
        if ("required" in ee) expect(out.error!.required, `${fx.name}: required`).toBe(ee["required"]);
        return;
      }

      expect(out.error, `${fx.name}: unexpected error ${JSON.stringify(out.error)}`).toBeNull();
      const o = out.output!;
      switch (o.kind) {
        case "tokens":
          expect(o.tokens).toStrictEqual(exp["tokens"]);
          break;
        case "chunk":
          expect(o.chunks).toStrictEqual(exp["chunks"]);
          for (const c of o.chunks) expect(Object.keys(c).sort()).toEqual(["docId", "end", "id", "index", "start", "text"]);
          break;
        case "embed": {
          const en = exp["nonZero"] as Array<[number, number]>;
          expect(o.nonZero.map(([b]) => b), `${fx.name}: non-zero buckets`).toEqual(en.map(([b]) => b));
          o.nonZero.forEach(([, v], i) => {
            expect(Math.abs(v - en[i]![1]), `${fx.name}: bucket ${en[i]![0]}`).toBeLessThanOrEqual(TOLERANCE);
          });
          break;
        }
        case "search":
          compareHits(fx.name, o.hits, exp["hits"]);
          break;
        case "context":
          expect(o.message).toStrictEqual(exp["message"]);
          expect(Object.keys(o.message).sort()).toEqual(["content", "role"]);
          expect(o.sources).toStrictEqual(exp["sources"]);
          expect(o.droppedCount).toBe(exp["droppedCount"]);
          break;
        case "citations":
          expect({ cited: o.cited, unknown: o.unknown }).toStrictEqual({ cited: exp["cited"], unknown: exp["unknown"] });
          break;
        case "metrics":
          compareMetrics(fx.name, o, exp);
          break;
        case "eval": {
          const eq = exp["questions"] as Json[];
          expect(o.questions).toHaveLength(eq.length);
          eq.forEach((q, i) => {
            for (const mode of ["bm25", "dense", "hybrid"] as const) {
              const at = `${fx.name} question ${i} ${mode}`;
              const em = q["modes"][mode] as Json;
              const am = o.questions[i]!.modes[mode];
              expect(am.hitIds, at).toStrictEqual(em["hitIds"]);
              compareMetrics(at, am, em);
            }
          });
          break;
        }
        case "answer":
          expect(o.answer).toBe(exp["answer"]);
          expect(o.sources).toStrictEqual(exp["sources"]);
          expect(o.citations).toStrictEqual(exp["citations"]);
          expect(o.hitIds).toStrictEqual(exp["hitIds"]);
          break;
      }
}

describe("harness self-test: the comparators reject wrong data", () => {
  const byName = (n: string): Fixture => structuredClone(fixtures.find((f) => f.name === n)!);
  const runAndCheck = async (fx: Fixture, mutateExpect: (exp: Json) => void, shouldPass: boolean) => {
    const out = await runFixture(fx);
    mutateExpect(fx.expect as Json);
    if (shouldPass) checkRun(fx, out);
    else expect(() => checkRun(fx, out)).toThrow();
  };

  it("accepts the unmodified expectations and a score within 1e-9", async () => {
    for (const n of ["bm25-basic-ranking", "context-basic", "citations-basic", "answer-basic", "context-first-source-too-big"]) {
      await runAndCheck(byName(n), () => {}, true);
    }
    await runAndCheck(byName("bm25-basic-ranking"), (e) => (e["hits"][0]["score"] += 0.5e-9), true);
  });

  it("rejects a score off by 2e-9", async () => {
    await runAndCheck(byName("bm25-basic-ranking"), (e) => (e["hits"][0]["score"] += 2e-9), false);
    await runAndCheck(byName("embed-dim-small"), (e) => (e["nonZero"][0][1] -= 2e-9), false);
  });

  it("rejects an extra or missing rank field", async () => {
    await runAndCheck(byName("bm25-basic-ranking"), (e) => (e["hits"][0]["bm25Rank"] = 1), false);
    await runAndCheck(byName("hybrid-chunk-in-one-list"), (e) => delete e["hits"][0]["denseRank"], false);
  });

  it("rejects a wrong required and a wrong error kind", async () => {
    await runAndCheck(byName("context-first-source-too-big"), (e) => (e["error"]["required"] += 1), false);
    await runAndCheck(byName("context-first-source-too-big"), (e) => delete e["error"]["required"], false);
    await runAndCheck(byName("invalid-topk-zero"), (e) => (e["error"]["kind"] = "no_embedder"), false);
  });

  it("rejects a missing or extra hit", async () => {
    await runAndCheck(byName("bm25-basic-ranking"), (e) => e["hits"].pop(), false);
    await runAndCheck(byName("bm25-zero-score-excluded"), (e) => e["hits"].push({ ...e["hits"][0], rank: 2 }), false);
  });

  it("rejects one wrong byte of the composed message or of the answer", async () => {
    await runAndCheck(byName("context-basic"), (e) => (e["message"]["content"] = `${e["message"]["content"].slice(0, -1)}!`), false);
    await runAndCheck(byName("answer-basic"), (e) => (e["request"]["system"] += " "), false);
    await runAndCheck(byName("answer-reply-verbatim"), (e) => (e["answer"] = e["answer"].trim()), false);
  });

  it("rejects wrong citation lists, sources, calls and metrics", async () => {
    await runAndCheck(byName("citations-dedupe-order"), (e) => e["cited"].reverse(), false);
    await runAndCheck(byName("citations-unknown"), (e) => (e["unknown"] = []), false);
    await runAndCheck(byName("context-basic"), (e) => (e["sources"][0]["docId"] = "x"), false);
    await runAndCheck(byName("answer-basic"), (e) => (e["calls"] = 0), false);
    await runAndCheck(byName("metrics-recall-precision"), (e) => (e["precisionAtK"] = 0.5000000000000001), false);
    await runAndCheck(byName("chunk-fixed-basic"), (e) => (e["chunks"][0]["end"] += 1), false);
    await runAndCheck(byName("tokens-digits"), (e) => e["tokens"].pop(), false);
  });
});

const SETUP_KEYS: Record<string, string[]> = {
  tokens: ["kind", "text"],
  chunk: ["kind", "documents", "chunking"],
  embed: ["kind", "text", "dim"],
  search: ["kind", "documents", "chunking", "embedder", "query", "mode", "topK", "candidates"],
  context: ["kind", "documents", "chunking", "embedder", "query", "mode", "topK", "candidates", "maxTokens"],
  citations: ["kind", "sources", "answer"],
  metrics: ["kind", "hits", "relevant", "level"],
  eval: ["kind", "documents", "chunking", "embedder", "topK", "questions"],
  answer: ["kind", "documents", "chunking", "embedder", "query", "mode", "topK", "candidates", "maxTokens", "provider"],
};
const EXPECT_KEYS: Record<string, string[]> = {
  tokens: ["tokens"],
  chunk: ["chunks"],
  embed: ["nonZero"],
  search: ["hits"],
  context: ["message", "sources", "droppedCount"],
  citations: ["cited", "unknown"],
  metrics: ["recallAtK", "precisionAtK", "reciprocalRank", "hit"],
  eval: ["questions"],
  answer: ["answer", "sources", "citations", "hitIds", "calls", "request"],
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
      // A Windows checkout may convert LF to CRLF (core.autocrlf); the committed bytes are what the contract pins.
      expect(raw.get(file)!.replaceAll("\r\n", "\n"), `${name}: exactly JSON.stringify(x, null, 2) + LF`).toBe(JSON.stringify(fx, null, 2) + "\n");
      known(name, fx, ["name", "setup", "expect"], "fixture");
      const kind = fx["setup"]["kind"] as string;
      expect(Object.keys(SETUP_KEYS), `${name}: known kind`).toContain(kind);
      known(name, fx["setup"], SETUP_KEYS[kind]!, "setup");
      const exp = fx["expect"] as Json;
      if ("error" in exp) {
        known(name, exp, kind === "answer" ? ["error", "calls", "request"] : ["error"], "expect");
        known(name, exp["error"], ["kind", "required"], "expect.error");
      } else {
        known(name, exp, EXPECT_KEYS[kind]!, "expect");
        for (const k of EXPECT_KEYS[kind]!) if (k !== "request") expect(k in exp, `${name}: expect.${k}`).toBe(true);
        for (const h of exp["hits"] ?? []) known(name, h, ["chunkId", "docId", "rank", "score", "bm25Rank", "denseRank"], "expected hit");
        for (const s of exp["sources"] ?? []) known(name, s, ["n", "chunkId", "docId"], "expected source");
        for (const q of exp["questions"] ?? []) {
          known(name, q, ["modes"], "expected question");
          known(name, q["modes"], ["bm25", "dense", "hybrid"], "expected modes");
          for (const m of Object.values(q["modes"])) known(name, m, ["hitIds", "recallAtK", "precisionAtK", "reciprocalRank", "hit"], "expected mode");
        }
      }
      if (kind === "answer") {
        expect(typeof exp["calls"], `${name}: calls declared`).toBe("number");
        expect("request" in exp, `${name}: request present exactly when calls > 0`).toBe(exp["calls"] > 0);
        if ("request" in exp) known(name, exp["request"], ["system", "user"], "expect.request");
      }
    });
  }
});

describe("runFixture rejects malformed fixtures", () => {
  const byName = (n: string): Json => structuredClone(fixtures.find((f) => f.name === n)!) as Json;
  const rejects = async (fx: Json, message: string | RegExp = /^invalid fixture: /) => {
    await expect(runFixture(fx as Fixture)).rejects.toThrow(message);
  };

  it("rejects an unknown setup kind", async () => {
    const fx = byName("tokens-digits");
    fx["setup"]["kind"] = "rerank";
    await rejects(fx, "invalid fixture: unknown setup kind: rerank");
  });

  it("rejects setup kinds that are Object.prototype keys", async () => {
    for (const kind of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
      const fx = byName("tokens-digits");
      fx["setup"]["kind"] = kind;
      await rejects(fx, `invalid fixture: unknown setup kind: ${kind}`);
    }
  });

  it("checks JSON types in the harness: a wrong type is a malformed fixture", async () => {
    const cases: Array<[string, (fx: Json) => void, string]> = [
      ["chunk-fixed-basic", (fx) => (fx["setup"]["documents"][0]["id"] = 7), "document 1 id must be a string"],
      ["chunk-fixed-basic", (fx) => (fx["setup"]["documents"][0]["text"] = null), "document 1 text must be a string"],
      ["chunk-fixed-basic", (fx) => (fx["setup"]["chunking"]["size"] = "4"), "chunking.size must be a number or null"],
      ["chunk-fixed-basic", (fx) => (fx["setup"]["chunking"]["type"] = 1), "chunking type must be a string"],
      ["chunk-paragraph-pack", (fx) => (fx["setup"]["chunking"]["maxSize"] = true), "chunking.maxSize must be a number or null"],
      ["dense-basic-ranking", (fx) => (fx["setup"]["embedder"]["dim"] = "8"), "hash embedder.dim must be a number or null"],
      ["embed-dim-small", (fx) => (fx["setup"]["dim"] = "3"), "setup.dim must be a number or null"],
      ["embed-dim-small", (fx) => (fx["setup"]["text"] = 1), "text must be a string"],
      ["tokens-digits", (fx) => (fx["setup"]["text"] = ["a"]), "text must be a string"],
      ["bm25-basic-ranking", (fx) => (fx["setup"]["query"] = null), "query must be a string"],
      ["bm25-basic-ranking", (fx) => (fx["setup"]["mode"] = 1), "setup.mode must be a string or null"],
      ["bm25-basic-ranking", (fx) => (fx["setup"]["topK"] = "3"), "setup.topK must be a number or null"],
      ["hybrid-candidates-cut", (fx) => (fx["setup"]["candidates"] = [2]), "setup.candidates must be a number or null"],
      ["context-basic", (fx) => (fx["setup"]["maxTokens"] = "200"), "setup.maxTokens must be a number or null"],
      ["citations-basic", (fx) => (fx["setup"]["answer"] = 5), "answer must be a string"],
      ["citations-basic", (fx) => (fx["setup"]["sources"] = ["1"]), "a citation source must be an integer"],
      ["metrics-no-hit", (fx) => (fx["setup"]["relevant"] = [1]), "relevant must be an array of strings"],
      ["metrics-no-hit", (fx) => (fx["setup"]["level"] = 3), "setup.level must be a string or null"],
      ["metrics-no-hit", (fx) => (fx["setup"]["hits"][0]["chunkId"] = 0), "metrics hit 1 chunkId must be a string"],
      ["eval-three-modes", (fx) => (fx["setup"]["questions"][0]["query"] = 1), "question 1 query must be a string"],
      ["eval-three-modes", (fx) => (fx["setup"]["questions"][0]["relevant"] = "es-taller#1"), "question 1 relevant must be an array of strings"],
      ["eval-three-modes", (fx) => (fx["setup"]["questions"][2]["level"] = false), "question 3.level must be a string or null"],
      ["answer-basic", (fx) => (fx["setup"]["provider"]["script"][0] = { response: 1 }), "script entry 1 of provider mock has a non-string response"],
      ["answer-basic", (fx) => (fx["setup"]["provider"]["script"][0] = { error: { kind: 2 } }), "script entry 1 of provider mock has an unknown error kind"],
    ];
    for (const [name, mutate, reason] of cases) {
      const fx = byName(name);
      mutate(fx);
      const error = await runFixture(fx as Fixture).then(() => null, (e: unknown) => e);
      expect((error as Error | null)?.message, name).toBe(`invalid fixture: ${reason}`);
    }
  });

  it("passes JSON null in an option slot to the library, which reports invalid_options", async () => {
    const cases: Array<[string, (fx: Json) => void]> = [
      ["bm25-basic-ranking", (fx) => (fx["setup"]["topK"] = null)],
      ["bm25-basic-ranking", (fx) => (fx["setup"]["mode"] = null)],
      ["hybrid-candidates-cut", (fx) => (fx["setup"]["candidates"] = null)],
      ["metrics-no-hit", (fx) => (fx["setup"]["level"] = null)],
      ["embed-dim-small", (fx) => (fx["setup"]["dim"] = null)],
      ["dense-basic-ranking", (fx) => (fx["setup"]["embedder"]["dim"] = null)],
      ["chunk-fixed-basic", (fx) => (fx["setup"]["chunking"]["overlap"] = null)],
      ["chunk-paragraph-pack", (fx) => (fx["setup"]["chunking"]["maxSize"] = null)],
      ["context-basic", (fx) => (fx["setup"]["maxTokens"] = null)],
      ["eval-three-modes", (fx) => (fx["setup"]["questions"][2]["level"] = null)],
    ];
    for (const [name, mutate] of cases) {
      const fx = byName(name);
      mutate(fx);
      fx["expect"] = { error: { kind: "invalid_options" } };
      const out = await runFixture(fx as Fixture);
      expect(out.error, name).toStrictEqual({ kind: "invalid_options" });
    }
    // Outside hybrid, candidates is ignored entirely, null included.
    const ignored = byName("bm25-ignores-candidates");
    ignored["setup"]["candidates"] = null;
    checkRun(ignored as Fixture, await runFixture(ignored as Fixture));
  });

  it("rejects unknown keys at every level", async () => {
    const top = byName("tokens-digits");
    top["extra"] = 1;
    await rejects(top);
    const setup = byName("tokens-digits");
    setup["setup"]["dim"] = 3;
    await rejects(setup);
    const searchSetup = byName("bm25-basic-ranking");
    searchSetup["setup"]["maxTokens"] = 3;
    await rejects(searchSetup);
    const doc = byName("chunk-fixed-basic");
    doc["setup"]["documents"][0]["lang"] = "es";
    await rejects(doc);
    const fixed = byName("chunk-fixed-basic");
    fixed["setup"]["chunking"]["maxSize"] = 3;
    await rejects(fixed);
    const paragraph = byName("chunk-paragraph-pack");
    paragraph["setup"]["chunking"]["overlap"] = 0;
    await rejects(paragraph);
    const hash = byName("dense-basic-ranking");
    hash["setup"]["embedder"]["responses"] = [];
    await rejects(hash);
    const script = byName("dense-custom-embedder-dot-product");
    script["setup"]["embedder"]["dim"] = 2;
    await rejects(script);
    const provider = byName("answer-basic");
    provider["setup"]["provider"]["id"] = "p";
    await rejects(provider);
    const question = byName("eval-three-modes");
    question["setup"]["questions"][0]["topK"] = 1;
    await rejects(question);
    const metricsHit = byName("metrics-no-hit");
    metricsHit["setup"]["hits"][0]["rank"] = 1;
    await rejects(metricsHit);
    const expectKey = byName("tokens-digits");
    expectKey["expect"]["calls"] = 0;
    await rejects(expectKey);
    const errorExpect = byName("invalid-topk-zero");
    errorExpect["expect"]["calls"] = 0;
    await rejects(errorExpect);
    const request = byName("answer-basic");
    request["expect"]["request"]["assistant"] = "x";
    await rejects(request);
  });

  it("rejects missing required keys instead of reporting invalid_options", async () => {
    const cases: Array<[string, (fx: Json) => void]> = [
      ["tokens-digits", (fx) => delete fx["setup"]["text"]],
      ["chunk-fixed-basic", (fx) => delete fx["setup"]["documents"][0]["id"]],
      ["chunk-fixed-basic", (fx) => delete fx["setup"]["documents"][0]["text"]],
      ["chunk-fixed-basic", (fx) => delete fx["setup"]["chunking"]["overlap"]],
      ["chunk-fixed-basic", (fx) => delete fx["setup"]["chunking"]["size"]],
      ["chunk-paragraph-pack", (fx) => delete fx["setup"]["chunking"]["maxSize"]],
      ["chunk-paragraph-pack", (fx) => delete fx["setup"]["chunking"]],
      ["bm25-basic-ranking", (fx) => delete fx["setup"]["query"]],
      ["bm25-basic-ranking", (fx) => delete fx["setup"]["mode"]],
      ["context-basic", (fx) => delete fx["setup"]["maxTokens"]],
      ["answer-basic", (fx) => delete fx["setup"]["provider"]],
      ["answer-basic", (fx) => delete fx["setup"]["provider"]["script"]],
      ["answer-basic", (fx) => delete fx["expect"]["calls"]],
      ["citations-basic", (fx) => delete fx["setup"]["answer"]],
      ["metrics-no-hit", (fx) => delete fx["setup"]["relevant"]],
      ["metrics-no-hit", (fx) => delete fx["setup"]["hits"][0]["docId"]],
      ["eval-three-modes", (fx) => delete fx["setup"]["embedder"]],
      ["eval-three-modes", (fx) => delete fx["setup"]["questions"][0]["relevant"]],
      ["embed-dim-small", (fx) => delete fx["setup"]["text"]],
    ];
    for (const [name, mutate] of cases) {
      const fx = byName(name);
      mutate(fx);
      await rejects(fx);
    }
  });

  it("rejects a script entry with neither response nor error", async () => {
    const fx = byName("answer-basic");
    fx["setup"]["provider"]["script"] = [{ response: "ok" }, {}];
    await rejects(fx, /^invalid fixture: script entry 2 of provider \S+ has neither response nor error$/);
  });

  it("rejects unknown keys and unknown error kinds in script entries", async () => {
    const withScript = (script: unknown[]) => {
      const fx = byName("answer-basic");
      fx["setup"]["provider"]["script"] = script;
      return fx;
    };
    await rejects(withScript([{ text: "x" }]), "invalid fixture: script entry 1 of provider mock has neither response nor error");
    await rejects(withScript([{ response: "ok", delay: 1 }]), 'invalid fixture: unknown key "delay" in script entry 1 of provider mock');
    await rejects(withScript([{ response: "ok" }, { error: { kind: "timeout", code: 1 } }]), 'invalid fixture: unknown key "code" in the error of script entry 2 of provider mock');
    await rejects(withScript([{ error: {} }]), 'invalid fixture: missing key "kind" in the error of script entry 1 of provider mock');
    await rejects(withScript([{ error: { kind: "overloaded" } }]), "invalid fixture: script entry 1 of provider mock has an unknown error kind");
    await rejects(withScript([{ error: { kind: "constructor" } }]), "invalid fixture: script entry 1 of provider mock has an unknown error kind");
    await rejects(withScript([{ response: 3 }]), "invalid fixture: script entry 1 of provider mock has a non-string response");
    await rejects(withScript([{ error: "timeout" }]), "invalid fixture: the error of script entry 1 of provider mock must be an object");
    await rejects(withScript(["ok"]), "invalid fixture: script entry 1 of provider mock must be an object");
    // retryAfterMs is accepted (and never compared).
    const ok = withScript([{ error: { kind: "rate_limit", retryAfterMs: 100 } }]);
    ok["expect"] = { error: { kind: "rate_limit" }, calls: 1, request: ok["expect"]["request"] };
    checkRun(ok as Fixture, await runFixture(ok as Fixture));
  });

  it("validates the eval topK once, before the questions, even with no questions", async () => {
    for (const topK of [null, 0, 2.5, -1]) {
      const fx = byName("eval-three-modes");
      fx["setup"]["questions"] = [];
      fx["setup"]["topK"] = topK;
      fx["expect"] = { error: { kind: "invalid_options" } };
      const out = await runFixture(fx as Fixture);
      expect(out.error, String(topK)).toStrictEqual({ kind: "invalid_options" });
      checkRun(fx as Fixture, out);
    }
    const ok = byName("eval-three-modes");
    ok["setup"]["questions"] = [];
    ok["expect"] = { questions: [] };
    checkRun(ok as Fixture, await runFixture(ok as Fixture));
  });

  it("rejects non-integer or non-numeric citation sources as malformed", async () => {
    for (const sources of [[1, 2.5], ["1"], [null], [1, true]]) {
      const fx = byName("citations-basic");
      fx["setup"]["sources"] = sources;
      await rejects(fx, /^invalid fixture: a citation source must be an integer$/);
    }
    const notArray = byName("citations-basic");
    notArray["setup"]["sources"] = { 0: 1 };
    await rejects(notArray, /^invalid fixture: setup.sources must be an array$/);
  });

  it("uses the Kotlin harness wording for keys, embedders and expectations", async () => {
    const exact = async (fx: Json, message: string) => {
      const error = await runFixture(fx as Fixture).then(() => null, (e: unknown) => e);
      expect((error as Error | null)?.message).toBe(`invalid fixture: ${message}`);
    };
    const top = byName("tokens-digits");
    top["extra"] = 1;
    await exact(top, 'unknown key "extra" in fixture');
    const missing = byName("tokens-digits");
    delete missing["setup"]["text"];
    await exact(missing, 'missing key "text" in setup');
    const noType = byName("chunk-paragraph-pack");
    delete noType["setup"]["chunking"]["type"];
    await exact(noType, 'missing key "type" in setup.chunking');
    const embedder = byName("dense-basic-ranking");
    embedder["setup"]["embedder"] = { type: "openai" };
    await exact(embedder, "unknown embedder type openai");
    const embedderNoType = byName("dense-basic-ranking");
    embedderNoType["setup"]["embedder"] = { type: 3 };
    await exact(embedderNoType, "unknown embedder type null");
    const exhausted = byName("dense-custom-embedder-dot-product");
    exhausted["setup"]["embedder"]["responses"] = exhausted["setup"]["embedder"]["responses"].slice(0, 1);
    await exact(exhausted, "script embedder called more often than it has responses");
    const neither = byName("context-basic");
    neither["expect"] = { sources: [] };
    await exact(neither, "expect has neither the keys of a context fixture nor error");
  });

  it("rejects an unknown embedder type and an unusable script embedder", async () => {
    const type = byName("dense-basic-ranking");
    type["setup"]["embedder"] = { type: "openai" };
    await rejects(type);
    const notVectors = byName("dense-custom-embedder-dot-product");
    notVectors["setup"]["embedder"]["responses"][0] = [[1, "x"]];
    await rejects(notVectors);
    const notArray = byName("dense-custom-embedder-dot-product");
    notArray["setup"]["embedder"]["responses"] = { 0: [] };
    await rejects(notArray);
    const overCalled = byName("dense-custom-embedder-dot-product");
    overCalled["setup"]["embedder"]["responses"] = overCalled["setup"]["embedder"]["responses"].slice(0, 1);
    await rejects(overCalled);
  });

  it("rejects an expect with neither the keys of its kind nor error", async () => {
    const empty = byName("tokens-digits");
    empty["expect"] = {};
    await rejects(empty);
    const partial = byName("context-basic");
    delete partial["expect"]["droppedCount"];
    await rejects(partial);
    const wrongKind = byName("tokens-digits");
    wrongKind["expect"] = { chunks: [] };
    await rejects(wrongKind);
  });

  it("returns the library's invalid_options for bad values a typed API cannot represent", async () => {
    const mode = byName("bm25-basic-ranking");
    mode["setup"]["mode"] = "sparse";
    mode["expect"] = { error: { kind: "invalid_options" } };
    expect((await runFixture(mode as Fixture)).error).toStrictEqual({ kind: "invalid_options" });
    const chunking = byName("chunk-fixed-basic");
    chunking["setup"]["chunking"] = { type: "sentence", n: 2 };
    chunking["expect"] = { error: { kind: "invalid_options" } };
    expect((await runFixture(chunking as Fixture)).error).toStrictEqual({ kind: "invalid_options" });
  });

  it("returns the index chunks and hits for the demos", async () => {
    const out = await runFixture(byName("hybrid-fusion-order") as Fixture);
    expect(out.index?.chunks.length).toBeGreaterThan(0);
    expect(out.output?.kind).toBe("search");
  });
});

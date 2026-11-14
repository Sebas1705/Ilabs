import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultsFor, groupRagFixtures, isReadOnly, labelledQuestions, loadErrors, parseRagFixtures, ragFixtures, scriptedReply } from "./ragFixtures";

const dir = resolve(__dirname, "../../../contracts/rag");

const doc = { id: "d", text: "hello" };
const chunking = { type: "paragraph", maxSize: 10 };
const search = (name: string, extra: Record<string, unknown> = {}, expectExtra: unknown = { hits: [] }) =>
  JSON.stringify({
    name,
    setup: { kind: "search", documents: [doc], chunking, query: "hello", mode: "bm25", ...extra },
    expect: expectExtra,
  });
const custom = (setup: Record<string, unknown>) => JSON.stringify({ name: "x", setup, expect: {} });

describe("parseRagFixtures", () => {
  it("keeps demo kinds sorted, silently skips the other kinds and names the broken files", () => {
    const { fixtures, errors } = parseRagFixtures({
      "../r/b.json": search("b"),
      "../r/a.json": search("a"),
      "../r/tokens.json": JSON.stringify({ name: "tokens", setup: { kind: "tokens", text: "x" }, expect: { tokens: [] } }),
      "../r/broken.json": "{",
      "../r/array.json": "[]",
      "../r/no-docs.json": search("no-docs", { documents: "x" }),
    });
    expect(fixtures.map((f) => f.name)).toEqual(["a", "b"]);
    expect(errors).toHaveLength(3);
    expect(errors.some((e) => e.includes("tokens.json"))).toBe(false);
  });

  const variants: Record<string, string> = {
    "name-number": search("x").replace('"name":"x"', '"name":5'),
    "documents-null": search("x", { documents: null }),
    "document-no-text": search("x", { documents: [{ id: "a" }] }),
    "document-id-number": search("x", { documents: [{ id: 1, text: "a" }] }),
    "chunking-missing": search("x", { chunking: undefined }),
    "chunking-array": search("x", { chunking: [] }),
    "query-number": search("x", { query: 3 }),
    "mode-number": search("x", { mode: 3 }),
    "topk-string": search("x", { topK: "2" }),
    "embedder-string": search("x", { embedder: "hash" }),
    "embedder-no-type": search("x", { embedder: {} }),
    "expect-array": search("x", {}, []),
    "context-no-max": custom({ kind: "context", documents: [doc], chunking, query: "a", mode: "bm25" }),
    "eval-questions-missing": custom({ kind: "eval", documents: [doc], chunking, embedder: { type: "hash" }, topK: 3 }),
    "eval-question-no-relevant": custom({ kind: "eval", documents: [doc], chunking, embedder: { type: "hash" }, topK: 3, questions: [{ query: "a" }] }),
    "answer-no-provider": custom({ kind: "answer", documents: [doc], chunking, query: "a", mode: "bm25", maxTokens: 100 }),
    "answer-bad-script": custom({ kind: "answer", documents: [doc], chunking, query: "a", mode: "bm25", maxTokens: 100, provider: { script: [null] } }),
  };
  it.each(Object.keys(variants))("rejects a malformed shape without throwing: %s", (key) => {
    const { fixtures, errors } = parseRagFixtures({ [`../r/${key}.json`]: variants[key]! });
    expect(fixtures).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });
});

describe("the shipped contract fixtures", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const demo = files.filter((f) => {
    const kind = (JSON.parse(readFileSync(resolve(dir, f), "utf8")) as { setup: { kind: string } }).setup.kind;
    return ["search", "context", "answer", "eval"].includes(kind);
  });
  const by = (n: string) => ragFixtures.find((f) => f.name === n)!;

  it("loads every demo-kind file without a load error", () => {
    expect(demo.length).toBeGreaterThanOrEqual(50);
    expect(loadErrors).toEqual([]);
    expect(ragFixtures).toHaveLength(demo.length);
  });

  it("groups search, context, answers and evaluation in this order; invalid-* samples stay out of the picker", () => {
    const groups = groupRagFixtures(ragFixtures);
    expect(groups.map((g) => g.label)).toEqual(["ragGroupSearch", "ragGroupContext", "ragGroupAnswers", "ragGroupEval"]);
    const prefixes = [["bm25-", "dense-", "hybrid-"], ["context-"], ["answer-"], ["eval-"]];
    groups.forEach((g, i) => expect(g.fixtures.every((f) => prefixes[i]!.some((p) => f.name.startsWith(p)))).toBe(true));
    const grouped = groups.flatMap((g) => g.fixtures.map((f) => f.name));
    expect(grouped.some((n) => n.startsWith("invalid-"))).toBe(false);
    expect(grouped).toHaveLength(demo.filter((f) => !f.startsWith("invalid-")).length);
  });

  it("derives the defaults from the fixture", () => {
    expect(defaultsFor(by("hybrid-fusion-order"))).toEqual({ question: "carné de lector", mode: "hybrid", topK: 4 });
    expect(defaultsFor(by("bm25-basic-ranking")).topK).toBe(5);
    expect(defaultsFor(by("eval-three-modes"))).toEqual({ question: "¿Cuánto cuesta cambiar la cadena?", mode: "hybrid", topK: 3 });
    expect(defaultsFor(by("answer-basic")).mode).toBe("bm25");
  });

  it("marks script-embedder fixtures and error fixtures as read-only, and only those", () => {
    const readOnly = ragFixtures.filter(isReadOnly).map((f) => f.name);
    for (const n of ["dense-custom-embedder-dot-product", "context-first-source-too-big", "answer-provider-error", "dense-no-embedder-error"]) {
      expect(readOnly).toContain(n);
    }
    for (const n of ["hybrid-fusion-order", "eval-three-modes", "answer-unknown-citation"]) expect(readOnly).not.toContain(n);
  });

  it("reads the labelled questions of an eval fixture and the scripted reply of an answer fixture", () => {
    expect(labelledQuestions(by("eval-three-modes"))).toHaveLength(5);
    expect(labelledQuestions(by("eval-three-modes"))[2]).toEqual({ query: "bicicleta", relevant: ["es-taller"], level: "doc" });
    expect(labelledQuestions(by("hybrid-fusion-order"))).toEqual([]);
    expect(scriptedReply(by("answer-unknown-citation"))).toBe("Ask at the front desk [1]; see also [3] and [2].");
    expect(scriptedReply(by("answer-provider-error"))).toBeNull();
    expect(scriptedReply(by("hybrid-fusion-order"))).toBeNull();
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTRACT_DIR,
  judgeHandlerRun,
  loadRaw,
  runHandlerFixture,
  runLimiterFixture,
  validateFixture,
  type Fixture,
  type HandlerFixture,
  type LimiterFixture,
} from "./contract-harness.js";

const files = loadRaw();
const fixtures: Fixture[] = files.map(({ raw }) => validateFixture(raw));
const handlers = fixtures.filter((f): f is HandlerFixture => f.kind === "handler");
const limiters = fixtures.filter((f): f is LimiterFixture => f.kind === "limiter");

describe("gateway contract: the fixture folder", () => {
  it("has every fixture", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(549);
    expect(handlers.length).toBeGreaterThanOrEqual(381);
    expect(limiters.length).toBeGreaterThanOrEqual(19);
  });

  it("lists exactly the fixtures of the folder in the README table, with the counts it states", () => {
    const readme = readFileSync(join(CONTRACT_DIR, "README.md"), "utf8");
    const section = readme.slice(readme.indexOf("\n## Fixtures\n"));
    const counts = /(\d+) fixtures: (\d+) `handler`, (\d+) `client`, (\d+) `limiter`/.exec(section);
    expect(counts, "the README states the fixture counts").not.toBeNull();
    const listed = [...section.matchAll(/^\| `([^`]+)` \| `(handler|client|limiter)` \|/gm)].map((m) => m[1]!);
    expect(new Set(listed).size, "a fixture is listed twice").toBe(listed.length);
    expect([...listed].sort()).toEqual(files.map(({ file }) => file.replace(/\.json$/, "")).sort());
    const byKind = (kind: string) => files.filter(({ file }) => file.startsWith(`${kind}-`)).length;
    expect(counts!.slice(1).map(Number)).toEqual([files.length, byKind("handler"), byKind("client"), byKind("limiter")]);
  });

  it("names every fixture after its file and starts the name with its kind", () => {
    for (const [index, { file }] of files.entries()) {
      const fx = fixtures[index]!;
      expect(fx.name, file).toBe(file.replace(/\.json$/, ""));
      expect(fx.name.startsWith(`${fx.kind}-`), file).toBe(true);
    }
  });

  it("keeps every fixture as JSON.stringify(fixture, null, 2) plus a newline", () => {
    for (const { file, raw } of files) {
      expect(JSON.stringify(raw, null, 2) + "\n", file).toBe(readFileSync(join(CONTRACT_DIR, file), "utf8"));
    }
  });
});

describe("gateway contract: handler fixtures", () => {
  for (const fx of handlers) {
    it(fx.name, async () => {
      const run = await runHandlerFixture(fx);
      expect(judgeHandlerRun(fx, run)).toEqual([]);
    });
  }
});

describe("gateway contract: limiter fixtures", () => {
  for (const fx of limiters) {
    it(fx.name, () => {
      expect(runLimiterFixture(fx)).toEqual([]);
    });
  }
});

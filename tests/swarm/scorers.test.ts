import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ScorerConfigSchema,
  createScorer,
  runScorers,
  type ScorerContext
} from '../../src/swarm/scorers.js';

let scratchDir: string;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "guru-scorers-"));
});

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

function context(overrides: Partial<ScorerContext> = {}): ScorerContext {
  return {
    cwd: scratchDir,
    ...overrides
  };
}

describe("scorer config schema — strict and bounded", () => {
  it("parses the three built-in kinds; rejects unknown kinds and junk keys", () => {
    expect(ScorerConfigSchema.parse({ kind: "exit_code", expected: 0 }).kind).toBe("exit_code");
    expect(ScorerConfigSchema.parse({ kind: "file_exists", path: "out.txt" }).kind).toBe("file_exists");
    expect(ScorerConfigSchema.parse({ kind: "regex", pattern: "done" }).kind).toBe("regex");
    expect(() => ScorerConfigSchema.parse({ kind: "webhook", url: "https://x" })).toThrow();
    expect(() => ScorerConfigSchema.parse({ kind: "regex", pattern: "x", extra: 1 })).toThrow();
  });

  it("rejects an invalid regex at config time, not at score time", () => {
    expect(() => createScorer({ kind: "regex", pattern: "([unclosed" })).toThrow(/invalid regex/i);
  });
});

describe("exit_code scorer", () => {
  it("passes when the observed exit code matches; fails otherwise", () => {
    const scorer = createScorer({ kind: "exit_code", expected: 0 });
    expect(scorer.score(context({ exitCode: 0 })).verdict).toBe("pass");
    expect(scorer.score(context({ exitCode: 1 })).verdict).toBe("fail");
  });

  it("fails honestly when no exit code was observed (never claims success without evidence)", () => {
    const scorer = createScorer({ kind: "exit_code", expected: 0 });
    const result = scorer.score(context());
    expect(result.verdict).toBe("fail");
    expect(result.detail).toMatch(/no exit code/i);
  });

  it("supports a set of acceptable exit codes", () => {
    const scorer = createScorer({ kind: "exit_code", expected: [0, 2] });
    expect(scorer.score(context({ exitCode: 2 })).verdict).toBe("pass");
    expect(scorer.score(context({ exitCode: 3 })).verdict).toBe("fail");
  });
});

describe("file_exists scorer", () => {
  it("passes when the path exists relative to the context cwd", () => {
    writeFileSync(join(scratchDir, "artifact.txt"), "payload");
    const scorer = createScorer({ kind: "file_exists", path: "artifact.txt" });
    expect(scorer.score(context()).verdict).toBe("pass");
  });

  it("fails when the path is missing, and says which path", () => {
    const scorer = createScorer({ kind: "file_exists", path: "missing.txt" });
    const result = scorer.score(context());
    expect(result.verdict).toBe("fail");
    expect(result.detail).toContain("missing.txt");
  });

  it("never resolves outside the context cwd (structural scope bound)", () => {
    const scorer = createScorer({ kind: "file_exists", path: "../../etc/passwd" });
    const result = scorer.score(context());
    expect(result.verdict).toBe("fail");
    expect(result.detail).toMatch(/outside/i);
  });
});

describe("regex scorer", () => {
  it("passes on match against observed output; fails on no match", () => {
    const scorer = createScorer({ kind: "regex", pattern: "build succeeded" });
    expect(scorer.score(context({ outputText: "... build succeeded ..." })).verdict).toBe("pass");
    expect(scorer.score(context({ outputText: "build failed" })).verdict).toBe("fail");
  });

  it("supports negated patterns (must-not-match)", () => {
    const scorer = createScorer({ kind: "regex", pattern: "SECRET=", negate: true });
    expect(scorer.score(context({ outputText: "clean log" })).verdict).toBe("pass");
    expect(scorer.score(context({ outputText: "SECRET=abc123" })).verdict).toBe("fail");
  });

  it("fails honestly when there is no output to score", () => {
    const scorer = createScorer({ kind: "regex", pattern: "anything" });
    const result = scorer.score(context());
    expect(result.verdict).toBe("fail");
    expect(result.detail).toMatch(/no output/i);
  });

  it("bounds its detail — a matched haystack is never echoed wholesale", () => {
    const scorer = createScorer({ kind: "regex", pattern: "needle" });
    const haystack = `prefix ${"x".repeat(10_000)} needle ${"y".repeat(10_000)}`;
    const result = scorer.score(context({ outputText: haystack }));
    expect(result.verdict).toBe("pass");
    expect(result.detail.length).toBeLessThanOrEqual(240);
  });
});

describe("runScorers — partial vs pass/fail aggregation", () => {
  it("all pass → pass; any fail → fail; mixed pass/skip → partial", () => {
    const passing = createScorer({ kind: "regex", pattern: "ok" });
    const failing = createScorer({ kind: "regex", pattern: "missing-marker" });
    const ctx = context({ outputText: "ok" });

    expect(runScorers([passing], ctx).verdict).toBe("pass");
    expect(runScorers([passing, failing], ctx).verdict).toBe("fail");
  });

  it("no scorers → partial with an honest 'unscored' summary (scorers are optional)", () => {
    const aggregate = runScorers([], context());
    expect(aggregate.verdict).toBe("partial");
    expect(aggregate.summary).toMatch(/no scorers/i);
  });

  it("a scorer that cannot evaluate (missing evidence) degrades all-pass to partial, not fail", () => {
    // exit_code with no observed code fails on its own — but a scorer explicitly
    // skipped (optional evidence absent) must not convert a clean pass into a fail.
    const passing = createScorer({ kind: "regex", pattern: "ok" });
    const skipped = createScorer({ kind: "exit_code", expected: 0, optional: true });
    const aggregate = runScorers([passing, skipped], context({ outputText: "ok" }));
    expect(aggregate.verdict).toBe("partial");
    expect(aggregate.results).toHaveLength(2);
  });

  it("an optional scorer that finds its evidence still counts toward pass", () => {
    const passing = createScorer({ kind: "regex", pattern: "ok" });
    const optionalExit = createScorer({ kind: "exit_code", expected: 0, optional: true });
    const aggregate = runScorers([passing, optionalExit], context({ outputText: "ok", exitCode: 0 }));
    expect(aggregate.verdict).toBe("pass");
  });

  it("aggregation carries every per-scorer result — inspectable, not a bare verdict", () => {
    const a = createScorer({ kind: "regex", pattern: "ok", id: "log-check" });
    const b = createScorer({ kind: "exit_code", expected: 0 });
    const aggregate = runScorers([a, b], context({ outputText: "ok", exitCode: 1 }));
    expect(aggregate.verdict).toBe("fail");
    expect(aggregate.results.map((r) => r.scorerId)).toEqual(["log-check", "exit_code"]);
    expect(aggregate.summary.length).toBeGreaterThan(0);
  });
});

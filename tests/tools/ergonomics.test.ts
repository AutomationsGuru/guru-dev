import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  DEFAULT_MATCH_LINE_MAX_CHARS,
  DEFAULT_SUMMARY_LIST_LIMIT,
  TOOL_ERROR_CODES,
  aggregateCounts,
  buildError,
  buildListSummary,
  buildMatchSummary,
  summarizeLines,
  truncateLine,
  truncateUtf8
} from '../../src/tools/ergonomics.js';
import { createPiBashTool } from '../../src/tools/builtins/bashTool.js';
import { createGlobTool, createGrepTool, createLsTool } from '../../src/tools/builtins/searchTools.js';

// ---------------------------------------------------------------------------
// Fixture tree
// ---------------------------------------------------------------------------

const root = join(tmpdir(), `guru-ergonomics-${process.pid}`);
mkdirSync(join(root, "src"), { recursive: true });
writeFileSync(join(root, "src", "one.ts"), "target alpha\ntarget beta\n");
writeFileSync(join(root, "src", "two.ts"), "target gamma\n");
writeFileSync(join(root, "src", "miss.ts"), "nothing\n");
writeFileSync(join(root, "src", "long.ts"), `prefix ${"x".repeat(DEFAULT_MATCH_LINE_MAX_CHARS + 500)} target suffix\n`);
for (let index = 0; index < 5; index += 1) {
  writeFileSync(join(root, "src", `entry-${index}.txt`), "target\n");
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

describe("truncateUtf8", () => {
  it("keeps short values intact", () => {
    expect(truncateUtf8("hello", 64)).toEqual({ value: "hello", truncated: false, originalBytes: 5 });
  });

  it("truncates on a UTF-8 boundary and reports the original size", () => {
    const value = `ab${"界".repeat(100)}`;
    const result = truncateUtf8(value, 8);
    expect(result.truncated).toBe(true);
    expect(result.originalBytes).toBe(Buffer.from(value, "utf8").length);
    expect(Buffer.from(result.value, "utf8").length).toBeLessThanOrEqual(8);
    // no replacement characters from a mid-sequence cut
    expect(result.value).not.toContain("�");
  });
});

describe("truncateLine", () => {
  it("caps long lines and reports the elided character count", () => {
    const line = `head${"y".repeat(600)}tail`;
    const result = truncateLine(line, 100);
    expect(result.truncated).toBe(true);
    expect(result.originalChars).toBe(line.length);
    expect(result.elidedChars).toBe(line.length - 100);
    expect(result.value).toContain("head");
    expect(result.value.length).toBeLessThan(line.length);
  });

  it("passes short lines through unchanged", () => {
    expect(truncateLine("short", 100)).toEqual({ value: "short", truncated: false, originalChars: 5, elidedChars: 0 });
  });
});

describe("aggregateCounts", () => {
  it("counts per key, tracks unique keys, and reports the top keys by count", () => {
    const aggregate = aggregateCounts(["a", "b", "a", "a", "b", "c"]);
    expect(aggregate.total).toBe(6);
    expect(aggregate.uniqueKeys).toBe(3);
    expect(aggregate.top[0]).toEqual({ key: "a", count: 3 });
    expect(aggregate.top[1]).toEqual({ key: "b", count: 2 });
  });

  it("bounds the top list to the requested limit", () => {
    const keys = Array.from({ length: 30 }, (_, index) => `k${index}`);
    const aggregate = aggregateCounts(keys, 5);
    expect(aggregate.top).toHaveLength(5);
    expect(aggregate.total).toBe(30);
    expect(aggregate.uniqueKeys).toBe(30);
  });

  it("handles an empty stream", () => {
    expect(aggregateCounts([])).toEqual({ total: 0, uniqueKeys: 0, top: [] });
  });
});

describe("buildError", () => {
  it("produces a structured error with a stable machine code", () => {
    const error = buildError(TOOL_ERROR_CODES.PATH_ESCAPE, "Search path escapes the repository root.", "Grep blocked by containment policy.");
    expect(error.code).toBe("PATH_ESCAPE");
    expect(error.blocker).toContain("escapes");
    expect(error.summary).toContain("blocked");
  });
});

describe("buildMatchSummary", () => {
  it("aggregates per-file counts and bounds the file list", () => {
    const summary = buildMatchSummary(
      [
        { file: "a.ts", line: 1, content: "x" },
        { file: "a.ts", line: 2, content: "x" },
        { file: "b.ts", line: 1, content: "x" }
      ],
      false,
      10
    );
    expect(summary).toContain("3 match(es) across 2 file(s)");
    expect(summary).toContain("a.ts (2)");
    expect(summary).toContain("b.ts (1)");
  });

  it("marks truncation and collapses large file lists into an aggregate", () => {
    const matches = Array.from({ length: 40 }, (_, index) => ({ file: `f${index}.ts`, line: 1, content: "x" }));
    const summary = buildMatchSummary(matches, true, DEFAULT_SUMMARY_LIST_LIMIT);
    expect(summary).toContain("truncated");
    expect(summary).toContain("+20 more");
    expect(summary.length).toBeLessThan(2_000);
  });
});

describe("buildListSummary", () => {
  it("bounds the listed items and reports the omitted count", () => {
    const items = Array.from({ length: 40 }, (_, index) => `item-${index}`);
    const summary = buildListSummary({ noun: "path", shownCount: 40, totalCount: 40, truncated: true, items, limit: 10 });
    expect(summary).toContain("40 path(s)");
    expect(summary).toContain("truncated");
    expect(summary).toContain("+30 more");
  });
});

describe("summarizeLines", () => {
  it("returns a full line profile with repetition and width aggregates", () => {
    const profile = summarizeLines(["ok", "ok", "longer line"].join("\n"));
    expect(profile.lineCount).toBe(3);
    expect(profile.uniqueLines).toBe(2);
    expect(profile.repeatedLines).toBe(1);
    expect(profile.maxLineChars).toBe("longer line".length);
    expect(profile.topLines[0]).toEqual({ key: "ok", count: 2 });
  });
});

// ---------------------------------------------------------------------------
// grep / glob / ls — aggregated summaries, capped lines
// ---------------------------------------------------------------------------

describe("grep ergonomics", () => {
  const grep = createGrepTool();

  it("summary aggregates match counts per file instead of a bare number", async () => {
    const result = await grep.execute({ repoRoot: root, pattern: "target", path: ".", caseInsensitive: false, maxMatches: 100 }, {});
    expect(result.summary).toContain("match(es) across");
    expect(result.summary).toContain("one.ts (2)");
  });

  it("structured error codes accompany containment and regex blockers", async () => {
    const escape = await grep.execute({ repoRoot: root, pattern: "x", path: "../..", caseInsensitive: false, maxMatches: 10 }, {});
    expect(escape.errorCode).toBe(TOOL_ERROR_CODES.PATH_ESCAPE);
    const bad = await grep.execute({ repoRoot: root, pattern: "(", path: ".", caseInsensitive: false, maxMatches: 10 }, {});
    expect(bad.errorCode).toBe(TOOL_ERROR_CODES.INVALID_PATTERN);
    const clean = await grep.execute({ repoRoot: root, pattern: "target", path: ".", caseInsensitive: false, maxMatches: 10 }, {});
    expect(clean.errorCode).toBeNull();
  });

  it("oversized matching lines are capped, not returned raw", async () => {
    const result = await grep.execute({ repoRoot: root, pattern: "target", path: ".", caseInsensitive: false, maxMatches: 100 }, {});
    const long = result.matches.find((match) => match.file === "src/long.ts");
    expect(long).toBeDefined();
    expect(long?.content.length).toBeLessThan(DEFAULT_MATCH_LINE_MAX_CHARS + 500);
    expect(long?.content).toContain("elided");
    expect(long?.truncated).toBe(true);
    expect(long?.elidedChars ?? 0).toBeGreaterThan(0);
  });
});

describe("glob ergonomics", () => {
  const glob = createGlobTool();

  it("summary reports shown-of-total aggregates when the list is truncated", async () => {
    const result = await glob.execute({ repoRoot: root, pattern: "src/*.txt", path: ".", maxResults: 2 }, {});
    expect(result.paths).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.summary).toContain("2 of 5 path(s)");
  });

  it("structured error code accompanies a containment block", async () => {
    const result = await glob.execute({ repoRoot: root, pattern: "**/*", path: "..", maxResults: 10 }, {});
    expect(result.errorCode).toBe(TOOL_ERROR_CODES.PATH_ESCAPE);
  });
});

describe("ls ergonomics", () => {
  const ls = createLsTool();

  it("summary aggregates entry counts by type", async () => {
    const result = await ls.execute({ repoRoot: root, path: "src", includeHidden: false }, {});
    expect(result.summary).toContain("entrie(s)");
    expect(result.summary).toContain("file");
  });

  it("structured error codes accompany containment and unreadable-directory blocks", async () => {
    const escape = await ls.execute({ repoRoot: root, path: "..", includeHidden: false }, {});
    expect(escape.errorCode).toBe(TOOL_ERROR_CODES.PATH_ESCAPE);
    const missing = await ls.execute({ repoRoot: root, path: "no-such-dir", includeHidden: false }, {});
    expect(missing.errorCode).toBe(TOOL_ERROR_CODES.IO_ERROR);
  });
});

// ---------------------------------------------------------------------------
// bash — oversized output is aggregated, never raw-flooded
// ---------------------------------------------------------------------------

describe("bash ergonomics", () => {
  const runTool = (stdout: string, stderr = "") =>
    createPiBashTool({
      shellAllowlist: ["node"],
      executor: async () => ({ exitCode: 0, stdout, stderr, durationMs: 3 })
    }).execute(
      { repoRoot: process.cwd(), command: "node", args: ["script.js"], timeoutMs: 5_000, maxOutputBytes: 4_096, dryRun: false },
      {}
    );

  it("oversized stdout returns an aggregate profile instead of raw flooded bytes", async () => {
    const noisy = Array.from({ length: 400 }, () => "Repeated failure line").join("\n");
    const output = await runTool(noisy);
    expect(output.truncated).toBe(true);
    expect(output.stdoutBytes).toBe(Buffer.from(noisy, "utf8").length);
    expect(output.stdoutLines).toBe(400);
    expect(output.stdout).not.toBe(noisy);
    expect(output.stdout).toContain("[guru output summary]");
    expect(output.stdout).toContain("400 line(s)");
    expect(output.stdout).toContain("repeated");
    // kept bytes stay bounded — an aggregate, not the flood
    expect(Buffer.from(output.stdout ?? "", "utf8").length).toBeLessThanOrEqual(4_096);
  });

  it("stderr gets the same aggregate treatment with its own profile", async () => {
    const noisyErr = Array.from({ length: 900 }, (_, index) => (index % 2 === 0 ? "ERR boom" : `detail ${index}`)).join("\n");
    const output = await runTool("", noisyErr);
    expect(output.truncated).toBe(true);
    expect(output.stderrBytes).toBe(Buffer.from(noisyErr, "utf8").length);
    expect(output.stderr).toContain("[guru output summary]");
  });

  it("small outputs pass through with accurate profile fields and no summary banner", async () => {
    const output = await runTool("all good\n");
    expect(output.stdout).toBe("all good\n");
    expect(output.truncated).toBe(false);
    expect(output.stdoutBytes).toBe(9);
    expect(output.stdoutLines).toBe(1);
    expect(output.stdout).not.toContain("[guru output summary]");
  });

  it("summaries carry the output profile so the model sees the aggregate, not the dump", async () => {
    const noisy = "x".repeat(20_000);
    const output = await runTool(noisy);
    expect(output.summary).toContain("byte(s)");
    expect(output.summary).toContain("truncated");
  });

  it("hard-edge checks still bind: blocked commands carry a structured error code and never execute", async () => {
    const tool = createPiBashTool({
      shellAllowlist: ["npm"],
      executor: async () => ({ exitCode: 0, stdout: "must-not-run", stderr: "", durationMs: 1 })
    });
    const blocked = await tool.execute(
      { repoRoot: process.cwd(), command: "curl http://example.com", args: [], timeoutMs: 5_000, maxOutputBytes: 4_096, dryRun: false },
      {}
    );
    expect(blocked.executed).toBe(false);
    expect(blocked.errorCode).toBe(TOOL_ERROR_CODES.POLICY_BLOCKED);
    const clean = await createPiBashTool({
      shellAllowlist: ["node"],
      executor: async () => ({ exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 })
    }).execute({ repoRoot: process.cwd(), command: "node", args: [], timeoutMs: 5_000, maxOutputBytes: 4_096, dryRun: false }, {});
    expect(clean.errorCode).toBeNull();
  });
});

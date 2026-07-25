import { describe, expect, it } from "vitest";

import {
  formatForModel,
  parseEslintOutput,
  parseTscDiagnostics,
  runDiagnostics,
  type DiagnosticsConfig,
  type DiagnosticsIssue
} from "../../src/tools/diagnosticsFeedback.js";
import type { CommandExecutionResult, CommandExecutor } from "../../src/review/gates.js";

// ---------------------------------------------------------------------------
// Sample outputs
// ---------------------------------------------------------------------------

const SAMPLE_TSC_OUTPUT = [
  "src/a.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.",
  "src/a.ts(15,8): error TS2345: Argument of type 'null' is not assignable to parameter of type 'string'.",
  "src/b.ts(3,12): warning TS6133: 'x' is declared but its value is never read.",
  "src/b.ts(7,1): error TS2304: Cannot find name 'foo'.",
  "src/utils/helpers.ts(22,4): error TS2554: Expected 2 arguments, but got 1."
].join("\n");

const SAMPLE_ESLINT_OUTPUT = [
  "/home/user/project/src/a.ts",
  "  10:5  error    Type string trivially inferred from a string literal  @typescript-eslint/no-inferrable-types",
  "  15:8  warning  Unexpected console statement                          no-console",
  "",
  "/home/user/project/src/b.ts",
  "   3:12  error  'x' is assigned a value but never used                 @typescript-eslint/no-unused-vars",
  "",
  "✖ 3 problems (2 errors, 1 warning)"
].join("\n");

const SAMPLE_ESLINT_UNIX_OUTPUT = [
  "/home/user/project/src/a.ts:10:5: Type string trivially inferred from a string literal. [Error/@typescript-eslint/no-inferrable-types]",
  "/home/user/project/src/a.ts:15:8: Unexpected console statement. [Warning/no-console]",
  "/home/user/project/src/b.ts:3:12: 'x' is assigned a value but never used. [Error/@typescript-eslint/no-unused-vars]"
].join("\n");

// ---------------------------------------------------------------------------
// Test executor factories
// ---------------------------------------------------------------------------

function executorWithResult(result: CommandExecutionResult): CommandExecutor {
  return async () => result;
}

function tscExecutor(stdout: string): CommandExecutor {
  return executorWithResult({
    exitCode: stdout.trim().length > 0 ? 2 : 0,
    stdout,
    stderr: "",
    durationMs: 10
  });
}

function eslintExecutor(stdout: string): CommandExecutor {
  return executorWithResult({
    exitCode: stdout.trim().length > 0 ? 1 : 0,
    stdout,
    stderr: "",
    durationMs: 10
  });
}

function makeIssues(overrides: Partial<DiagnosticsIssue>[]): DiagnosticsIssue[] {
  return overrides.map((o, i) => ({
    file: o.file ?? `src/file${i}.ts`,
    line: o.line ?? 1,
    column: o.column ?? 1,
    severity: o.severity ?? "error",
    code: o.code ?? "TS9999",
    message: o.message ?? `Issue ${i}`,
    source: o.source ?? "tsc"
  }));
}

// ---------------------------------------------------------------------------
// parseTscDiagnostics
// ---------------------------------------------------------------------------

describe("parseTscDiagnostics", () => {
  it("parses TSC errors and warnings", () => {
    const issues = parseTscDiagnostics(SAMPLE_TSC_OUTPUT);
    expect(issues).toHaveLength(5);
    expect(issues[0]).toEqual({
      file: "src/a.ts",
      line: 10,
      column: 5,
      severity: "error",
      code: "TS2322",
      message: "Type 'string' is not assignable to type 'number'.",
      source: "tsc"
    });
    // Warning
    expect(issues[2]?.severity).toBe("warning");
    expect(issues[2]?.code).toBe("TS6133");
  });

  it("returns empty array for empty output", () => {
    expect(parseTscDiagnostics("")).toEqual([]);
  });

  it("returns empty array for non-diagnostic output", () => {
    expect(parseTscDiagnostics("Build succeeded.\nNo errors found.")).toEqual([]);
  });

  it("handles Windows-style paths in TSC output", () => {
    const output = "src\\a.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.";
    const issues = parseTscDiagnostics(output);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.file).toBe("src/a.ts");
    expect(issues[0]?.code).toBe("TS2322");
  });
});

// ---------------------------------------------------------------------------
// parseEslintOutput
// ---------------------------------------------------------------------------

describe("parseEslintOutput", () => {
  it("parses ESLint stylish-formatter output", () => {
    const issues = parseEslintOutput(SAMPLE_ESLINT_OUTPUT);
    expect(issues.length).toBeGreaterThanOrEqual(3);
    // First issue
    expect(issues[0]?.file).toContain("src/a.ts");
    expect(issues[0]?.line).toBe(10);
    expect(issues[0]?.column).toBe(5);
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.code).toBe("@typescript-eslint/no-inferrable-types");
    expect(issues[0]?.source).toBe("eslint");
  });

  it("parses ESLint unix-formatter output", () => {
    const issues = parseEslintOutput(SAMPLE_ESLINT_UNIX_OUTPUT);
    expect(issues).toHaveLength(3);
    expect(issues[0]?.file).toContain("src/a.ts");
    expect(issues[0]?.line).toBe(10);
    expect(issues[0]?.code).toBe("@typescript-eslint/no-inferrable-types");
  });

  it("returns empty array for empty output", () => {
    expect(parseEslintOutput("")).toEqual([]);
  });

  it("returns empty array for output with no parseable diagnostics", () => {
    expect(parseEslintOutput("Everything is fine!")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runDiagnostics — TSC
// ---------------------------------------------------------------------------

describe("runDiagnostics — TSC", () => {
  it("runs tsc and returns structured diagnostics", async () => {
    const config = {
      repoRoot: "/fake/repo",
      runners: ["tsc"] as const
    } as unknown as DiagnosticsConfig;
    const executor = tscExecutor(SAMPLE_TSC_OUTPUT);
    const result = await runDiagnostics(config, executor);
    expect(result.issues).toHaveLength(5);
    expect(result.issues[0]?.source).toBe("tsc");
    expect(result.summary).toContain("5 diagnostic(s)");
  });

  it("filters diagnostics by paths", async () => {
    const config = {
      repoRoot: "/fake/repo",
      runners: ["tsc"] as const,
      paths: ["src/a.ts"]
    } as unknown as DiagnosticsConfig;
    const executor = tscExecutor(SAMPLE_TSC_OUTPUT);
    const result = await runDiagnostics(config, executor);
    expect(result.issues).toHaveLength(2);
    for (const issue of result.issues) {
      expect(issue.file).toContain("src/a.ts");
    }
  });

  it("returns empty issues when tsc has no errors", async () => {
    const config = { repoRoot: "/fake/repo", runners: ["tsc"] as const } as unknown as DiagnosticsConfig;
    const executor = tscExecutor("");
    const result = await runDiagnostics(config, executor);
    expect(result.issues).toHaveLength(0);
    expect(result.summary).toBe("No TypeScript diagnostics.");
  });

  it("returns empty issues when no runners configured", async () => {
    const config = { repoRoot: "/fake/repo", runners: [] as const } as unknown as DiagnosticsConfig;
    const result = await runDiagnostics(config, tscExecutor(SAMPLE_TSC_OUTPUT));
    expect(result.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runDiagnostics — ESLint
// ---------------------------------------------------------------------------

describe("runDiagnostics — ESLint", () => {
  it("runs eslint and returns structured diagnostics", async () => {
    const config = {
      repoRoot: "/fake/repo",
      runners: ["eslint"] as const
    } as unknown as DiagnosticsConfig;
    const executor = eslintExecutor(SAMPLE_ESLINT_OUTPUT);
    const result = await runDiagnostics(config, executor);
    expect(result.issues.length).toBeGreaterThanOrEqual(3);
    expect(result.issues[0]?.source).toBe("eslint");
    expect(result.summary).toContain("diagnostic(s)");
  });

  it("uses configured eslint command", async () => {
    const config = {
      repoRoot: "/fake/repo",
      runners: ["eslint"] as const,
      eslintCommand: ["npx", "eslint", "--format", "unix"]
    } as unknown as DiagnosticsConfig;
    const executor = eslintExecutor(SAMPLE_ESLINT_UNIX_OUTPUT);
    const result = await runDiagnostics(config, executor);
    expect(result.issues).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// runDiagnostics — generic
// ---------------------------------------------------------------------------

describe("runDiagnostics — generic command", () => {
  it("runs a generic command and treats stderr as diagnostics", async () => {
    const config = {
      repoRoot: "/fake/repo",
      runners: ["generic"] as const,
      genericCommand: ["npx", "custom-linter"]
    } as unknown as DiagnosticsConfig;
    const executor = executorWithResult({
      exitCode: 1,
      stdout: "",
      stderr: "src/a.ts(1,2): error CUSTOM001: Something wrong.",
      durationMs: 5
    });
    const result = await runDiagnostics(config, executor);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.source).toBe("generic");
    expect(result.issues[0]?.code).toBe("CUSTOM001");
  });

  it("returns empty issues when generic command has no output", async () => {
    const config = {
      repoRoot: "/fake/repo",
      runners: ["generic"] as const,
      genericCommand: ["npx", "custom-linter"]
    } as unknown as DiagnosticsConfig;
    const executor = executorWithResult({
      exitCode: 0,
      stdout: "All good.",
      stderr: "",
      durationMs: 5
    });
    const result = await runDiagnostics(config, executor);
    expect(result.issues).toHaveLength(0);
  });

  it("throws when generic runner has no command configured", async () => {
    const config = { repoRoot: "/fake/repo", runners: ["generic"] as const } as unknown as DiagnosticsConfig;
    await expect(runDiagnostics(config)).rejects.toThrow("genericCommand");
  });
});

// ---------------------------------------------------------------------------
// runDiagnostics — multiple runners
// ---------------------------------------------------------------------------

describe("runDiagnostics — multiple runners", () => {
  it("merges issues from tsc and eslint", async () => {
    const config = {
      repoRoot: "/fake/repo",
      runners: ["tsc", "eslint"] as const
    } as unknown as DiagnosticsConfig;
    // Create an executor that supports both commands
    const multiExecutor: CommandExecutor = async (cmd) => {
      const cmdStr = cmd.join(" ");
      if (cmdStr.includes("eslint")) {
        return { exitCode: 1, stdout: SAMPLE_ESLINT_OUTPUT, stderr: "", durationMs: 5 };
      }
      return { exitCode: 2, stdout: SAMPLE_TSC_OUTPUT, stderr: "", durationMs: 5 };
    };
    const result = await runDiagnostics(config, multiExecutor);
    expect(result.issues.length).toBeGreaterThanOrEqual(8); // 5 tsc + 3+ eslint
    const sources = new Set(result.issues.map((i) => i.source));
    expect(sources.has("tsc")).toBe(true);
    expect(sources.has("eslint")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatForModel
// ---------------------------------------------------------------------------

describe("formatForModel", () => {
  const sampleIssues: DiagnosticsIssue[] = [
    { file: "src/a.ts", line: 10, column: 5, severity: "error", code: "TS2322", message: "Type 'string' is not assignable to type 'number'.", source: "tsc" },
    { file: "src/a.ts", line: 15, column: 8, severity: "error", code: "TS2345", message: "Argument of type 'null' is not assignable to parameter of type 'string'.", source: "tsc" },
    { file: "src/b.ts", line: 3, column: 12, severity: "warning", code: "TS6133", message: "'x' is declared but its value is never read.", source: "tsc" },
    { file: "src/b.ts", line: 1, column: 1, severity: "error", code: "no-unused-vars", message: "'x' is assigned a value but never used.", source: "eslint" },
    { file: "src/utils/helpers.ts", line: 22, column: 4, severity: "error", code: "TS2554", message: "Expected 2 arguments, but got 1.", source: "tsc" }
  ];

  it("formats issues grouped by file", () => {
    const formatted = formatForModel(sampleIssues, 10_000);
    expect(formatted).toContain("src/a.ts");
    expect(formatted).toContain("src/b.ts");
    expect(formatted).toContain("TS2322");
    expect(formatted).toContain("TS6133");
  });

  it("includes summary header with counts", () => {
    const formatted = formatForModel(sampleIssues, 10_000);
    expect(formatted).toContain("5 diagnostic");
    expect(formatted).toContain("4 error");
    expect(formatted).toContain("1 warning");
  });

  it("handles empty issues", () => {
    const formatted = formatForModel([], 10_000);
    expect(formatted).toContain("No diagnostics");
  });

  it("respects token budget by truncating", () => {
    // Many issues to force truncation
    const manyIssues: DiagnosticsIssue[] = [];
    for (let i = 0; i < 200; i++) {
      manyIssues.push({
        file: `src/module${i % 5}/${i}.ts`,
        line: i * 2,
        column: 1,
        severity: "error",
        code: `E${String(i).padStart(4, "0")}`,
        message: `This is a very long diagnostic message for issue number ${i} that contains substantial detail about what went wrong and how to fix it.`,
        source: "tsc"
      });
    }
    const smallBudget = 500; // ~2000 chars
    const formatted = formatForModel(manyIssues, smallBudget);
    const estimatedTokens = Math.ceil(formatted.length / 4);
    // Allow a bit of slop — the budget is a target, not a hard byte cap.
    // The header + truncation notice plus last-fitting issue can overshoot slightly.
    expect(estimatedTokens).toBeLessThanOrEqual(smallBudget + 30);
  });

  it("does not truncate when issues fit within budget", () => {
    const fewIssues = makeIssues([{ file: "src/a.ts" }, { file: "src/b.ts" }]);
    const formatted = formatForModel(fewIssues, 100_000);
    expect(formatted).toContain("src/a.ts");
    expect(formatted).toContain("src/b.ts");
    expect(formatted).not.toContain("truncated");
  });

  it("includes truncation notice when budget exceeded", () => {
    const manyIssues: DiagnosticsIssue[] = [];
    for (let i = 0; i < 500; i++) {
      manyIssues.push({
        file: `src/f${i}.ts`,
        line: i,
        column: 1,
        severity: "error",
        code: `ERR_${i}`,
        message: `Error message for issue ${i} with additional descriptive text.`,
        source: "tsc"
      });
    }
    const formatted = formatForModel(manyIssues, 200); // very small budget
    expect(formatted).toContain("truncated");
    expect(formatted).toContain("budget");
  });

  it("groups issues by file", () => {
    const issues: DiagnosticsIssue[] = [
      { file: "src/a.ts", line: 1, column: 1, severity: "error", code: "E1", message: "M1", source: "tsc" },
      { file: "src/b.ts", line: 2, column: 2, severity: "error", code: "E2", message: "M2", source: "tsc" },
      { file: "src/a.ts", line: 3, column: 3, severity: "warning", code: "W1", message: "M3", source: "tsc" }
    ];
    const formatted = formatForModel(issues, 10_000);
    // "src/a.ts" should appear as a header once (wrapped in markdown bold), not repeated
    const aMatches = formatted.split("\n").filter((l) => l.trim() === "**src/a.ts**").length;
    expect(aMatches).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// formatForModel — source labels
// ---------------------------------------------------------------------------

describe("formatForModel — source labels", () => {
  it("labels mixed-source issues", () => {
    const issues: DiagnosticsIssue[] = [
      { file: "src/a.ts", line: 1, column: 1, severity: "error", code: "TS2322", message: "X", source: "tsc" },
      { file: "src/a.ts", line: 2, column: 1, severity: "error", code: "no-unused", message: "Y", source: "eslint" }
    ];
    const formatted = formatForModel(issues, 10_000);
    expect(formatted).toContain("[tsc]");
    expect(formatted).toContain("[eslint]");
  });

  it("omits source labels when all issues are from same source", () => {
    const issues: DiagnosticsIssue[] = [
      { file: "src/a.ts", line: 1, column: 1, severity: "error", code: "TS1", message: "X", source: "tsc" },
      { file: "src/b.ts", line: 2, column: 2, severity: "error", code: "TS2", message: "Y", source: "tsc" }
    ];
    const formatted = formatForModel(issues, 10_000);
    expect(formatted).not.toContain("[tsc]");
  });
});

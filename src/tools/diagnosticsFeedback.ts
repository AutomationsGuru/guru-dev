/**
 * Diagnostics Feedback (IDEA-F65-DIAG-LOOP-01)
 *
 * After file edits, run diagnostics (tsc/eslint/generic cmd) and feed errors
 * into the next turn budget-capped. The formatForModel F56 compose pattern
 * groups issues by file, sorts by severity, and truncates to a token budget
 * using the canonical ~4 chars/token estimator.
 */
import { existsSync } from "node:fs";
import { join, normalize, relative, resolve } from "node:path";

import { z } from "zod";

import { executeCommand, type CommandExecutor } from "../review/gates.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const DiagnosticsIssueSchema = z
  .object({
    file: z.string(),
    line: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
    severity: z.enum(["error", "warning"]),
    code: z.string(),
    message: z.string(),
    source: z.enum(["tsc", "eslint", "generic"])
  })
  .strict();
export type DiagnosticsIssue = z.infer<typeof DiagnosticsIssueSchema>;

export const DiagnosticsConfigSchema = z
  .object({
    repoRoot: z.string().trim().min(1),
    /** Which diagnostics runners to invoke. Empty array = no-op. */
    runners: z.array(z.enum(["tsc", "eslint", "generic"])).default([]),
    /** Optional repo-relative paths to filter diagnostics. */
    paths: z.array(z.string().trim().min(1)).optional(),
    /** Override the eslint command (default: ["npx", "eslint", "--format", "unix"]). */
    eslintCommand: z.array(z.string()).optional(),
    /** The generic command to run when "generic" is in runners. Required if used. */
    genericCommand: z.array(z.string()).optional(),
    /** Timeout per runner (ms). */
    timeoutMs: z.number().int().positive().default(120_000)
  })
  .strict();
export type DiagnosticsConfig = z.infer<typeof DiagnosticsConfigSchema>;

export interface RunDiagnosticsResult {
  readonly issues: DiagnosticsIssue[];
  readonly summary: string;
  readonly exitCode: number | null;
}

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

/** TSC line: `src/a.ts(10,5): error TS2322: message` */
const TSC_LINE_RE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS(\d+):\s+(.*)$/u;

/** ESLint UNIX formatter line: `/path/to/file:line:col: message. [Severity/rule]` */
const ESLINT_UNIX_RE = /^(.+?):(\d+):(\d+):\s+(.*?)\.?\s*\[(Error|Warning)\/(.+?)\]$/u;

/** ESLint STYLISH formatter line: `  line:col  severity  message  rule` */
const ESLINT_STYLISH_RE = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(.+)$/u;

/** ESLint file header: `/path/to/file` (absolute path, no colon followed by number) */
const ESLINT_FILE_RE = /^(\/[^\s].+)$/u;

/** Generic `file(line,col): severity CODE: message` line */
const GENERIC_DIAG_RE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(\S+):\s+(.*)$/u;

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/**
 * Parse `tsc --noEmit` output into structured diagnostics.
 * Exported for direct use and for testing.
 */
export function parseTscDiagnostics(text: string): DiagnosticsIssue[] {
  const out: DiagnosticsIssue[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = TSC_LINE_RE.exec(line.trim());
    if (!match) {
      continue;
    }
    const [, file, lineNo, col, severity, code, message] = match;
    out.push({
      file: normalizePath(file!),
      line: Number(lineNo),
      column: Number(col),
      severity: severity as "error" | "warning",
      code: `TS${code}`,
      message: message!,
      source: "tsc"
    });
  }
  return out;
}

/**
 * Parse ESLint output (supports both unix and stylish formatters).
 * Exported for direct use and for testing.
 */
export function parseEslintOutput(text: string): DiagnosticsIssue[] {
  const out: DiagnosticsIssue[] = [];
  const lines = text.split(/\r?\n/u);
  let currentFile = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    // Try unix format first: `/path:line:col: message. [Severity/rule]`
    const unixMatch = ESLINT_UNIX_RE.exec(line.trim());
    if (unixMatch) {
      const [, file, lineNo, col, message, severity, rule] = unixMatch;
      out.push({
        file: normalizePath(file!),
        line: Number(lineNo),
        column: Number(col),
        severity: (severity?.toLowerCase() ?? "error") as "error" | "warning",
        code: rule!,
        message: (message ?? "").trim().replace(/\.$/, ""),
        source: "eslint"
      });
      continue;
    }

    // Stylish file header: `/path/to/file`
    const fileMatch = ESLINT_FILE_RE.exec(line.trim());
    if (fileMatch && !line.includes(":")) {
      currentFile = fileMatch[1]!;
      continue;
    }

    // Stylish issue line: `  line:col  severity  message  rule`
    if (currentFile) {
      const stylishMatch = ESLINT_STYLISH_RE.exec(line);
      if (stylishMatch) {
        const [, lineNo, col, severity, message, rule] = stylishMatch;
        out.push({
          file: normalizePath(currentFile),
          line: Number(lineNo),
          column: Number(col),
          severity: (severity ?? "error") as "error" | "warning",
          code: rule ?? "unknown",
          message: (message ?? "").trim().replace(/\s{2,}/gu, " "),
          source: "eslint"
        });
      }
    }
  }

  return out;
}

/**
 * Best-effort parse of generic command output (stderr/stdout).
 * Matches `file(line,col): severity CODE: message` lines.
 * Falls back to attaching the full text as a single issue with a raw scan.
 */
export function parseGenericDiagnostics(text: string): DiagnosticsIssue[] {
  const out: DiagnosticsIssue[] = [];
  const lines = text.split(/\r?\n/u);

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const match = GENERIC_DIAG_RE.exec(trimmed);
    if (match) {
      const [, file, lineNo, col, severity, code, message] = match;
      out.push({
        file: normalizePath(file!),
        line: Number(lineNo),
        column: Number(col),
        severity: severity as "error" | "warning",
        code: code!,
        message: message!,
        source: "generic"
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function normalizePath(candidate: string): string {
  return candidate.replace(/\\/gu, "/");
}

function normalizeRepoPath(repoRoot: string, candidate: string): string {
  const abs = resolve(repoRoot, candidate);
  return normalize(relative(repoRoot, abs)).replace(/\\/gu, "/");
}

function matchesPathFilter(repoRoot: string, file: string, filters: readonly string[] | undefined): boolean {
  if (!filters?.length) {
    return true;
  }
  const normalizedFile = normalizeRepoPath(repoRoot, file);
  return filters.some((filter) => {
    const normalizedFilter = normalizeRepoPath(repoRoot, filter);
    return normalizedFile === normalizedFilter || normalizedFile.startsWith(`${normalizedFilter}/`);
  });
}

// ---------------------------------------------------------------------------
// Command resolution
// ---------------------------------------------------------------------------

async function resolveTscCommand(repoRoot: string): Promise<readonly string[]> {
  const pkgPath = join(repoRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const { readFile } = await import("node:fs/promises");
      const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      if (pkg.scripts?.typecheck) {
        return ["npm", "run", "typecheck"];
      }
    } catch {
      // fall through
    }
  }
  return ["npx", "tsc", "--noEmit"];
}

// ---------------------------------------------------------------------------
// runDiagnostics
// ---------------------------------------------------------------------------

/**
 * Run the configured diagnostics runners and return structured issues.
 *
 * Each runner is invoked independently; results are merged. The `executor`
 * parameter allows injecting a mock for testing.
 */
export async function runDiagnostics(
  config: DiagnosticsConfig,
  executor: CommandExecutor = executeCommand
): Promise<RunDiagnosticsResult> {
  const parsed = DiagnosticsConfigSchema.parse(config);
  const repoRoot = resolve(parsed.repoRoot);
  const allIssues: DiagnosticsIssue[] = [];
  const summaries: string[] = [];
  let lastExitCode: number | null = null;

  for (const runner of parsed.runners) {
    switch (runner) {
      case "tsc": {
        const command = await resolveTscCommand(repoRoot);
        const result = await executor(command, {
          cwd: repoRoot,
          timeoutMs: parsed.timeoutMs,
          gate: { kind: "validation", name: "diagnostics_feedback_tsc", command, required: false }
        });
        lastExitCode = result.exitCode;
        const text = `${result.stdout}\n${result.stderr}`;
        const tscIssues = parseTscDiagnostics(text).filter((item) =>
          matchesPathFilter(repoRoot, item.file, config.paths)
        );
        allIssues.push(...tscIssues);
        summaries.push(
          tscIssues.length === 0
            ? result.exitCode === 0
              ? "No TypeScript diagnostics."
              : "Typecheck completed but no structured TS diagnostics were parsed."
            : `${tscIssues.length} TS diagnostic(s)${config.paths?.length ? " (path-filtered)" : ""}`
        );
        break;
      }

      case "eslint": {
        const command = parsed.eslintCommand ?? ["npx", "eslint", "--format", "unix", "."];
        const result = await executor(command, {
          cwd: repoRoot,
          timeoutMs: parsed.timeoutMs,
          gate: { kind: "validation", name: "diagnostics_feedback_eslint", command, required: false }
        });
        lastExitCode = result.exitCode;
        const text = `${result.stdout}\n${result.stderr}`;
        const eslintIssues = parseEslintOutput(text).filter((item) =>
          matchesPathFilter(repoRoot, item.file, config.paths)
        );
        allIssues.push(...eslintIssues);
        summaries.push(
          eslintIssues.length === 0
            ? "No ESLint diagnostics."
            : `${eslintIssues.length} ESLint diagnostic(s)${config.paths?.length ? " (path-filtered)" : ""}`
        );
        break;
      }

      case "generic": {
        if (!parsed.genericCommand || parsed.genericCommand.length === 0) {
          throw new Error("genericCommand is required when 'generic' runner is enabled");
        }
        const result = await executor(parsed.genericCommand, {
          cwd: repoRoot,
          timeoutMs: parsed.timeoutMs,
          gate: { kind: "validation", name: "diagnostics_feedback_generic", command: parsed.genericCommand, required: false }
        });
        lastExitCode = result.exitCode;
        const text = `${result.stdout}\n${result.stderr}`;
        const genericIssues = parseGenericDiagnostics(text).filter((item) =>
          matchesPathFilter(repoRoot, item.file, config.paths)
        );
        allIssues.push(...genericIssues);
        summaries.push(
          genericIssues.length === 0
            ? "No generic command diagnostics."
            : `${genericIssues.length} generic diagnostic(s)${config.paths?.length ? " (path-filtered)" : ""}`
        );
        break;
      }

      default:
        break;
    }
  }

  const summary =
    allIssues.length === 0
      ? summaries.join(" ") || "No diagnostics (no runners configured)."
      : `${allIssues.length} diagnostic(s) total: ${summaries.join("; ")}`;

  return { issues: allIssues, summary, exitCode: lastExitCode };
}

// ---------------------------------------------------------------------------
// formatForModel — F56 compose pattern (budget-aware model formatting)
// ---------------------------------------------------------------------------

// Canonical estimator: ~4 chars per token (src/compaction/estimate.ts)
const CHARS_PER_TOKEN = 4;

/**
 * Format diagnostics issues for injection into a model context, respecting a
 * token budget. Groups issues by file, sorts errors before warnings, and
 * truncates when the budget is exceeded.
 *
 * The budget is a TOKEN budget. Issues are emitted in priority order (file
 * groups sorted by error count descending, errors before warnings within each
 * file) until the estimated token count reaches the budget. A truncation notice
 * is appended when issues are dropped.
 */
export function formatForModel(issues: readonly DiagnosticsIssue[], tokenBudget: number): string {
  if (issues.length === 0) {
    return "No diagnostics to report.";
  }

  const charBudget = tokenBudget * CHARS_PER_TOKEN;
  const hasMixedSources = new Set(issues.map((i) => i.source)).size > 1;

  // Group by file
  const byFile = new Map<string, DiagnosticsIssue[]>();
  for (const issue of issues) {
    const existing = byFile.get(issue.file);
    if (existing) {
      existing.push(issue);
    } else {
      byFile.set(issue.file, [issue]);
    }
  }

  // Sort file groups: most issues first, then by file name
  const sortedFiles = [...byFile.entries()].sort((a, b) => {
    const countDiff = b[1].length - a[1].length;
    return countDiff !== 0 ? countDiff : a[0].localeCompare(b[0]);
  });

  // Within each file group: errors before warnings, then by line
  for (const [, fileIssues] of sortedFiles) {
    fileIssues.sort((a, b) => {
      if (a.severity !== b.severity) {
        return a.severity === "error" ? -1 : 1;
      }
      return a.line - b.line || a.column - b.column;
    });
  }

  // Count summary
  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warningCount = issues.filter((i) => i.severity === "warning").length;

  // Build header
  const header = [
    `## Diagnostics Feedback`,
    `${issues.length} diagnostic(s): ${errorCount} error(s), ${warningCount} warning(s)`,
    ""
  ].join("\n");
  let output = header;
  let truncated = false;
  let included = 0;

  for (const [file, fileIssues] of sortedFiles) {
    const fileHeader = `\n**${file}**\n`;
    let fileBlock = fileHeader;

    for (const issue of fileIssues) {
      const sourceLabel = hasMixedSources ? ` [${issue.source}]` : "";
      const line = `${issue.line}:${issue.column}  ${issue.severity === "error" ? "🔴" : "🟡"}  ${issue.code}${sourceLabel}: ${issue.message}\n`;
      fileBlock += line;
    }

    // Check if adding this file block would exceed budget
    if (output.length + fileBlock.length > charBudget) {
      truncated = true;
      break;
    }

    output += fileBlock;
    included += fileIssues.length;
  }

  // If we couldn't even fit the header + first file, at least show header + truncation
  if (included === 0 && issues.length > 0) {
    // Fit as much of the first file as we can
    const [firstFile, firstIssues] = sortedFiles[0]!;
    const fileHeader = `\n**${firstFile}**\n`;
    output += fileHeader;
    for (const issue of firstIssues) {
      const sourceLabel = hasMixedSources ? ` [${issue.source}]` : "";
      const line = `${issue.line}:${issue.column}  ${issue.severity === "error" ? "🔴" : "🟡"}  ${issue.code}${sourceLabel}: ${issue.message}\n`;
      if (output.length + line.length > charBudget) {
        break;
      }
      output += line;
      included += 1;
    }
    truncated = true;
  }

  if (truncated) {
    const remaining = issues.length - included;
    output += `\n---\n[diagnostics truncated: ${remaining} issue(s) omitted — token budget ${tokenBudget}]\n`;
  }

  return output;
}

import {
  SelfCheckPassConfigSchema,
  type SelfCheckInput,
  type SelfCheckIssue,
  type SelfCheckPassConfig,
  type SelfCheckResult
} from "./selfCheckSchema.js";
import { isRiskyPath } from "../safety/policyGuard.js";

/**
 * IDE-F84-SELF-CHECK — the optional, deterministic, post-mutate self-check pass.
 *
 * Run AFTER the builder finishes mutating and BEFORE it claims done. It is the
 * cheap, obvious-defect screen; the native critic panel (B5) is the deep,
 * model-powered one. They are NOT substitutes — the self-check catches things
 * that would burn a model call to re-confirm (empty diff + summary, accidental
 * secret edits, risky-path writes the operator flagged).
 *
 * Hard contract:
 *   - Never calls a model.
 *   - Never spawns a subprocess.
 *   - Never widens the project's hard limits.
 *   - Default-disabled; recommended only for the ship quality tier.
 *   - Always emits a receipt, even when skipped or clean, so a missing receipt
 *     is itself detectable downstream.
 */

const SEVERITY_RANK: Readonly<Record<"low" | "medium" | "high", number>> = {
  low: 0,
  medium: 1,
  high: 2
};

/** Heuristic secret markers — explicit values are deliberately not included. */
const SECRET_LINE_PATTERNS: readonly RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/u, // AWS access key
  /\bAIza[0-9A-Za-z\-_]{35}\b/u, // Google API key
  /\bghp_[A-Za-z0-9]{30,}\b/u, // GitHub PAT
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u, // Slack tokens
  /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/u, // JWT
  /(?:\bapi[_\-]?key\b|\bsecret\b|\bpassword\b|\bpasswd\b|\btoken\b)\s*[:=]\s*["'][^"'\s]{8,}/iu // generic
];

const HUNK_HEADER = /^@@\s+-\d+(?:,\d+)?\s+\+(?<start>\d+)(?:,(?<count>\d+))?\s+@@/u;

/**
 * Walk a unified diff and yield every added (+) line along with the file path
 * the hunk belongs to and the 1-indexed target line number. Comments and blank
 * lines are kept; callers decide what to flag.
 */
function* iterateAddedLines(diff: string): Generator<{ file: string; line: number; text: string }> {
  if (!diff) {
    return;
  }
  let currentFile = "";
  let currentLine = 0;
  for (const rawLine of diff.split(/\r?\n/u)) {
    if (rawLine.startsWith("+++ ")) {
      // `+++ b/path/to/file` (or `/dev/null` for pure deletions).
      const stripped = rawLine.slice(4).replace(/^b\//u, "").trim();
      currentFile = stripped === "/dev/null" ? "" : stripped;
      continue;
    }
    if (rawLine.startsWith("--- ")) {
      continue;
    }
    if (rawLine.startsWith("@@")) {
      const match = HUNK_HEADER.exec(rawLine);
      currentLine = match?.groups ? Number.parseInt(match.groups.start ?? "0", 10) || 0 : 0;
      continue;
    }
    if (rawLine.startsWith("diff --git ")) {
      currentFile = "";
      continue;
    }
    if (rawLine.startsWith("+")) {
      if (!currentFile) {
        continue; // hunk before any `+++` header — skip rather than misreport.
      }
      yield { file: currentFile, line: currentLine, text: rawLine.slice(1) };
      currentLine += 1;
      continue;
    }
    if (rawLine.startsWith(" ")) {
      currentLine += 1;
    }
  }
}

/** True when `path` matches any pattern in `patterns`. Delegates to the project's
 * canonical `isRiskyPath` matcher so the pass stays in sync with the runtime
 * hardening policy instead of inventing a parallel glob dialect. */
function pathMatchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => pattern.length > 0 && isRiskyPath(path, [pattern]));
}

/** Build the canonical receipt string. Always emits one block, never throws. */
export function formatReceipt(input: {
  readonly verdict: SelfCheckResult["verdict"];
  readonly issues: readonly SelfCheckIssue[];
  readonly skipped: boolean;
  readonly changedPaths: readonly string[];
}): string {
  const lines: string[] = [
    `self-check ${input.verdict}${input.skipped ? " (skipped)" : ""}`,
    `changedPaths: ${input.changedPaths.length}`
  ];
  if (input.issues.length === 0) {
    lines.push("issues: 0");
  } else {
    lines.push(`issues: ${input.issues.length}`);
    for (const issue of input.issues) {
      const where = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ""}` : "(n/a)";
      lines.push(`  [${issue.severity}] ${issue.code} @ ${where} — ${issue.message}`);
    }
  }
  return lines.join("\n");
}

/**
 * Run the self-check pass against the builder's reported change. Pure function:
 * no I/O, no model, no subprocess. When the pass is disabled the receipt still
 * says "skipped" so downstream readers always see the marker.
 *
 * @param input     changed paths + diff + summary
 * @param config    the project's self-check tuning (default = disabled)
 * @param runtimePatterns   risky-path patterns from `runtimeHardening`; merged
 *                          with `config.riskyPathPatterns` so the two lists
 *                          stay in sync without duplicating config.
 */
export function runSelfCheckPass(
  input: SelfCheckInput,
  config: SelfCheckPassConfig = SelfCheckPassConfigSchema.parse({}),
  runtimePatterns: readonly string[] = []
): SelfCheckResult {
  if (!config.enabled) {
    const receipt = formatReceipt({ verdict: "pass", issues: [], skipped: true, changedPaths: input.changedPaths });
    return { verdict: "pass", issues: [], receipt, skipped: true };
  }

  const issues: SelfCheckIssue[] = [];
  const minRank = SEVERITY_RANK[config.minSeverity];

  const note = (issue: SelfCheckIssue): void => {
    if (SEVERITY_RANK[issue.severity] >= minRank) {
      issues.push(issue);
    }
  };

  // 1. Summary present, diff empty, paths empty — the builder claims work but
  //    the working tree has no evidence. HIGH because it correlates with a
  //    hallucinated completion.
  const hasDiff = input.diff.trim().length > 0;
  const hasPaths = input.changedPaths.length > 0;
  const hasSummary = input.summary.trim().length > 0;
  if (hasSummary && !hasDiff && !hasPaths) {
    note({
      code: "summary-without-evidence",
      severity: "high",
      message: "summary is set but no diff or changed paths were provided."
    });
  }

  // 2. Paths present, diff empty — path list came from somewhere, but the diff
  //    is blank. Almost always a gatherer bug or a forgotten re-stage. HIGH.
  if (hasPaths && !hasDiff) {
    note({
      code: "empty-diff",
      severity: "high",
      message: "changedPaths is non-empty but the diff is empty."
    });
  }

  // 3. Secret-shaped additions — high severity, no false-positive tolerance.
  for (const addition of iterateAddedLines(input.diff)) {
    for (const pattern of SECRET_LINE_PATTERNS) {
      if (pattern.test(addition.text)) {
        note({
          code: "secret-shaped-addition",
          severity: "high",
          message: `added line matches a secret marker (${pattern.source.slice(0, 24)}…)`,
          file: addition.file,
          line: addition.line
        });
        break;
      }
    }
  }

  // 4. Risky-path writes — combine the project's hardening defaults with the
  //    pass's own list, so operators only have to wire one place. HIGH.
  const risky = [...runtimePatterns, ...config.riskyPathPatterns];
  if (risky.length > 0) {
    for (const path of input.changedPaths) {
      if (pathMatchesAny(path, risky)) {
        note({
          code: "risky-path",
          severity: "high",
          message: `changed path matches a risky-path pattern: ${path}`,
          file: path
        });
      }
    }
  }

  // 5. Truncate to the configured cap so a broken diff can't flood the receipt.
  const trimmed = issues.slice(0, config.maxIssues);
  const verdict: SelfCheckResult["verdict"] = trimmed.length > 0 ? "issues" : "pass";
  return {
    verdict,
    issues: trimmed,
    receipt: formatReceipt({ verdict, issues: trimmed, skipped: false, changedPaths: input.changedPaths }),
    skipped: false
  };
}

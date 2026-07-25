import { existsSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

import { z } from "zod";

/**
 * Task scorers (IDEA-E3, 2026-07-18) — OPTIONAL task-completion checks that
 * run against observed evidence (exit code, files, output text), separate from
 * the conversation transcript. A scorer never grades by asking a model; it
 * evaluates concrete observations, so its verdict is inspectable and honest:
 * missing evidence is a fail (or a skip for optional scorers), never a
 * claimed success.
 *
 * Three built-ins, no external grading service:
 *   - exit_code   — observed process exit code in an accepted set
 *   - file_exists — a path exists, structurally bound inside the context cwd
 *   - regex       — observed output matches (or with negate, must not match)
 *
 * Verdicts are three-valued: "pass" | "fail" | "partial". Aggregation keeps
 * every per-scorer result so a caller can inspect WHY, not just WHAT.
 */

export const SCORER_DETAIL_MAX_LENGTH = 240;

export const ScorerVerdictSchema = z.enum(["pass", "fail", "partial"]);
export type ScorerVerdict = z.infer<typeof ScorerVerdictSchema>;

/** What a scorer is allowed to see — observed evidence only, never the transcript. */
export interface ScorerContext {
  /** Working directory the task ran in; file_exists is structurally bound inside it. */
  readonly cwd: string;
  /** Observed process exit code, when the task produced one. */
  readonly exitCode?: number;
  /** Observed output text (already transcript-trimmed by the caller), when any. */
  readonly outputText?: string;
}

export interface ScorerResult {
  readonly scorerId: string;
  readonly verdict: Exclude<ScorerVerdict, "partial"> | "skip";
  /** Bounded, human-inspectable explanation — never a wholesale echo of the evidence. */
  readonly detail: string;
}

export interface TaskScorer {
  readonly id: string;
  /** When true, missing evidence yields "skip" (degrades aggregate to partial) instead of "fail". */
  readonly optional: boolean;
  score(context: ScorerContext): ScorerResult;
}

const ScorerBaseFields = {
  /** Stable id for receipts/inspection; defaults to the scorer kind. */
  id: z.string().trim().min(1).max(60).optional(),
  /** Optional scorers skip on missing evidence instead of failing. */
  optional: z.boolean().default(false)
} as const;

export const ExitCodeScorerConfigSchema = z
  .object({
    kind: z.literal("exit_code"),
    expected: z.union([z.number().int(), z.array(z.number().int()).min(1).max(32)]),
    ...ScorerBaseFields
  })
  .strict();

export const FileExistsScorerConfigSchema = z
  .object({
    kind: z.literal("file_exists"),
    path: z.string().trim().min(1).max(512),
    ...ScorerBaseFields
  })
  .strict();

export const RegexScorerConfigSchema = z
  .object({
    kind: z.literal("regex"),
    pattern: z.string().min(1).max(1_024),
    /** When true, the pattern must NOT match (e.g. a leak marker). */
    negate: z.boolean().default(false),
    ...ScorerBaseFields
  })
  .strict();

export const ScorerConfigSchema = z.discriminatedUnion("kind", [
  ExitCodeScorerConfigSchema,
  FileExistsScorerConfigSchema,
  RegexScorerConfigSchema
]);
export type ScorerConfig = z.infer<typeof ScorerConfigSchema>;
/** Caller-facing shape: defaults not yet applied (optional/negate may be omitted). */
export type ScorerConfigInput = z.input<typeof ScorerConfigSchema>;

function bound(detail: string): string {
  return detail.length > SCORER_DETAIL_MAX_LENGTH ? `${detail.slice(0, SCORER_DETAIL_MAX_LENGTH - 1)}…` : detail;
}

function missingEvidence(id: string, what: string, optional: boolean): ScorerResult {
  return optional
    ? { scorerId: id, verdict: "skip", detail: `skipped: no ${what} observed (optional scorer)` }
    : { scorerId: id, verdict: "fail", detail: `no ${what} observed — cannot claim success without evidence` };
}

function createExitCodeScorer(config: z.infer<typeof ExitCodeScorerConfigSchema>): TaskScorer {
  const accepted = new Set(Array.isArray(config.expected) ? config.expected : [config.expected]);
  const id = config.id ?? "exit_code";
  return {
    id,
    optional: config.optional,
    score(context) {
      if (context.exitCode === undefined) {
        return missingEvidence(id, "exit code", config.optional);
      }
      const pass = accepted.has(context.exitCode);
      return {
        scorerId: id,
        verdict: pass ? "pass" : "fail",
        detail: pass
          ? `exit code ${context.exitCode} accepted (${[...accepted].join(", ")})`
          : `exit code ${context.exitCode} not in accepted set (${[...accepted].join(", ")})`
      };
    }
  };
}

function createFileExistsScorer(config: z.infer<typeof FileExistsScorerConfigSchema>): TaskScorer {
  const id = config.id ?? "file_exists";
  return {
    id,
    optional: config.optional,
    score(context) {
      // Structural scope bound: the path must resolve INSIDE the context cwd.
      // A scorer may never inspect arbitrary host paths — scope stays with the task.
      const root = resolve(context.cwd);
      const target = isAbsolute(config.path) ? resolve(config.path) : resolve(root, config.path);
      if (target !== root && !target.startsWith(`${root}${sep}`)) {
        return {
          scorerId: id,
          verdict: "fail",
          detail: bound(`path '${config.path}' resolves outside the task working directory — refused`)
        };
      }
      const pass = existsSync(target);
      return {
        scorerId: id,
        verdict: pass ? "pass" : "fail",
        detail: pass ? `path '${config.path}' exists` : `path '${config.path}' does not exist in the task working directory`
      };
    }
  };
}

function createRegexScorer(config: z.infer<typeof RegexScorerConfigSchema>): TaskScorer {
  let compiled: RegExp;
  try {
    compiled = new RegExp(config.pattern);
  } catch (cause) {
    throw new Error(`invalid regex pattern for scorer '${config.id ?? "regex"}': ${(cause as Error).message}`);
  }
  const id = config.id ?? "regex";
  return {
    id,
    optional: config.optional,
    score(context) {
      if (context.outputText === undefined) {
        return missingEvidence(id, "output", config.optional);
      }
      const matched = compiled.test(context.outputText);
      const pass = config.negate ? !matched : matched;
      return {
        scorerId: id,
        verdict: pass ? "pass" : "fail",
        detail: bound(
          config.negate
            ? pass
              ? `pattern /${config.pattern}/ absent (required absent)`
              : `pattern /${config.pattern}/ present but required absent`
            : pass
              ? `pattern /${config.pattern}/ matched`
              : `pattern /${config.pattern}/ did not match observed output`
        )
      };
    }
  };
}

/** Build one scorer from config. Config-time validation: a bad regex throws HERE, not at score time. */
export function createScorer(config: ScorerConfigInput): TaskScorer {
  const parsed = ScorerConfigSchema.parse(config);
  switch (parsed.kind) {
    case "exit_code":
      return createExitCodeScorer(parsed);
    case "file_exists":
      return createFileExistsScorer(parsed);
    case "regex":
      return createRegexScorer(parsed);
  }
}

export interface ScorerAggregate {
  readonly verdict: ScorerVerdict;
  /** Every per-scorer result, in scorer order — inspectable, never collapsed to a bare verdict. */
  readonly results: readonly ScorerResult[];
  readonly summary: string;
}

/**
 * Aggregate a set of scorers against one observation context.
 *  - any "fail"                                   → fail
 *  - all "pass" (≥1 scorer)                       → pass
 *  - otherwise (passes + skips, or zero scorers)  → partial
 * Skips never convert a clean pass into a fail — optional scorers only ever
 * soften the verdict to partial, which is the honest signal for "scored, but
 * not every check had evidence".
 */
export function runScorers(scorers: readonly TaskScorer[], context: ScorerContext): ScorerAggregate {
  if (scorers.length === 0) {
    return { verdict: "partial", results: [], summary: "no scorers configured — task completion unscored" };
  }
  const results = scorers.map((scorer) => scorer.score(context));
  const failed = results.filter((r) => r.verdict === "fail").length;
  const skipped = results.filter((r) => r.verdict === "skip").length;
  const verdict: ScorerVerdict = failed > 0 ? "fail" : skipped > 0 ? "partial" : "pass";
  const summary = `${verdict}: ${results.length - failed - skipped} passed · ${failed} failed · ${skipped} skipped (${results
    .map((r) => `${r.scorerId}=${r.verdict}`)
    .join(", ")})`;
  return { verdict, results, summary };
}

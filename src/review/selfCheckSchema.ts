import { z } from "zod";

/**
 * IDEA-F84-SELF-CHECK-01 — durable schema for the optional post-mutate self-check pass.
 *
 * This is a BUILDER-side sanity check the loop runs against its OWN diff before
 * it claims done. It is deterministic, offline, and never calls a model — that is
 * the native critic panel's job. The self-check pass exists to catch cheap,
 * obviously-broken shapes (forgotten files, accidental secret edits, empty
 * diff with a non-empty summary) that a model call would only burn tokens to
 * re-confirm.
 *
 * Default is DISABLED — it is opt-in per project and recommended for the ship
 * quality tier, not the daily driver. It must never widen the hard limits or
 * replace the native critic panel.
 */

/** Severity of a single self-check finding. Modeled to match nativeCriticPanel. */
export const SelfCheckSeveritySchema = z.enum(["low", "medium", "high"]);

/**
 * One concrete issue the self-check pass raised about the diff under review.
 * `code` is a stable machine-readable handle (e.g. `empty-diff`, `risky-path`)
 * so callers can suppress or route specific issue families.
 */
export const SelfCheckIssueSchema = z
  .object({
    code: z.string().trim().min(1),
    severity: SelfCheckSeveritySchema,
    message: z.string().trim().min(1),
    file: z.string().trim().min(1).optional(),
    line: z.number().int().positive().optional()
  })
  .strict();
export type SelfCheckIssue = z.infer<typeof SelfCheckIssueSchema>;

/**
 * The input a builder hands the self-check pass.
 *
 * - `changedPaths` is the project-reported list of files touched; the pass
 *   cross-checks it against the actual `diff`.
 * - `diff` is the uncommitted diff text (the same one the native critic panel
 *   would be shown). Empty when the builder's mutation produced no edits —
 *   the pass still runs so it can flag a non-empty summary that pretends work
 *   happened.
 * - `summary` is the builder's own short blurb about what changed. The pass
 *   does NOT grade prose quality; it only flags hard contradictions
 *   (summary present, diff empty / file list empty).
 */
export const SelfCheckInputSchema = z
  .object({
    changedPaths: z.array(z.string().trim().min(1)).default([]),
    diff: z.string().default(""),
    summary: z.string().trim().default("")
  })
  .strict();
export type SelfCheckInput = z.infer<typeof SelfCheckInputSchema>;

/**
 * Optional self-check tuning. The defaults are conservative: the pass stays OFF,
 * and when enabled it only flags HIGH-severity shapes (secret-shaped additions,
 * risky-path writes, contradictions between summary and diff). MEDIUM/LOW can be
 * opted into per project.
 *
 * `riskyPathPatterns` is intentionally empty here — the pass falls back to the
 * project's `runtimeHardening.riskyPathPatterns` when the caller wires it that
 * way, instead of duplicating the list at config time.
 */
export const SelfCheckPassConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Severities the pass should report. Anything below is dropped before emit. */
    minSeverity: SelfCheckSeveritySchema.default("high"),
    /** Additional risky-path globs on top of the runtime hardening defaults. */
    riskyPathPatterns: z.array(z.string().trim().min(1)).default([]),
    /** Hard cap on issues the pass emits, so a broken diff can't flood the receipt. */
    maxIssues: z.number().int().positive().max(1_000).default(50)
  })
  .strict();
export type SelfCheckPassConfig = z.infer<typeof SelfCheckPassConfigSchema>;

/**
 * The pass output. `verdict` is a derived boolean projection of `issues`:
 * "pass" iff zero surviving issues at or above the configured severity.
 *
 * `receipt` is the durable, human-readable record — it is what the builder
 * writes to `handoffs/code-reviews/` so the reviewer / ship stage can audit
 * the self-check later. Kept in the same shape regardless of verdict so the
 * receipt is always produced (a missing receipt is itself a defect).
 */
export const SelfCheckResultSchema = z
  .object({
    verdict: z.enum(["pass", "issues"]),
    issues: z.array(SelfCheckIssueSchema),
    receipt: z.string().trim().min(1),
    /** True iff the pass was skipped because it is disabled in config. */
    skipped: z.boolean().default(false)
  })
  .strict();
export type SelfCheckResult = z.infer<typeof SelfCheckResultSchema>;

export const DEFAULT_SELF_CHECK_CONFIG: SelfCheckPassConfig = SelfCheckPassConfigSchema.parse({});

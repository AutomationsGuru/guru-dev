import { z } from "zod";

/**
 * Apply command queue — IDEA-F9 (`R-PD-CMDQ`).
 *
 * Optional staged command queue tied to pending/file apply: commands run only
 * after a successful file apply, and on failure the file apply is rolled back
 * when the command's rollback policy is `require`. Opt-in by construction —
 * nothing runs unless integration passes an apply outcome plus a command list.
 *
 * This packet is deliberately independent of the F4 pending sandbox: it
 * consumes a structural `CommandApplyOutcome` (path / applied / backupPath /
 * blockers) rather than importing F4 files, so either surface can land first.
 */

/** Per-command timeout ceiling: 10 minutes. */
export const APPLY_COMMAND_MAX_TIMEOUT_MS = 600_000;
export const APPLY_COMMAND_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Rollback policy for a failed command:
 * - `require` — failure rolls the file apply back from its backups (hard limit
 *   §3.1 preservation made reversible: restore prior state, never leave a
 *   half-applied change when the operator required the post-apply check).
 * - `report` — failure is surfaced only; the applied files stay as written.
 */
export const ApplyCommandRollbackPolicySchema = z.enum(["require", "report"]);
export type ApplyCommandRollbackPolicy = z.infer<typeof ApplyCommandRollbackPolicySchema>;

export const ApplyCommandSchema = z
  .object({
    /** Repo-root-relative working directory ("." for the root). Containment is enforced at execution time. */
    cwd: z.string().trim().min(1).default("."),
    /** Executable + arguments, no shell. argv[0] must be non-empty. */
    argv: z.array(z.string().min(1)).min(1),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(APPLY_COMMAND_MAX_TIMEOUT_MS)
      .default(APPLY_COMMAND_DEFAULT_TIMEOUT_MS),
    rollbackPolicy: ApplyCommandRollbackPolicySchema.default("require")
  })
  .strict();
export type ApplyCommand = z.infer<typeof ApplyCommandSchema>;

/** A staged queue entry: validated command plus identity and staging time. */
export const ApplyCommandQueueEntrySchema = ApplyCommandSchema.extend({
  id: z.string().trim().min(1),
  createdAt: z.string().trim().min(1)
}).strict();
export type ApplyCommandQueueEntry = z.infer<typeof ApplyCommandQueueEntrySchema>;

export const ApplyCommandStatusSchema = z.enum(["ok", "failed", "timeout"]);
export type ApplyCommandStatus = z.infer<typeof ApplyCommandStatusSchema>;

export const ApplyCommandResultSchema = z
  .object({
    id: z.string(),
    argv: z.array(z.string()),
    cwd: z.string(),
    status: ApplyCommandStatusSchema,
    /** null when the process never produced an exit code (spawn error / timeout kill). */
    exitCode: z.number().int().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    durationMs: z.number().int().min(0),
    /** Present when the process could not be started or was killed. */
    error: z.string().optional()
  })
  .strict();
export type ApplyCommandResult = z.infer<typeof ApplyCommandResultSchema>;

export const ApplyCommandQueueResultSchema = z
  .object({
    /** false when nothing ran (no applied ops or empty queue) — the skip path. */
    ran: z.boolean(),
    /** Why nothing ran; absent when ran=true. */
    skipReason: z.string().optional(),
    results: z.array(ApplyCommandResultSchema),
    /** true when at least one applied op was restored from backup after a failure. */
    rolledBack: z.boolean(),
    /** Repo-root-relative paths restored from backup, in restore order. */
    restoredPaths: z.array(z.string()),
    /** Ops that could not be restored (e.g. create ops have no prior state). */
    rollbackBlockers: z.array(z.string()),
    allOk: z.boolean()
  })
  .strict();
export type ApplyCommandQueueResult = z.infer<typeof ApplyCommandQueueResultSchema>;

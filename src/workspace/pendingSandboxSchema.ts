import { z } from "zod";

/**
 * Pending change sandbox — IDEA-F4 (`R-PD-PEND`, `R-PD-PEND-REV`).
 *
 * When `pendingSandbox` mode is enabled (opt-in; default OFF so YOLO
 * daily-driver behavior is unchanged), file-mutating tool results are staged
 * as pending operations instead of writing through. The operator can list,
 * reject by path, and apply selected or all staged operations. Apply always
 * preserves prior state via backup-before-write (hard limit §3.1 — no
 * destruction without preservation).
 */

export const PendingOpKindSchema = z.enum(["create", "update", "delete"]);
export type PendingOpKind = z.infer<typeof PendingOpKindSchema>;

export const PendingOpSchema = z
  .object({
    id: z.string().trim().min(1),
    /** Repo-root-relative path (forward slashes) the op would mutate. */
    path: z.string().trim().min(1),
    kind: PendingOpKindSchema,
    /** sha256 hex of the staged full content; omitted for delete ops. */
    contentHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    /** Full replacement content. Required for create/update; absent for delete. */
    fullContent: z.string().optional(),
    /** Optional unified-diff rendering for operator review. */
    unifiedDiff: z.string().optional(),
    /** Turn that produced the staged change (session correlation). */
    sourceTurnId: z.string().trim().min(1),
    /** ISO-8601 creation timestamp. */
    createdAt: z.string().trim().min(1)
  })
  .strict()
  .superRefine((op, ctx) => {
    if (op.kind === "delete") {
      if (op.fullContent !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "delete ops must not carry fullContent" });
      }
      return;
    }
    if (op.fullContent === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "create/update ops require fullContent" });
    }
    if (op.contentHash === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "create/update ops require contentHash" });
    }
  });
export type PendingOp = z.infer<typeof PendingOpSchema>;

/** Durable on-disk store shape under `.guru/pending/pending.json`. */
export const PendingSandboxStoreSchema = z
  .object({
    version: z.literal(1),
    ops: z.array(PendingOpSchema)
  })
  .strict();
export type PendingSandboxStore = z.infer<typeof PendingSandboxStoreSchema>;

export const PendingSandboxApplyResultSchema = z
  .object({
    path: z.string(),
    applied: z.boolean(),
    /** Repo-root-relative backup path preserving prior state; absent for create ops. */
    backupPath: z.string().optional(),
    blockers: z.array(z.string())
  })
  .strict();
export type PendingSandboxApplyResult = z.infer<typeof PendingSandboxApplyResultSchema>;

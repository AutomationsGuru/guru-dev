import { z } from "zod";

/**
 * Fleet work card (F63 / R-CL-KANBAN MVP) — a lightweight parallel-work unit:
 * id + title + status, optional isolation path (worktree), optional dependsOn[].
 *
 * Not a web kanban product. Cards live under the project overlay
 * (`.guru/cards/`) as one JSON file per card. Create allocates a local
 * isolation directory; it does not run `git worktree add` (that would mutate
 * the git topology and is out of scope for this MVP).
 *
 * Design notes (vision §1: independent, lightweight, no borrowed framework):
 * - `zod` is the only runtime dependency.
 * - Status is a small closed enum so a bad write cannot invent a free-form state.
 * - dependsOn is a list of card ids; cycle detection lives in the store, not the
 *   schema, because it needs the full graph.
 */

/** Lifecycle of a work card. Keep small; expand only with a plan that needs it. */
export const WorkCardStatusSchema = z.enum([
  "backlog",
  "ready",
  "in_progress",
  "blocked",
  "done",
  "cancelled"
]);
export type WorkCardStatus = z.infer<typeof WorkCardStatusSchema>;

/** One durable work card record. */
export const WorkCardSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    title: z.string().trim().min(1).max(200),
    status: WorkCardStatusSchema,
    /** Absolute or project-relative isolation path; set when create allocates one. */
    worktreePath: z.string().trim().min(1).optional(),
    /** Card ids this card depends on. Empty means no deps. */
    dependsOn: z.array(z.string().trim().min(1).max(64)).default([]),
    createdAt: z.string().trim().min(1),
    updatedAt: z.string().trim().min(1)
  })
  .strict();
export type WorkCard = z.infer<typeof WorkCardSchema>;

/** Input for createCard — id/timestamps/worktreePath are store-owned. */
export const CreateWorkCardInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    /** Defaults to `backlog` when omitted. */
    status: WorkCardStatusSchema.optional(),
    /** Dependency card ids. Validated for cycles against the live store. */
    dependsOn: z.array(z.string().trim().min(1).max(64)).optional(),
    /**
     * When true (default), allocate a local isolation directory for this card
     * and record it as `worktreePath`. When false, leave worktreePath unset.
     */
    allocateWorktree: z.boolean().optional(),
    /**
     * Optional explicit isolation path. When set, takes precedence over
     * allocateWorktree and is recorded as-is (directory is still ensured).
     */
    worktreePath: z.string().trim().min(1).optional()
  })
  .strict();
export type CreateWorkCardInput = z.infer<typeof CreateWorkCardInputSchema>;

/** Filter for listCards. */
export const ListWorkCardsFilterSchema = z
  .object({
    status: WorkCardStatusSchema.optional()
  })
  .strict();
export type ListWorkCardsFilter = z.infer<typeof ListWorkCardsFilterSchema>;

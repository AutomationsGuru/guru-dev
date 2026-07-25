import { z } from "zod";

import { NeverStuckMoveSchema } from "../selfbuild/resolver.js";

/**
 * A durable resolver decision receipt.
 *
 * When the never-stuck resolver chooses BUILD, ATTACH, or LEARN-REPLICATE
 * (or confirms already-have), this receipt records the decision with its
 * gap, move, evidence, and a next-check timestamp for provisional attaches
 * so the resolver can re-evaluate later.  The receipt is stored under the
 * session or project harness — never silently discarded.
 *
 * "Cannot proceed" is NOT a valid receipt.  Every gap MUST resolve to a
 * stated move with evidence; an empty or invalid move is rejected at the
 * schema level so the resolver can never silently dead-end.
 */
export const DecisionReceiptSchema = z
  .object({
    /** Stable UUID for this receipt. */
    id: z.string().uuid(),
    /** ISO-8601 creation timestamp. */
    createdAt: z.string().datetime(),
    /** The capability gap, in plain words (e.g. "fetch a web page"). */
    gap: z.string().trim().min(3).max(200),
    /** The chosen resolver move. */
    move: NeverStuckMoveSchema,
    /** Human-readable statement of the decision. */
    statement: z.string().trim().min(1),
    /** Why this move was chosen over alternatives. */
    reasons: z.array(z.string().trim().min(1)).min(1),
    /** Concrete next steps. */
    workPlan: z.array(z.string().trim().min(1)),
    /** Probe/registry evidence collected during resolution. */
    evidence: z.array(z.string()),
    /** Whether the gap is still open or has been resolved. */
    status: z.enum(["open", "closed"]).default("open"),
    /**
     * ISO-8601 timestamp for the next re-check.
     * Required for ATTACH moves (provisional — must re-evaluate for native
     * replacement); optional for other moves.
     */
    nextCheckAt: z.string().datetime().optional(),
    /** ISO-8601 timestamp when the decision was closed (if closed). */
    closedAt: z.string().datetime().optional(),
    /** Free-text note recorded when the decision was closed. */
    resolutionNote: z.string().trim().optional()
  })
  .strict();

export type DecisionReceipt = z.infer<typeof DecisionReceiptSchema>;

/** In-memory store of decision receipts.  File persistence is layered above. */
export const DecisionReceiptStoreSchema = z
  .object({
    decisions: z.array(DecisionReceiptSchema)
  })
  .strict();

export type DecisionReceiptStore = z.infer<typeof DecisionReceiptStoreSchema>;

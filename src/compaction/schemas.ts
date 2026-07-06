import { z } from "zod";

/**
 * Compaction engine schemas (Runtime Survival wave, ADR 2026-07-04-compaction-engine).
 *
 * The engine is written against a general TranscriptEntry model so the cut-point
 * invariants (never split a toolCall from its toolResult) hold for the richer
 * transcripts of the coming session-tree wave; guru's flat ChatTurnMessage history
 * adapts into it today.
 */

export const CompactionConfigSchema = z
  .object({
    /** Master switch. false = today's exact legacy behavior (slice window, no compaction). */
    enabled: z.boolean().default(true),
    /** Auto-trigger when context tokens exceed contextWindow − reserveTokens. */
    reserveTokens: z.number().int().positive().default(16_384),
    /** How much recent transcript (estimated tokens) survives a compaction verbatim. */
    keepRecentTokens: z.number().int().positive().default(20_000),
    /** Token budget for the summary completion itself. */
    summaryMaxTokens: z.number().int().positive().default(2_048)
  })
  .strict();
export type CompactionConfig = z.infer<typeof CompactionConfigSchema>;

export const TranscriptEntryKindSchema = z.enum(["system", "user", "assistant", "toolCall", "toolResult"]);
export type TranscriptEntryKind = z.infer<typeof TranscriptEntryKindSchema>;

export const TranscriptEntrySchema = z
  .object({
    /** Stable-within-run id; guru's flat history stamps synthetic e<index> ids. */
    id: z.string().trim().min(1),
    kind: TranscriptEntryKindSchema,
    content: z.string()
  })
  .strict();
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

export const CompactionDetailsSchema = z
  .object({
    readFiles: z.array(z.string()).default([]),
    modifiedFiles: z.array(z.string()).default([])
  })
  .strict();
export type CompactionDetails = z.infer<typeof CompactionDetailsSchema>;

/** The durable record of the latest compaction, persisted on the conversation. */
export const CompactionStateSchema = z
  .object({
    summary: z.string(),
    /** Audit pointer to the first kept entry of the PRE-compaction transcript. */
    firstKeptEntryId: z.string().trim().min(1),
    tokensBefore: z.number().int().nonnegative(),
    compactedAt: z.string().trim().min(1),
    /** How many compactions this conversation has had (iterative summaries). */
    count: z.number().int().positive(),
    /** Cumulative file tracking across all compactions. */
    details: CompactionDetailsSchema
  })
  .strict();
export type CompactionState = z.infer<typeof CompactionStateSchema>;

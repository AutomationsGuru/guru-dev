import type { TranscriptEntry } from "./schemas.js";

/**
 * Token estimation for compaction decisions (ADR 2026-07-04-compaction-engine).
 *
 * Deliberately cheap and deterministic: ~4 chars/token plus a small per-entry
 * overhead for message framing. Used for the cut-point walk and the estimated
 * trigger signal; the REAL provider-reported input tokens remain the primary
 * auto-trigger signal when available.
 */

export type TokenEstimator = (text: string) => number;

/** Per-entry framing overhead (role tags, separators) in estimated tokens. */
export const ENTRY_OVERHEAD_TOKENS = 4;

export const estimateTokens: TokenEstimator = (text) => Math.ceil(text.length / 4);

export function estimateEntryTokens(entry: TranscriptEntry, estimator: TokenEstimator = estimateTokens): number {
  return estimator(entry.content) + ENTRY_OVERHEAD_TOKENS;
}

export function estimateTranscriptTokens(
  entries: readonly TranscriptEntry[],
  estimator: TokenEstimator = estimateTokens
): number {
  let total = 0;
  for (const entry of entries) {
    total += estimateEntryTokens(entry, estimator);
  }
  return total;
}

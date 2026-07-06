import { estimateEntryTokens, estimateTranscriptTokens, type TokenEstimator, estimateTokens } from "./estimate.js";
import type { TranscriptEntry } from "./schemas.js";

/**
 * The cut-point algorithm (ADR 2026-07-04-compaction-engine, binding invariants).
 *
 * Given entries oldest→newest and a keepRecentTokens budget:
 *  1. walk BACK from the newest entry accumulating token estimates; the cut
 *     candidate is the first index whose kept suffix would exceed the budget;
 *  2. the first kept entry must be `user` or `assistant` — NEVER a `toolResult`,
 *     and never positioned so the entry before it is a `toolCall` (a result must
 *     stay with its call);
 *  3. snap FORWARD first (keeps less — stays under budget); if no valid cut
 *     exists forward, snap BACKWARD (validity beats budget, the priority rule);
 *  4. split-turn: a cut landing mid-turn (first kept entry is not `user`) is
 *     reported so the engine can run the dual-summary path;
 *  5. a plan that would summarize nothing (or keep nothing) returns null.
 */

export interface CutPlan {
  /** Index into entries of the first entry that SURVIVES verbatim. */
  readonly firstKeptIndex: number;
  /** True when the cut lands mid-turn (first kept entry is not a user entry). */
  readonly splitTurn: boolean;
  /** Index of the user entry that opened the turn containing the cut (or 0). */
  readonly turnStartIndex: number;
  /** Estimated tokens of the WHOLE transcript before compaction. */
  readonly tokensBefore: number;
  /** Estimated tokens of the region being summarized ([0, firstKeptIndex)). */
  readonly tokensSummarized: number;
}

function isValidCut(entries: readonly TranscriptEntry[], index: number): boolean {
  const entry = entries[index];
  if (!entry) {
    return false;
  }
  if (entry.kind !== "user" && entry.kind !== "assistant") {
    return false;
  }
  const previous = entries[index - 1];
  // Never orphan a toolCall from the toolResult(s) that follow it.
  if (previous && previous.kind === "toolCall") {
    return false;
  }
  return true;
}

/** Nearest user entry at or before `index` — the start of the turn containing it. */
function turnStartFor(entries: readonly TranscriptEntry[], index: number): number {
  for (let i = index; i >= 0; i -= 1) {
    if (entries[i]?.kind === "user") {
      return i;
    }
  }
  return 0;
}

export function findCutPoint(
  entries: readonly TranscriptEntry[],
  keepRecentTokens: number,
  estimator: TokenEstimator = estimateTokens
): CutPlan | null {
  if (entries.length < 2) {
    return null; // nothing to split: a compaction must both summarize and keep.
  }

  // 1. Walk back accumulating until the kept suffix would exceed the budget.
  let kept = 0;
  let candidate = 0; // default: keep everything (no cut)
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry) {
      continue;
    }
    const next = kept + estimateEntryTokens(entry, estimator);
    if (next > keepRecentTokens) {
      candidate = i + 1; // entry i pushed us over → first kept is i+1
      break;
    }
    kept = next;
  }

  if (candidate <= 0) {
    return null; // whole transcript fits in keepRecentTokens — nothing to summarize.
  }

  // Never summarize EVERYTHING: at least the newest entry survives.
  candidate = Math.min(candidate, entries.length - 1);

  // 2+3. Snap to a valid cut: forward first (under budget), backward as fallback.
  let firstKept = -1;
  for (let i = candidate; i < entries.length; i += 1) {
    if (isValidCut(entries, i)) {
      firstKept = i;
      break;
    }
  }
  if (firstKept === -1) {
    for (let i = candidate - 1; i > 0; i -= 1) {
      if (isValidCut(entries, i)) {
        firstKept = i;
        break;
      }
    }
  }
  if (firstKept <= 0) {
    return null; // no valid cut anywhere — leave the transcript alone.
  }

  const firstKeptEntry = entries[firstKept];
  const splitTurn = firstKeptEntry !== undefined && firstKeptEntry.kind !== "user";

  return {
    firstKeptIndex: firstKept,
    splitTurn,
    turnStartIndex: turnStartFor(entries, firstKept),
    tokensBefore: estimateTranscriptTokens(entries, estimator),
    tokensSummarized: estimateTranscriptTokens(entries.slice(0, firstKept), estimator)
  };
}

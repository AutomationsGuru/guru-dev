/**
 * Pure compaction trigger decision policy.
 *
 * Decides whether compaction should be triggered based on message/token counts,
 * with hysteresis (high watermark to trigger, low watermark to release),
 * and respects user cancellation and post-survival re-arming.
 *
 * This module performs ONLY the trigger decision. It does not perform compaction,
 * does not mutate session state, and does not manage survival/cancellation
 * lifecycle (those are preserved in the caller).
 */

export type CompactionDecision = {
  shouldTrigger: boolean;
  reason: string;
};

export interface CompactionContext {
  /** Current number of messages in the session. */
  messageCount: number;
  /** Current total token usage. */
  totalTokens: number;

  /** High watermark for messages (breach => trigger). */
  messageHighWatermark: number;
  /** Low watermark for messages (drop below => release, if this was the trigger). */
  messageLowWatermark: number;
  /** High watermark for tokens (breach => trigger). */
  tokenHighWatermark: number;
  /** Low watermark for tokens. */
  tokenLowWatermark: number;

  /** True if user has explicitly cancelled compaction for this session. */
  compactionCancelled: boolean;
  /** True if a compaction has run and its result survived (re-arm only on next high breach). */
  compactionSurvived: boolean;

  /** Previous decision from last evaluation (enables latching for hysteresis). */
  previousShouldTrigger?: boolean;
}

/**
 * Returns whether compaction should trigger now, with a human-readable reason.
 *
 * Rules (in priority order):
 * 1. If cancelled => never trigger.
 * 2. If survived => only trigger on a fresh high-watermark breach (re-arming).
 * 3. Hysteresis: once triggered, remain triggered until counts drop below ALL low watermarks
 *    (or cancelled). Trigger initially on any high breach.
 */
export function shouldTriggerCompaction(context: CompactionContext): CompactionDecision {
  const {
    messageCount,
    totalTokens,
    messageHighWatermark,
    messageLowWatermark,
    tokenHighWatermark,
    tokenLowWatermark,
    compactionCancelled,
    compactionSurvived,
    previousShouldTrigger = false,
  } = context;

  if (compactionCancelled) {
    return {
      shouldTrigger: false,
      reason: 'Compaction cancelled by user',
    };
  }

  const aboveMessageHigh = messageCount > messageHighWatermark;
  const aboveTokenHigh = totalTokens > tokenHighWatermark;
  const aboveAnyHigh = aboveMessageHigh || aboveTokenHigh;

  const belowMessageLow = messageCount < messageLowWatermark;
  const belowTokenLow = totalTokens < tokenLowWatermark;
  const belowAllLows = belowMessageLow && belowTokenLow;

  if (compactionSurvived) {
    // Re-arm only on fresh high breach after survival
    if (aboveAnyHigh) {
      return {
        shouldTrigger: true,
        reason: 'High watermark breached after previous compaction survived',
      };
    }
    return {
      shouldTrigger: false,
      reason: 'Awaiting next high watermark breach after survival',
    };
  }

  // Normal hysteresis: trigger on high breach, or stay latched if previously triggered and not below lows
  if (aboveAnyHigh || (previousShouldTrigger && !belowAllLows)) {
    const reason = aboveAnyHigh
      ? 'High watermark breached'
      : 'Hysteresis: still above low watermark(s)';
    return {
      shouldTrigger: true,
      reason,
    };
  }

  return {
    shouldTrigger: false,
    reason: 'Below low watermarks',
  };
}

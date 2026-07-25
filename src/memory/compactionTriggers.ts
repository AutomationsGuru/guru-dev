/**
 * Compaction triggers (R-MA-TRIGGERS, F245) — pure count-based predicates that
 * decide WHEN a compaction pipeline (F244) should run, over plain conversation
 * stats. Complements the token-based `shouldCompact` in `src/compaction/engine.ts`:
 * this module fires on message/turn/group counts, the engine fires on token
 * budget. No I/O, no wall clock, no zod — pure functions, like `policy.ts`.
 *
 * "Group" follows the MAF model: one contiguous run of entries belonging to the
 * same conversational unit (e.g. an assistant turn plus its tool calls/results).
 * The caller computes the counts; this module only compares them.
 */

export interface ConversationStats {
  /** Total transcript entries (any kind). */
  readonly messages: number;
  /** Completed operator↔assistant exchanges. */
  readonly turns: number;
  /** Contiguous same-unit runs of entries (MAF sliding-window unit). */
  readonly groups: number;
}

/**
 * Numeric trigger thresholds. An undefined dimension never fires, so a caller
 * can configure exactly the dimensions it cares about. "Exceed" is strict:
 * a count equal to its threshold does not fire.
 */
export interface CompactionTriggers {
  readonly maxMessages?: number;
  readonly maxTurns?: number;
  readonly maxGroups?: number;
}

/** Fire when the transcript holds strictly more than `max` entries. */
export function messagesExceed(max: number): (stats: ConversationStats) => boolean {
  return (stats) => stats.messages > max;
}

/** Fire when the session has run strictly more than `max` exchanges. */
export function turnsExceed(max: number): (stats: ConversationStats) => boolean {
  return (stats) => stats.turns > max;
}

/** Fire when the transcript holds strictly more than `max` groups. */
export function groupsExceed(max: number): (stats: ConversationStats) => boolean {
  return (stats) => stats.groups > max;
}

/** Any configured trigger firing means it is time to compact. */
export function shouldCompact(stats: ConversationStats, triggers: CompactionTriggers): boolean {
  if (triggers.maxMessages !== undefined && messagesExceed(triggers.maxMessages)(stats)) {
    return true;
  }
  if (triggers.maxTurns !== undefined && turnsExceed(triggers.maxTurns)(stats)) {
    return true;
  }
  if (triggers.maxGroups !== undefined && groupsExceed(triggers.maxGroups)(stats)) {
    return true;
  }
  return false;
}

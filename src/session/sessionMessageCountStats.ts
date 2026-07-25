import type { ChatTurnMessage } from "../model/directChat.js";

/**
 * Session message-count stats (IDEA-F257-MSG-STATS-01, R-MA-MSG-STATS).
 *
 * A pure, dependency-free reduction over flat chat history that yields the
 * three counters compaction triggers reason about:
 *
 * - `messages` — transcript messages excluding a leading system head (the
 *   protected system prompt is not part of the compactable transcript, matching
 *   `historyToCompactionEntries`).
 * - `turns` — user messages; each user message opens one agent exchange.
 * - `groups` — contiguous runs of user/assistant messages. A mid-history system
 *   message (steering injection, compaction summary) breaks the run and starts
 *   a new group, so triggers can see how fragmented the transcript has become.
 */
export interface SessionMessageCountStats {
  readonly messages: number;
  readonly turns: number;
  readonly groups: number;
}

export function sessionMessageCountStats(history: readonly ChatTurnMessage[]): SessionMessageCountStats {
  let messages = 0;
  let turns = 0;
  let groups = 0;
  let inGroup = false;

  for (const message of history) {
    if (message.role === "system") {
      // A system message (head, steering, or summary) closes any open group
      // and is not itself a transcript message for counting purposes.
      inGroup = false;
      continue;
    }
    messages += 1;
    if (message.role === "user") {
      turns += 1;
    }
    if (!inGroup) {
      groups += 1;
      inGroup = true;
    }
  }

  return { messages, turns, groups };
}

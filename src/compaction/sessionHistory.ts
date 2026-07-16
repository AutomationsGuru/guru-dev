import type { ChatTurnMessage } from "../model/directChat.js";

import { SUMMARY_ENTRY_PREFIX } from "./engine.js";
import { estimateTranscriptTokens } from "./estimate.js";
import type { CompactionConfig, TranscriptEntry } from "./schemas.js";

/** The optional protected system head plus the transcript region the engine may fold. */
export interface CompactableHistory {
  readonly head?: ChatTurnMessage;
  readonly entries: readonly TranscriptEntry[];
  readonly previousSummary: string | undefined;
}

function isCompactionSummary(message: ChatTurnMessage): boolean {
  return message.role === "system" && message.content.startsWith(SUMMARY_ENTRY_PREFIX);
}

/** Adapt either TUI system-headed history or user-first AgentSession history. */
export function historyToCompactionEntries(history: readonly ChatTurnMessage[]): CompactableHistory {
  const first = history[0];
  const head = first?.role === "system" && !isCompactionSummary(first) ? first : undefined;
  const entries: TranscriptEntry[] = [];
  let previousSummary: string | undefined;

  for (let index = head === undefined ? 0 : 1; index < history.length; index += 1) {
    const message = history[index];
    if (!message) {
      continue;
    }
    if (isCompactionSummary(message)) {
      const newline = message.content.indexOf("\n");
      previousSummary = newline === -1 ? "" : message.content.slice(newline + 1);
      continue;
    }
    entries.push({ id: `e${index}`, kind: message.role, content: message.content });
  }

  return {
    ...(head === undefined ? {} : { head }),
    entries,
    previousSummary
  };
}

/** Rebuild flat chat history while preserving an actual system head when one exists. */
export function rebuildHistoryAfterCompaction(
  head: ChatTurnMessage | undefined,
  summaryEntry: TranscriptEntry,
  keptEntries: readonly TranscriptEntry[]
): ChatTurnMessage[] {
  const kept: ChatTurnMessage[] = [];
  for (const entry of keptEntries) {
    if (entry.kind === "system" || entry.kind === "user" || entry.kind === "assistant") {
      kept.push({ role: entry.kind, content: entry.content });
    }
  }

  return [
    ...(head === undefined ? [] : [head]),
    { role: "system", content: summaryEntry.content },
    ...kept
  ];
}

export function estimateChatHistoryTokens(history: readonly ChatTurnMessage[]): number {
  return estimateTranscriptTokens(
    history.map((message, index) => ({ id: `e${index}`, kind: message.role, content: message.content }))
  );
}

/** Clamp an oversized keep budget so compaction can land below its trigger. */
export function effectiveKeepRecentTokens(config: CompactionConfig, contextWindowTokens: number): number {
  const threshold = contextWindowTokens - config.reserveTokens;
  if (threshold <= 0) {
    return config.keepRecentTokens;
  }
  return config.keepRecentTokens >= threshold ? Math.max(1_000, Math.floor(threshold / 2)) : config.keepRecentTokens;
}

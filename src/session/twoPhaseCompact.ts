import type { ChatTurnMessage } from "../model/directChat.js";
import { SUMMARY_ENTRY_PREFIX } from "../compaction/engine.js";
import type { TranscriptEntry, TranscriptEntryKind } from "../compaction/schemas.js";

/** Re-exported so callers/tests recognize compaction-summary entries by the canonical marker. */
export { SUMMARY_ENTRY_PREFIX };

/**
 * Two-phase context compact (IDEA-F330-2PHASE-01).
 *
 * A standalone, PURE compaction helper that splits context reduction into two
 * independently testable phases, so it can run without a model in unit tests:
 *
 *   phase1 — prune/truncate oversized tool results in place (never split a
 *            toolCall from its toolResult, never drop a message).
 *   phase2 — attach a precomputed summary as a compaction-summary system entry
 *            at the head of the history (replacing any prior summary).
 *
 * It is written against the compaction engine's `TranscriptEntry` model so the
 * tool-pair invariants hold for richer transcripts, and ships thin adapters for
 * guru's flat `ChatTurnMessage[]` history. Pure orchestration: no I/O, no wall
 * clock, no network, no model. The summary itself is supplied by the caller —
 * in tests it is fixture-injected; in the live harness it is produced by the
 * compaction summarizer lane (`src/compaction/engine.ts`).
 */

/** Phase 1 options. */
export interface Phase1PruneOptions {
  /** A tool result at or above this many characters is truncated. */
  readonly maxToolResultChars: number;
  /** When set, prune only entries at index >= pruneFromIndex (defaults to 0). */
  readonly pruneFromIndex?: number;
  /** Characters of the head preserved on a truncated result (defaults to a quarter of the ceiling). */
  readonly keepHeadChars?: number;
  /** Characters of the tail preserved on a truncated result (defaults to a quarter of the ceiling). */
  readonly keepTailChars?: number;
}

/** Phase 1 result returned by {@link phase1PruneToolResultsReported}. */
export interface Phase1PruneReport {
  readonly entries: TranscriptEntry[];
  readonly prunedCount: number;
}

const ELIDED_MARKER = "[… elided";

/** Build the truncation marker with the elided char count (mirrors engine style). */
function elisionMarker(elided: number): string {
  return `${ELIDED_MARKER} ${elided} chars …]`;
}

/**
 * Phase 1 — truncate oversized tool results in place. Pure, non-mutating.
 *
 * Invariants:
 *  - never drops a message (length is preserved);
 *  - never reorders, so a toolCall stays immediately before its toolResult;
 *  - leaves non-toolResult entries byte-identical;
 *  - returns a fresh array (the input is untouched).
 *
 * Use {@link phase1PruneToolResultsReported} when you also need the prune count.
 */
export function phase1PruneToolResults(entries: readonly TranscriptEntry[], options: Phase1PruneOptions): TranscriptEntry[] {
  return phase1PruneWithReport(entries, options).entries;
}

/** Same as {@link phase1PruneToolResults} but also returns the prune count. */
export function phase1PruneToolResultsReported(
  entries: readonly TranscriptEntry[],
  options: Phase1PruneOptions
): Phase1PruneReport {
  return phase1PruneWithReport(entries, options);
}

function phase1PruneWithReport(entries: readonly TranscriptEntry[], options: Phase1PruneOptions): Phase1PruneReport {
  const ceiling = options.maxToolResultChars;
  const fromIndex = options.pruneFromIndex ?? 0;
  const defaultKeep = Math.max(0, Math.floor(ceiling / 4));
  const keepHead = options.keepHeadChars ?? defaultKeep;
  const keepTail = options.keepTailChars ?? defaultKeep;

  let prunedCount = 0;
  const out: TranscriptEntry[] = entries.map((entry, index) => {
    if (entry.kind !== "toolResult" || index < fromIndex) {
      return entry;
    }
    if (entry.content.length <= ceiling) {
      return entry;
    }
    prunedCount += 1;
    const total = keepHead + keepTail;
    // keepHead + keepTail would itself exceed the ceiling — collapse to a pure head slice.
    if (total >= ceiling || total <= 0) {
      const headSlice = entry.content.slice(0, Math.max(0, ceiling - elisionMarker(0).length - 1));
      const elided = entry.content.length - headSlice.length;
      return { ...entry, content: `${headSlice}\n${elisionMarker(elided)}` };
    }
    const head = entry.content.slice(0, keepHead);
    const tail = entry.content.slice(entry.content.length - keepTail);
    const elided = entry.content.length - (head.length + tail.length);
    return { ...entry, content: `${head}\n${elisionMarker(elided)}\n${tail}` };
  });

  return { entries: out, prunedCount };
}

/**
 * Phase 2 — attach a precomputed summary to a flat chat history as a
 * compaction-summary system entry. Pure, non-mutating.
 *
 *  - if the first message is a non-summary system head, the summary is inserted
 *    immediately after it (preserving the protected system prompt);
 *  - a prior compaction summary is REPLACED, never stacked (one summary at a time);
 *  - otherwise the summary becomes the new first message.
 */
export function phase2AttachSummary(messages: readonly ChatTurnMessage[], summary: string): ChatTurnMessage[] {
  const trimmed = summary.trim();
  const summaryMessage: ChatTurnMessage = { role: "system", content: renderSummaryEntry(trimmed) };
  if (trimmed.length === 0) {
    // An empty summary would silently destroy folded context — refuse rather than
    // splice a no-op summary (mirrors the engine's empty-summary guard).
    return messages.slice();
  }

  const first = messages[0];
  const hasProtectedHead = first?.role === "system" && !first.content.startsWith(SUMMARY_ENTRY_PREFIX);

  const withoutPriorSummary = messages.filter((message) => !message.content.startsWith(SUMMARY_ENTRY_PREFIX));

  if (hasProtectedHead && first) {
    return [first, summaryMessage, ...withoutPriorSummary.slice(1)];
  }
  return [summaryMessage, ...withoutPriorSummary];
}

/** Render the summary into the canonical compaction-summary system content. */
function renderSummaryEntry(summary: string): string {
  return `${SUMMARY_ENTRY_PREFIX}\n${summary}`;
}

/** End-to-end: run phase1 on the transcript, then phase2 to attach the summary. */
export function twoPhaseCompact(
  messages: readonly ChatTurnMessage[],
  summary: string,
  options: Phase1PruneOptions
): ChatTurnMessage[] {
  const transcript = chatHistoryToTranscript(messages);
  const pruned = phase1PruneToolResults(transcript, options);
  const reduced = transcriptToChatHistory(pruned);
  return phase2AttachSummary(reduced, summary);
}

/** Adapt flat chat history into the engine's transcript-entry model. */
export function chatHistoryToTranscript(messages: readonly ChatTurnMessage[]): TranscriptEntry[] {
  return messages.map((message, index) => ({
    id: `tpc${index}`,
    kind: message.role as TranscriptEntryKind,
    content: message.content
  }));
}

/** Project transcript entries back onto flat chat history (drops tool* kinds the flat model can't express). */
export function transcriptToChatHistory(entries: readonly TranscriptEntry[]): ChatTurnMessage[] {
  const out: ChatTurnMessage[] = [];
  for (const entry of entries) {
    if (entry.kind === "system" || entry.kind === "user" || entry.kind === "assistant") {
      out.push({ role: entry.kind, content: entry.content });
    }
  }
  return out;
}

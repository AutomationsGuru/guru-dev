import { scrubSecretValues } from "../safety/secretSafety.js";

import { findCutPoint, type CutPlan } from "./cutPoint.js";
import { estimateTokens, type TokenEstimator } from "./estimate.js";
import {
  CompactionStateSchema,
  type CompactionConfig,
  type CompactionDetails,
  type CompactionState,
  type TranscriptEntry
} from "./schemas.js";

/**
 * The compaction engine (ADR 2026-07-04-compaction-engine): plan a tool-pair-safe
 * cut, summarize the older region through an INJECTED summarizer (the REPL wires
 * the connected route; tests wire a fake), track files cumulatively, scrub the
 * summary, and emit the durable CompactionState. Pure orchestration — no I/O, no
 * wall clock, no network in this module.
 */

export interface SummarizeRequest {
  /** The transcript region to fold, rendered as role-tagged lines (pre-capped). */
  readonly transcriptBlock: string;
  /** The previous compaction summary — iterative context (the summary algorithm). */
  readonly previousSummary?: string;
  /** Operator focus instructions from `/compact <instructions>`. */
  readonly customInstructions?: string;
  /** Which region this is: whole history, or the split-turn prefix. */
  readonly label: "history" | "turn-prefix";
  readonly maxTokens: number;
}
export type Summarizer = (request: SummarizeRequest) => Promise<string>;

/** Seam for the future session_before_compact extension event (may cancel). */
export type BeforeCompactHook = (preparation: {
  readonly tokensBefore: number;
  readonly firstKeptEntryId: string;
  readonly reason: "manual" | "threshold";
}) => { readonly cancel?: boolean } | undefined;
/** Seam for the future session_compact extension event (notification). */
export type CompactHook = (state: CompactionState) => void;

export interface CompactionRunOptions {
  readonly entries: readonly TranscriptEntry[];
  readonly config: CompactionConfig;
  readonly summarize: Summarizer;
  readonly estimator?: TokenEstimator;
  readonly now: () => Date;
  readonly reason: "manual" | "threshold";
  readonly previousSummary?: string;
  readonly previousDetails?: CompactionDetails;
  readonly previousCount?: number;
  readonly customInstructions?: string;
  /** File ops tracked by the caller at its executeTool seam (cumulative input). */
  readonly sessionFiles?: CompactionDetails;
  readonly beforeCompact?: BeforeCompactHook;
  readonly onCompact?: CompactHook;
}

export interface CompactionRunResult {
  readonly state: CompactionState;
  /** Entries that survive verbatim (from firstKeptIndex to the end). */
  readonly keptEntries: readonly TranscriptEntry[];
  /** The summary rendered as a system transcript entry, ready to splice in. */
  readonly summaryEntry: TranscriptEntry;
  readonly plan: CutPlan;
}

/** The auto-trigger inequality (ADR): EITHER real or estimated signal crossing. */
export function shouldCompact(input: {
  readonly config: CompactionConfig;
  readonly contextWindowTokens: number | undefined;
  readonly lastInputTokens: number;
  readonly estimatedTokens: number;
}): boolean {
  if (!input.config.enabled || input.contextWindowTokens === undefined) {
    return false;
  }
  const threshold = input.contextWindowTokens - input.config.reserveTokens;
  if (threshold <= 0) {
    return false; // degenerate window — never busy-loop compaction.
  }
  return input.lastInputTokens > threshold || input.estimatedTokens > threshold;
}

/** Cap the block sent to the summarizer so summarization itself can't overflow. */
export const MAX_SUMMARY_BLOCK_CHARS = 240_000;

export function renderTranscriptBlock(entries: readonly TranscriptEntry[]): string {
  const lines = entries.map((entry) => `${entry.kind}: ${entry.content}`);
  // A RESOLVED credential value never goes to the summary lane either — scrub the
  // input block, not just the output summary (CodeRabbit 2026-07-04, defense in depth).
  const block = scrubSecretValues(lines.join("\n"));
  if (block.length <= MAX_SUMMARY_BLOCK_CHARS) {
    return block;
  }
  const half = Math.floor(MAX_SUMMARY_BLOCK_CHARS / 2);
  return `${block.slice(0, half)}\n[… ${block.length - MAX_SUMMARY_BLOCK_CHARS} chars elided …]\n${block.slice(-half)}`;
}

/** Extract read/modified file paths from toolCall entries (richer transcripts). */
export function extractFilesFromEntries(entries: readonly TranscriptEntry[]): CompactionDetails {
  const readFiles = new Set<string>();
  const modifiedFiles = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "toolCall") {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(entry.content);
      if (typeof parsed !== "object" || parsed === null) {
        continue;
      }
      const call = parsed as { toolId?: unknown; input?: unknown };
      const input = typeof call.input === "object" && call.input !== null ? (call.input as { path?: unknown }) : undefined;
      if (typeof call.toolId !== "string" || typeof input?.path !== "string") {
        continue;
      }
      if (call.toolId === "read") {
        readFiles.add(input.path);
      } else if (call.toolId === "write" || call.toolId === "edit") {
        modifiedFiles.add(input.path);
      }
    } catch {
      // Non-JSON toolCall content: nothing to extract.
    }
  }
  return { readFiles: [...readFiles].sort(), modifiedFiles: [...modifiedFiles].sort() };
}

function mergeDetails(...sources: readonly (CompactionDetails | undefined)[]): CompactionDetails {
  const readFiles = new Set<string>();
  const modifiedFiles = new Set<string>();
  for (const source of sources) {
    for (const file of source?.readFiles ?? []) {
      readFiles.add(file);
    }
    for (const file of source?.modifiedFiles ?? []) {
      modifiedFiles.add(file);
    }
  }
  return { readFiles: [...readFiles].sort(), modifiedFiles: [...modifiedFiles].sort() };
}

/** Marker prefix so the REPL can recognize (and later replace) the summary entry. */
export const SUMMARY_ENTRY_PREFIX = "[compaction summary]";

export async function runCompaction(
  options: CompactionRunOptions
): Promise<CompactionRunResult | { readonly cancelled: true } | null> {
  const estimator = options.estimator ?? estimateTokens;
  const plan = findCutPoint(options.entries, options.config.keepRecentTokens, estimator);
  if (!plan) {
    return null;
  }

  const firstKept = options.entries[plan.firstKeptIndex];
  if (!firstKept) {
    return null;
  }

  const hookDecision = options.beforeCompact?.({
    tokensBefore: plan.tokensBefore,
    firstKeptEntryId: firstKept.id,
    reason: options.reason
  });
  if (hookDecision?.cancel === true) {
    return { cancelled: true };
  }

  const shared = {
    ...(options.previousSummary !== undefined ? { previousSummary: options.previousSummary } : {}),
    ...(options.customInstructions !== undefined ? { customInstructions: options.customInstructions } : {}),
    maxTokens: options.config.summaryMaxTokens
  };

  let rawSummary: string;
  if (plan.splitTurn && plan.turnStartIndex > 0) {
    // The dual-summary path: history before the split turn + the turn prefix.
    const historyBlock = renderTranscriptBlock(options.entries.slice(0, plan.turnStartIndex));
    const prefixBlock = renderTranscriptBlock(options.entries.slice(plan.turnStartIndex, plan.firstKeptIndex));
    const [historySummary, prefixSummary] = await Promise.all([
      options.summarize({ transcriptBlock: historyBlock, label: "history", ...shared }),
      options.summarize({ transcriptBlock: prefixBlock, label: "turn-prefix", ...shared })
    ]);
    rawSummary = `${historySummary.trim()}\n\n[current turn so far]\n${prefixSummary.trim()}`;
  } else {
    const block = renderTranscriptBlock(options.entries.slice(0, plan.firstKeptIndex));
    rawSummary = (await options.summarize({ transcriptBlock: block, label: "history", ...shared })).trim();
  }

  // A resolved credential value must never survive into a summary (engine-level
  // scrub; the conversation store scrubs again on save — defense in depth).
  const summary = scrubSecretValues(rawSummary);

  // An empty summary would silently DESTROY the folded history (adversarial
  // review 2026-07-04): empty completions are a real HTTP-200 outcome of the
  // summary lane. Fail the compaction instead — the caller degrades, data survives.
  if (summary.trim().length === 0) {
    throw new Error("The summarizer returned an empty summary — compaction aborted, history untouched.");
  }

  const details = mergeDetails(
    options.previousDetails,
    options.sessionFiles,
    extractFilesFromEntries(options.entries.slice(0, plan.firstKeptIndex))
  );

  const state = CompactionStateSchema.parse({
    summary,
    firstKeptEntryId: firstKept.id,
    tokensBefore: plan.tokensBefore,
    compactedAt: options.now().toISOString(),
    count: (options.previousCount ?? 0) + 1,
    details
  });

  const summaryEntry: TranscriptEntry = {
    id: `summary-${state.count}`,
    kind: "system",
    content: `${SUMMARY_ENTRY_PREFIX} (${state.count} compaction${state.count === 1 ? "" : "s"}; ~${plan.tokensSummarized} tok folded)\n${summary}`
  };

  options.onCompact?.(state);

  return { state, keptEntries: options.entries.slice(plan.firstKeptIndex), summaryEntry, plan };
}

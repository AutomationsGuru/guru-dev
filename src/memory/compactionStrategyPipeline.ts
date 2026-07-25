import { estimateEntryTokens, estimateTokens, type TokenEstimator } from "../compaction/estimate.js";
import type { TranscriptEntry } from "../compaction/schemas.js";

/**
 * Compaction strategy pipeline (IDEA-F244-COMPACT-PIPE-01).
 *
 * An ordered list of pure reduction strategies (tool-result shrink, sliding
 * window, truncate, …) applied to a transcript until it fits a token budget or
 * the strategies are exhausted. Strategies never mutate their input; each
 * receives the output of the previous one. The pipeline is pure orchestration:
 * no I/O, no wall clock, no network — the summarizing engine lives in
 * src/compaction/engine.ts and composes on top of this list-reduction seam.
 */

/** One ordered reduction step. Returns the same or a smaller transcript. */
export type CompactionStrategy = (
  messages: readonly TranscriptEntry[],
  budgetTokens: number,
  estimator: TokenEstimator
) => readonly TranscriptEntry[];

export interface CompactionPipelineRun {
  /** The transcript after the pipeline (input reference when already under budget). */
  readonly messages: readonly TranscriptEntry[];
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  /** True when tokensAfter <= budgetTokens. */
  readonly withinBudget: boolean;
  /** Name/index of the strategy that first brought the list under budget, if any. */
  readonly stoppedAtStrategy: number | undefined;
}

export interface CompactionStrategyPipelineOptions {
  readonly strategies: readonly CompactionStrategy[];
  readonly estimator?: TokenEstimator;
}

export function measureTranscriptTokens(
  messages: readonly TranscriptEntry[],
  estimator: TokenEstimator
): number {
  let total = 0;
  for (const message of messages) {
    total += estimateEntryTokens(message, estimator);
  }
  return total;
}

/**
 * Run the strategies in order. A strategy is only invoked while the transcript
 * is still over budget; the pipeline stops as soon as the list fits. An empty
 * pipeline (or an already-fitting transcript) is a no-op.
 */
export function runCompactionStrategyPipeline(
  messages: readonly TranscriptEntry[],
  budgetTokens: number,
  options: CompactionStrategyPipelineOptions
): CompactionPipelineRun {
  const estimator = options.estimator ?? estimateTokens;
  const tokensBefore = measureTranscriptTokens(messages, estimator);

  if (tokensBefore <= budgetTokens) {
    return {
      messages,
      tokensBefore,
      tokensAfter: tokensBefore,
      withinBudget: true,
      stoppedAtStrategy: undefined
    };
  }

  let current = messages;
  let tokensAfter = tokensBefore;
  let stoppedAtStrategy: number | undefined;

  for (let index = 0; index < options.strategies.length; index += 1) {
    const strategy = options.strategies[index];
    if (!strategy) {
      continue;
    }
    current = strategy(current, budgetTokens, estimator);
    tokensAfter = measureTranscriptTokens(current, estimator);
    if (tokensAfter <= budgetTokens) {
      stoppedAtStrategy = index;
      break;
    }
  }

  return {
    messages: current,
    tokensBefore,
    tokensAfter,
    withinBudget: tokensAfter <= budgetTokens,
    stoppedAtStrategy
  };
}

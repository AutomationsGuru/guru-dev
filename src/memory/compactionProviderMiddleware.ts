/**
 * Compaction provider middleware (IDEA-F256): the seam between the history
 * provider (F251, `src/session/inMemoryHistoryProvider.ts`) and the compaction
 * strategy pipeline (F244, `src/memory/compactionStrategyPipeline.ts`).
 *
 * `beforeModel` runs BEFORE a model call: it estimates the provider's token
 * load, fires the compaction pipeline only when the single `tokens > budget`
 * trigger trips, and writes the shrunk list back through the provider. The
 * sibling modules don't exist at this base SHA, so their contracts are
 * declared here and INJECTED — F244/F251 can be wired in later without
 * editing this file. Pure orchestration, matching the compaction engine
 * style: no I/O, no wall clock, no network.
 */

/** Minimal history-provider contract (aligns with the F251 InMemoryHistoryProvider). */
export interface HistoryProvider {
  list(): readonly string[];
  replaceAll(messages: readonly string[]): void;
}

/** One compaction step: shrink the message list toward the token budget. */
export type CompactionPipeline = (messages: readonly string[], tokenBudget: number) => readonly string[];

/** Token estimator; defaults to a chars/4 heuristic (same heuristic family as src/compaction/estimate.ts). */
export type TokenEstimator = (messages: readonly string[]) => number;

export interface CompactionMiddlewareOptions {
  readonly provider: HistoryProvider;
  readonly pipeline: CompactionPipeline;
  readonly tokenBudget: number;
  readonly estimator?: TokenEstimator;
}

export type BeforeModelResult =
  | { readonly compacted: true; readonly messages: readonly string[]; readonly tokensBefore: number; readonly tokensAfter: number }
  | { readonly compacted: false; readonly messages: readonly string[]; readonly tokensBefore: number };

/**
 * Default estimator: chars/4 rounded up per message, then summed. Per-message
 * rounding (not sum-then-round) keeps short messages from vanishing into a
 * large-message average; empty messages cost nothing.
 */
export const estimateHistoryTokens: TokenEstimator = (messages) => {
  let total = 0;
  for (const message of messages) {
    total += message.length === 0 ? 0 : Math.ceil(message.length / 4);
  }
  return total;
};

export function beforeModel(options: CompactionMiddlewareOptions): BeforeModelResult {
  const estimator = options.estimator ?? estimateHistoryTokens;
  const messages = options.provider.list();
  // Estimate FIRST — the trigger is exactly this one inequality, nothing else.
  const tokensBefore = estimator(messages);
  if (tokensBefore <= options.tokenBudget) {
    return { compacted: false, messages, tokensBefore };
  }

  const compacted = options.pipeline(messages, options.tokenBudget);
  // A pipeline that can't shrink further returns its input; writing that back
  // would thrash the provider (and any persistence behind it) for no gain.
  if (isSameList(compacted, messages)) {
    return { compacted: false, messages, tokensBefore };
  }

  options.provider.replaceAll(compacted);
  // Read back from the provider so the result reflects what a model call will
  // actually see, not what the pipeline claimed to write.
  const after = options.provider.list();
  return { compacted: true, messages: after, tokensBefore, tokensAfter: estimator(after) };
}

function isSameList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((item, index) => item === b[index]);
}

import {
  type PreCompactConfig,
  type PreCompactContext,
  type PreCompactDecision,
  type PreCompactHook,
  type PreCompactReceipt
} from "./preCompactTypes.js";

/**
 * Pre-compact gate.
 *
 * Evaluates a list of synchronous pre-compact hooks in order. The first hook
 * that returns a block stops the walk. If every hook allows (or the list is
 * empty), compact proceeds.
 *
 * The gate is deliberately not the place for async checks, locks, or I/O.
 * It records what was decided so the caller can surface an honest receipt
 * without claiming the history is already saved.
 */

export interface EvaluatePreCompactOptions {
  /** Configuration supplies an ordered hook list; omitted config allows compact. */
  readonly config?: PreCompactConfig;
  readonly context: PreCompactContext;
  readonly checkedAt: string;
}

export interface EvaluatePreCompactResult {
  readonly decision: PreCompactDecision;
  readonly receipt: PreCompactReceipt;
}

/**
 * Evaluate all pre-compact hooks.
 *
 * Stops at the first block. Runs no hook more than once per call. Does not
 * catch hook errors; a throwing hook fails the compaction attempt loudly,
 * which keeps the gate fail-safe (history untouched while the caller handles
 * the error).
 */
export function evaluatePreCompact(
  options: EvaluatePreCompactOptions
): EvaluatePreCompactResult {
  const hooks = options.config?.hooks ?? [];
  const blockingHooks: string[] = [];

  for (const hook of hooks) {
    const decision = hook(options.context);
    if (decision.action === "block") {
      blockingHooks.push(decision.blockReason.category);
      return {
        decision,
        receipt: {
          decision,
          checkedAt: options.checkedAt,
          blockingHooks
        }
      };
    }
  }

  const decision: PreCompactDecision = { action: "allow" };
  return {
    decision,
    receipt: {
      decision,
      checkedAt: options.checkedAt,
      blockingHooks
    }
  };
}

/** Convenience factory for a hook that blocks when a predicate is true. */
export function blockWhen(
  category: string,
  predicate: (context: PreCompactContext) => boolean
): PreCompactHook {
  return (context) => {
    if (predicate(context)) {
      return {
        action: "block",
        blockReason: {
          category,
          message: `Pre-compact gate blocked compaction (category: ${category}).`
        }
      };
    }
    return { action: "allow" };
  };
}

/** Convenience factory for a hook that allows only when a predicate is true. */
export function allowOnlyWhen(
  category: string,
  predicate: (context: PreCompactContext) => boolean
): PreCompactHook {
  return blockWhen(category, (context) => !predicate(context));
}

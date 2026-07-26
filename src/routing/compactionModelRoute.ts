import type { ModelSlots } from './modelSlots';
import type { CompactionRequest } from '../types';

/**
 * Returns true if the current token count exceeds the budget,
 * indicating compaction is needed.
 */
export function needsCompact(tokenCount: number, budget: number): boolean {
  return tokenCount > budget;
}

/**
 * Resolves the model to use for compaction.
 * Prefers the dedicated `compact` slot, falls back to `normal`.
 */
export function resolveCompactModel(slots: ModelSlots): string | undefined {
  return slots.compact ?? slots.normal;
}

/**
 * Resolves a CompactionRequest when history exceeds budget.
 * Uses resolveCompactModel for the model binding (compact preferred, normal fallback).
 * Returns null if no compaction needed.
 */
export function resolveCompactionRequest(
  tokenCount: number,
  budget: number,
  slots: ModelSlots
): CompactionRequest | null {
  if (!needsCompact(tokenCount, budget)) {
    return null;
  }

  const model = resolveCompactModel(slots);
  if (!model) {
    // No model available; cannot produce valid request. Return null to avoid invalid state.
    return null;
  }

  return {
    reason: 'history_exceeds_budget',
    tokenCount,
    budget,
    model,
  };
}

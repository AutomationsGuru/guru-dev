import type { Mandate, SteeringConfig } from '../types';

/**
 * steeringInclusionFilter
 * Pure, deterministic, stable filter for steering-aware mandate selection.
 * - If steering disabled or no mandates → []
 * - Filter to mandates whose steeringTags intersect steering.tags (if tags provided)
 * - Sort: explicit first, then priority desc, confidence desc, recency desc (stable)
 * - Slice to steering.max
 */
export function steeringInclusionFilter(
  mandates: Mandate[],
  steering: SteeringConfig
): Mandate[] {
  if (!steering?.enabled || !mandates || mandates.length === 0) {
    return [];
  }

  const steerTags = steering.tags ?? [];
  let filtered = mandates;

  if (steerTags.length > 0) {
    filtered = mandates.filter((m) => {
      const mTags = m.steeringTags ?? [];
      return mTags.some((t) => steerTags.includes(t));
    });
  }

  const sorted = [...filtered].sort((a, b) => {
    // explicit matches first
    const aExp = a.isExplicitMatch ? 1 : 0;
    const bExp = b.isExplicitMatch ? 1 : 0;
    if (aExp !== bExp) return bExp - aExp;

    // higher priority first
    if ((a.priority ?? 0) !== (b.priority ?? 0)) {
      return (b.priority ?? 0) - (a.priority ?? 0);
    }

    // higher confidence first
    if ((a.confidence ?? 0) !== (b.confidence ?? 0)) {
      return (b.confidence ?? 0) - (a.confidence ?? 0);
    }

    // newer lastUpdated first (recency)
    const aTime = a.lastUpdated ? new Date(a.lastUpdated).getTime() : 0;
    const bTime = b.lastUpdated ? new Date(b.lastUpdated).getTime() : 0;
    if (aTime !== bTime) return bTime - aTime;

    // preserve original order for stability (return 0)
    return 0;
  });

  const max = steering.max ?? 10;
  return sorted.slice(0, max);
}

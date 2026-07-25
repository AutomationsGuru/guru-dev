export interface RubricCriterion {
  readonly id: string;
  readonly weight: number;
}

/**
 * Scores a rubric deterministically as the weighted average of its criterion
 * scores. Invalid scores and non-positive/non-finite weights contribute zero.
 */
export function grade(
  criteria: readonly RubricCriterion[],
  scores: Readonly<Record<string, number | undefined>>
): number {
  let weightedScore = 0;
  let totalWeight = 0;

  for (const criterion of criteria) {
    if (!Number.isFinite(criterion.weight) || criterion.weight <= 0) {
      continue;
    }

    const score = scores[criterion.id];
    const normalizedScore = typeof score === "number" && Number.isFinite(score)
      ? Math.min(1, Math.max(0, score))
      : 0;

    totalWeight += criterion.weight;
    weightedScore += criterion.weight * normalizedScore;
  }

  return totalWeight === 0 ? 0 : weightedScore / totalWeight;
}

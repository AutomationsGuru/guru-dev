/**
 * Goal panel status (IDEA-F227) — formats an operator-facing
 * {objective, status, criteriaCount, active} snapshot for TUI binding.
 *
 * The input is structural, not an import of the F208 session-goal lifecycle
 * types: any goal object with `objective`, `status`, and `acceptanceCriteria[]`
 * satisfies `GoalLike`, so this module composes with the lifecycle lane when
 * the two dirty overlays merge without either lane importing the other.
 * Pure projection — no state, no I/O, no mutation.
 */

export type GoalLifecycleStatus = "active" | "paused" | "completed" | "blocked";

export interface GoalCriterionLike {
  readonly text: string;
  readonly [key: string]: unknown;
}

/**
 * Minimal structural shape of a session goal as seen by the goal panel.
 * Matches the F208 lifecycle goal object (`objective`, `status`,
 * `acceptanceCriteria[]`) without importing across lanes.
 */
export interface GoalLike {
  readonly objective: string;
  readonly status: GoalLifecycleStatus;
  readonly acceptanceCriteria: readonly GoalCriterionLike[];
}

/** Operator-facing goal panel status, ready for TUI binding. */
export interface GoalPanelStatus {
  readonly objective: string;
  readonly status: GoalLifecycleStatus;
  /** Number of acceptance criteria on the goal (0 when none proposed yet). */
  readonly criteriaCount: number;
  /** True only while the goal is the live one the operator is working against. */
  readonly active: boolean;
}

export function fromGoal(goal: GoalLike): GoalPanelStatus {
  return {
    objective: goal.objective,
    status: goal.status,
    criteriaCount: goal.acceptanceCriteria.length,
    active: goal.status === "active"
  };
}

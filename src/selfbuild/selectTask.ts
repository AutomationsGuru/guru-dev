/**
 * SELECT scoring (self-build P4) — pick the next task to build from the ready set, using
 * stored outcomes so the loop learns what to work on. Pure + deterministic: a
 * recently-blocked task is deprioritised (so the loop doesn't thrash on the same failure),
 * completed / not-ready tasks are ineligible, and ties break by id for stability.
 */

export interface SelectableTask {
  readonly id: string;
  /** Higher = more important. */
  readonly priority?: number;
  /** Dependencies satisfied — only ready tasks are eligible. */
  readonly ready: boolean;
  readonly completed?: boolean;
}

export interface TaskOutcomeHistory {
  /** Task ids that blocked recently — deprioritised to avoid re-picking a known failure. */
  readonly recentBlockers: ReadonlySet<string>;
  readonly completed: ReadonlySet<string>;
}

export const EMPTY_HISTORY: TaskOutcomeHistory = {
  recentBlockers: new Set<string>(),
  completed: new Set<string>()
};

const INELIGIBLE = Number.NEGATIVE_INFINITY;
const RECENT_BLOCK_PENALTY = 100;

export function scoreTask(task: SelectableTask, history: TaskOutcomeHistory = EMPTY_HISTORY): number {
  if (task.completed || history.completed.has(task.id) || !task.ready) {
    return INELIGIBLE;
  }
  let score = task.priority ?? 0;
  if (history.recentBlockers.has(task.id)) {
    score -= RECENT_BLOCK_PENALTY;
  }
  return score;
}

export function selectNextTask(
  tasks: readonly SelectableTask[],
  history: TaskOutcomeHistory = EMPTY_HISTORY
): SelectableTask | null {
  const eligible = tasks
    .map((task) => ({ task, score: scoreTask(task, history) }))
    .filter((entry) => entry.score > INELIGIBLE);
  if (eligible.length === 0) {
    return null;
  }
  eligible.sort((a, b) => b.score - a.score || a.task.id.localeCompare(b.task.id));
  return eligible[0]!.task;
}

/**
 * Goal max grading iterations (IDEA-F213 / R-DA-MAXITER).
 *
 * Bounds the auto re-grade loop for a session goal: every failing grade is counted,
 * and once the failed-iteration count reaches the cap the goal flips to `blocked`
 * and `shouldContinue` stops permitting further automatic re-grades. A blocked goal
 * is a surfaced, honest state — not a dead end: a later passing grade (e.g. after
 * the operator re-plans) resolves it to `passed` and clears the counter, and
 * `clearGoalGrading` resets the round entirely.
 *
 * Pure and I/O-free by construction (same posture as the F208 goal lifecycle and the
 * F210 grader model route it composes with): the grading driver calls `recordGrade`
 * with each grader verdict and consults `shouldContinue` before scheduling another
 * auto re-grade. The cap travels with the F210 grader route; both surfaces share
 * `DEFAULT_MAX_GRADING_ITERATIONS`.
 */

/** Default cap — identical to the F210 grader route default (one grade + bounded re-grade). */
export const DEFAULT_MAX_GRADING_ITERATIONS = 3;

export type GoalGradeOutcome = "pass" | "fail";

export type GoalGradingState = "grading" | "blocked" | "passed";

export interface GoalGradingStatus {
  readonly sessionId: string;
  readonly goalId: string;
  readonly status: GoalGradingState;
  /** Consecutive failing grades in the current grading round. */
  readonly failedIterations: number;
  readonly maxIterations: number;
  /** Why grading is blocked (cap reached or explicit `markBlocked`), else null. */
  readonly blockedReason: string | null;
}

interface GoalGradingRecord {
  failedIterations: number;
  state: GoalGradingState;
  blockedReason: string | null;
}

const records = new Map<string, GoalGradingRecord>();

function keyFor(sessionId: string, goalId: string): string {
  return `${sessionId} ${goalId}`;
}

function assertMaxIterations(maxIterations: number): void {
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new RangeError(`maxIterations must be a positive integer, received ${maxIterations}.`);
  }
}

function recordFor(sessionId: string, goalId: string): GoalGradingRecord {
  const key = keyFor(sessionId, goalId);
  let record = records.get(key);
  if (!record) {
    record = { failedIterations: 0, state: "grading", blockedReason: null };
    records.set(key, record);
  }
  return record;
}

function toStatus(sessionId: string, goalId: string, record: GoalGradingRecord, maxIterations: number): GoalGradingStatus {
  return {
    sessionId,
    goalId,
    status: record.state,
    failedIterations: record.failedIterations,
    maxIterations,
    blockedReason: record.blockedReason
  };
}

/**
 * Record one grader verdict for a goal and return the resulting status.
 * - `fail` increments the round's failed-iteration counter; reaching `maxIterations`
 *   flips the goal to `blocked` so the driver stops auto re-grading.
 * - `pass` resolves the goal to `passed` and clears the counter — including after the
 *   cap was hit, so a blocked goal always has a stated recovery move.
 * A `fail` recorded after a `pass` starts a fresh grading round.
 */
export function recordGrade(
  sessionId: string,
  goalId: string,
  outcome: GoalGradeOutcome,
  maxIterations: number = DEFAULT_MAX_GRADING_ITERATIONS
): GoalGradingStatus {
  assertMaxIterations(maxIterations);
  if (outcome !== "pass" && outcome !== "fail") {
    throw new TypeError(`outcome must be "pass" or "fail", received ${String(outcome)}.`);
  }

  const record = recordFor(sessionId, goalId);

  if (outcome === "pass") {
    record.failedIterations = 0;
    record.state = "passed";
    record.blockedReason = null;
    return toStatus(sessionId, goalId, record, maxIterations);
  }

  if (record.state === "passed") {
    // New grading round after a previously passing grade.
    record.state = "grading";
    record.failedIterations = 0;
    record.blockedReason = null;
  }

  if (record.state === "blocked") {
    // Already at/past the cap: stay blocked, do not inflate the counter.
    return toStatus(sessionId, goalId, record, maxIterations);
  }

  record.failedIterations += 1;
  if (record.failedIterations >= maxIterations) {
    record.state = "blocked";
    record.blockedReason = `max grading iterations reached (${record.failedIterations}/${maxIterations}); auto re-grade stopped`;
  }
  return toStatus(sessionId, goalId, record, maxIterations);
}

/**
 * Whether the driver may schedule another automatic re-grade for this goal.
 * `false` once the goal is `blocked` (cap reached or explicitly marked) or `passed`.
 */
export function shouldContinue(
  sessionId: string,
  goalId: string,
  maxIterations: number = DEFAULT_MAX_GRADING_ITERATIONS
): boolean {
  assertMaxIterations(maxIterations);
  const record = records.get(keyFor(sessionId, goalId));
  if (!record) {
    return true;
  }
  return record.state === "grading";
}

/**
 * Explicitly surface a goal as blocked with an operator-legible reason (e.g. grader
 * model unavailable, operator halt). Preserves the round's failed-iteration count.
 */
export function markBlocked(
  sessionId: string,
  goalId: string,
  reason: string,
  maxIterations: number = DEFAULT_MAX_GRADING_ITERATIONS
): GoalGradingStatus {
  assertMaxIterations(maxIterations);
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new TypeError("reason must be a non-empty string.");
  }
  const record = recordFor(sessionId, goalId);
  record.state = "blocked";
  record.blockedReason = reason.trim();
  return toStatus(sessionId, goalId, record, maxIterations);
}

/** Current grading status for a goal; a fresh goal reads as `grading` with zero fails. */
export function getGoalGradingStatus(
  sessionId: string,
  goalId: string,
  maxIterations: number = DEFAULT_MAX_GRADING_ITERATIONS
): GoalGradingStatus {
  assertMaxIterations(maxIterations);
  const record = records.get(keyFor(sessionId, goalId));
  return toStatus(sessionId, goalId, record ?? { failedIterations: 0, state: "grading", blockedReason: null }, maxIterations);
}

/** Reset one goal's grading round (e.g. after the goal is amended or re-proposed). */
export function clearGoalGrading(sessionId: string, goalId: string): void {
  records.delete(keyFor(sessionId, goalId));
}

/** Cloned snapshots of every tracked goal in a session — safe for callers to hold. */
export function listGoalGradingSnapshots(sessionId: string): readonly GoalGradingStatus[] {
  const snapshots: GoalGradingStatus[] = [];
  for (const [key, record] of records) {
    if (key.startsWith(`${sessionId}`)) {
      snapshots.push(toStatus(sessionId, key.slice(sessionId.length + 1), record, DEFAULT_MAX_GRADING_ITERATIONS));
    }
  }
  return snapshots;
}

/** Test-only: drop all grading state so cases stay isolated. */
export function resetGoalGradingStoreForTests(): void {
  records.clear();
}

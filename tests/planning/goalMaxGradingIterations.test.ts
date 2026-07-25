import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_GRADING_ITERATIONS,
  clearGoalGrading,
  getGoalGradingStatus,
  listGoalGradingSnapshots,
  markBlocked,
  recordGrade,
  resetGoalGradingStoreForTests,
  shouldContinue
} from '../../src/planning/goalMaxGradingIterations.js';

const SESSION = "session-a";
const GOAL = "goal-1";

beforeEach(() => {
  resetGoalGradingStoreForTests();
});

describe("defaults", () => {
  it("shares the F210 grader-route cap of 3", () => {
    expect(DEFAULT_MAX_GRADING_ITERATIONS).toBe(3);
  });

  it("reports a fresh goal as grading with zero failed iterations", () => {
    const status = getGoalGradingStatus(SESSION, GOAL);
    expect(status).toEqual({
      sessionId: SESSION,
      goalId: GOAL,
      status: "grading",
      failedIterations: 0,
      maxIterations: DEFAULT_MAX_GRADING_ITERATIONS,
      blockedReason: null
    });
  });
});

describe("recordGrade", () => {
  it("rejects a non-positive maxIterations", () => {
    expect(() => recordGrade(SESSION, GOAL, "fail", 0)).toThrow(RangeError);
    expect(() => recordGrade(SESSION, GOAL, "fail", 1.5)).toThrow(RangeError);
    expect(() => shouldContinue(SESSION, GOAL, -1)).toThrow(RangeError);
    expect(() => markBlocked(SESSION, GOAL, "x", 0)).toThrow(RangeError);
  });

  it("rejects an unknown grade outcome", () => {
    expect(() => recordGrade(SESSION, GOAL, "maybe" as never)).toThrow(TypeError);
  });

  it("stays under the limit while failed iterations are below the cap", () => {
    expect(recordGrade(SESSION, GOAL, "fail", 3)).toMatchObject({
      status: "grading",
      failedIterations: 1,
      maxIterations: 3
    });
    expect(recordGrade(SESSION, GOAL, "fail", 3)).toMatchObject({
      status: "grading",
      failedIterations: 2
    });
    expect(shouldContinue(SESSION, GOAL, 3)).toBe(true);
  });

  it("blocks auto re-grade at the limit", () => {
    recordGrade(SESSION, GOAL, "fail", 2);
    const atLimit = recordGrade(SESSION, GOAL, "fail", 2);
    expect(atLimit).toMatchObject({
      status: "blocked",
      failedIterations: 2,
      maxIterations: 2
    });
    expect(atLimit.blockedReason).toContain("max grading iterations reached (2/2)");
    expect(shouldContinue(SESSION, GOAL, 2)).toBe(false);
  });

  it("further failing grades after the limit keep the blocked status without inflating the count", () => {
    recordGrade(SESSION, GOAL, "fail", 2);
    recordGrade(SESSION, GOAL, "fail", 2);
    const after = recordGrade(SESSION, GOAL, "fail", 2);
    expect(after).toMatchObject({ status: "blocked", failedIterations: 2 });
  });

  it("a passing grade marks the goal passed and clears the failed counter", () => {
    recordGrade(SESSION, GOAL, "fail");
    const passed = recordGrade(SESSION, GOAL, "pass");
    expect(passed).toMatchObject({ status: "passed", failedIterations: 0, blockedReason: null });
    expect(shouldContinue(SESSION, GOAL)).toBe(false);
  });

  it("a pass after the cap is reached still resolves the goal (recovery path)", () => {
    recordGrade(SESSION, GOAL, "fail", 1);
    expect(getGoalGradingStatus(SESSION, GOAL).status).toBe("blocked");
    const recovered = recordGrade(SESSION, GOAL, "pass", 1);
    expect(recovered).toMatchObject({ status: "passed", failedIterations: 0 });
  });

  it("a fail after a pass starts a new grading round", () => {
    recordGrade(SESSION, GOAL, "pass");
    const next = recordGrade(SESSION, GOAL, "fail");
    expect(next).toMatchObject({ status: "grading", failedIterations: 1 });
  });
});

describe("markBlocked", () => {
  it("surfaces blocked status with the given reason", () => {
    const status = markBlocked(SESSION, GOAL, "operator halted grading");
    expect(status).toMatchObject({
      status: "blocked",
      failedIterations: 0,
      blockedReason: "operator halted grading"
    });
    expect(shouldContinue(SESSION, GOAL)).toBe(false);
  });

  it("rejects an empty reason", () => {
    expect(() => markBlocked(SESSION, GOAL, "   ")).toThrow(TypeError);
  });

  it("preserves the failed-iteration count accrued before the block", () => {
    recordGrade(SESSION, GOAL, "fail", 5);
    const status = markBlocked(SESSION, GOAL, "grader model unavailable", 5);
    expect(status).toMatchObject({ status: "blocked", failedIterations: 1, maxIterations: 5 });
  });
});

describe("isolation and lifecycle", () => {
  it("tracks counters independently per session and per goal", () => {
    recordGrade(SESSION, GOAL, "fail", 1);
    expect(getGoalGradingStatus(SESSION, GOAL).status).toBe("blocked");
    expect(getGoalGradingStatus(SESSION, "goal-2").status).toBe("grading");
    expect(getGoalGradingStatus("session-b", GOAL).status).toBe("grading");
    expect(shouldContinue("session-b", GOAL, 1)).toBe(true);
  });

  it("clearGoalGrading returns the goal to a fresh grading state", () => {
    recordGrade(SESSION, GOAL, "fail", 1);
    clearGoalGrading(SESSION, GOAL);
    expect(getGoalGradingStatus(SESSION, GOAL)).toMatchObject({
      status: "grading",
      failedIterations: 0,
      blockedReason: null
    });
  });

  it("lists snapshots for a session without exposing mutable internals", () => {
    recordGrade(SESSION, GOAL, "fail");
    recordGrade(SESSION, "goal-2", "pass");
    recordGrade("session-b", GOAL, "fail");

    const snapshots = listGoalGradingSnapshots(SESSION);
    expect(snapshots).toHaveLength(2);
    const ids = snapshots.map((snapshot) => snapshot.goalId).sort();
    expect(ids).toEqual([GOAL, "goal-2"]);

    const first = snapshots.find((snapshot) => snapshot.goalId === GOAL);
    expect(first).toBeDefined();
    (first as { failedIterations: number }).failedIterations = 99;
    expect(getGoalGradingStatus(SESSION, GOAL).failedIterations).toBe(1);
  });
});

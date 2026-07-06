import { describe, expect, it } from "vitest";

import { deriveLearning } from "../../src/selfbuild/learn.js";
import { scoreTask, selectNextTask, type SelectableTask, type TaskOutcomeHistory } from "../../src/selfbuild/selectTask.js";

const history = (over: Partial<{ recentBlockers: string[]; completed: string[] }> = {}): TaskOutcomeHistory => ({
  recentBlockers: new Set(over.recentBlockers ?? []),
  completed: new Set(over.completed ?? [])
});

describe("scoreTask / selectNextTask (P4 SELECT scoring)", () => {
  it("completed or not-ready tasks are ineligible", () => {
    expect(scoreTask({ id: "a", ready: false, priority: 99 })).toBe(Number.NEGATIVE_INFINITY);
    expect(scoreTask({ id: "b", ready: true, completed: true, priority: 99 })).toBe(Number.NEGATIVE_INFINITY);
    expect(scoreTask({ id: "c", ready: true, priority: 5 }, history({ completed: ["c"] }))).toBe(Number.NEGATIVE_INFINITY);
  });

  it("picks the highest-priority ready task", () => {
    const tasks: SelectableTask[] = [
      { id: "low", ready: true, priority: 1 },
      { id: "high", ready: true, priority: 9 },
      { id: "blocked-dep", ready: false, priority: 99 }
    ];
    expect(selectNextTask(tasks)?.id).toBe("high");
  });

  it("deprioritises a recently-blocked task (avoids thrash)", () => {
    const tasks: SelectableTask[] = [
      { id: "flaky", ready: true, priority: 10 },
      { id: "steady", ready: true, priority: 5 }
    ];
    expect(selectNextTask(tasks, history({ recentBlockers: ["flaky"] }))?.id).toBe("steady");
  });

  it("no eligible task → null (DAG exhausted)", () => {
    expect(selectNextTask([{ id: "x", ready: false }])).toBeNull();
    expect(selectNextTask([])).toBeNull();
  });
});

describe("deriveLearning (P4 LEARN write-back)", () => {
  it("a clean GREEN completion is a VALIDATED fact", () => {
    const fact = deriveLearning({ taskId: "t1", terminal: "done", verdict: "GREEN" });
    expect(fact.outcome).toBe("shipped");
    expect(fact.confidence).toBe("validated");
  });

  it("a YELLOW completion is PARKED (recorded, not asserted good)", () => {
    expect(deriveLearning({ taskId: "t1", terminal: "done", verdict: "YELLOW" }).confidence).toBe("parked");
  });

  it("a blocked cycle is parked and carries the blocker note for SELECT feedback", () => {
    const fact = deriveLearning({ taskId: "t2", terminal: "blocked", verdict: "RED", note: "test: FAIL x" });
    expect(fact.outcome).toBe("blocked");
    expect(fact.confidence).toBe("parked");
    expect(fact.blockerNote).toBe("test: FAIL x");
  });
});

import { describe, expect, it } from "vitest";

import {
  createHierarchicalDirectorPlan,
  DirectorLoopBudgetExceededError,
  type DirectorAssignment,
  type DirectorWorker
} from '../../src/swarm/hierarchicalDirectorPlan.js';
import { HierarchicalDirectorPlanConfigSchema } from '../../src/swarm/hierarchicalDirectorPlan.js';

/**
 * Hierarchical director plan (IDEA-F522-HIER-01): a director emits task
 * assignments, workers return results, and a reviewer decides whether the
 * loop runs again — but never past maxLoops. Mirrors the swarm contract
 * (docs/decisions/2026-07-04-swarm-contract.md): injected worker, hard-capped
 * config, structured budget error, no fake success.
 */

function recordingWorker(): {
  worker: DirectorWorker;
  calls: () => number;
  assign: (text: string, loop: number) => void;
} {
  const seen: DirectorAssignment[] = [];
  const queue: Array<{ resolve: (value: { text: string; loop: number }) => void; text: string; loop: number }> = [];
  return {
    worker: (assignment) =>
      new Promise((resolve) => {
        seen.push(assignment);
        queue.push({ resolve, text: `result-${assignment.id}`, loop: assignment.loop });
      }),
    calls: () => seen.length,
    assign: (text, loop) => {
      const next = queue.shift();
      next?.resolve({ text, loop });
    }
  };
}

describe("hierarchical director plan config — hard caps in the schema", () => {
  it("defaults are safe and bounded", () => {
    const config = HierarchicalDirectorPlanConfigSchema.parse({});
    expect(config.maxLoops).toBe(3);
    expect(config.maxAssignmentsPerLoop).toBeLessThanOrEqual(16);
  });

  it("a bad config cannot exceed the schema caps", () => {
    expect(() => HierarchicalDirectorPlanConfigSchema.parse({ maxLoops: 99 })).toThrow();
    expect(() => HierarchicalDirectorPlanConfigSchema.parse({ maxAssignmentsPerLoop: 0 })).toThrow();
  });
});

describe("hierarchical director plan — assign / collect", () => {
  it("assign returns immediately with an assignment id at the chosen loop; collect gathers worker results", async () => {
    const { worker, assign } = recordingWorker();
    const plan = createHierarchicalDirectorPlan({ maxAssignmentsPerLoop: 2 });
    plan.setWorker(worker);

    const a = plan.assign("do thing a");
    const b = plan.assign("do thing b");
    expect(a.id).toBeTruthy();
    expect(b.id).not.toBe(a.id);
    expect(a.loop).toBe(0);
    expect(a.state).toBe("assigned");

    assign("a done", 0);
    assign("b done", 0);
    await plan.drain();

    const collected = plan.collect();
    expect(collected).toHaveLength(2);
    expect(collected.some((c) => c.resultText === "a done")).toBe(true);
    expect(collected.some((c) => c.resultText === "b done")).toBe(true);
    expect(collected.every((c) => c.state === "done")).toBe(true);
  });

  it("assign without a worker fails honestly (no fake success)", async () => {
    const plan = createHierarchicalDirectorPlan({});
    plan.setWorker(null);
    const record = plan.assign("orphan");
    await plan.drain();
    expect(record.state).toBe("failed");
    expect(record.error).toContain("No worker");
  });

  it("worker failures are recorded, never silent", async () => {
    const plan = createHierarchicalDirectorPlan({});
    plan.setWorker(async () => {
      throw new Error("worker exploded");
    });
    const record = plan.assign("doomed");
    await plan.drain();
    expect(record.state).toBe("failed");
    expect(record.error).toContain("worker exploded");
  });

  it("collect(loop) scopes results to a single review loop", async () => {
    const { worker } = recordingWorker();
    const plan = createHierarchicalDirectorPlan({});
    plan.setWorker(async (assignment) => ({ text: `r-${assignment.loop}-${assignment.id}`, loop: assignment.loop }));
    plan.assign("loop0-a", 0);
    plan.assign("loop1-a", 1);
    await plan.drain();
    const loop0 = plan.collect(0);
    const loop1 = plan.collect(1);
    expect(loop0.every((c) => c.loop === 0)).toBe(true);
    expect(loop1.every((c) => c.loop === 1)).toBe(true);
    expect(loop0).toHaveLength(1);
    expect(loop1).toHaveLength(1);
  });
});

describe("hierarchical director plan — review loop bounded by maxLoops", () => {
  it("the review loop never exceeds maxLoops: a reviewer that always wants more is stopped by the bound", async () => {
    const worker: DirectorWorker = async (assignment) => ({ text: `done-${assignment.id}`, loop: assignment.loop });
    const plan = createHierarchicalDirectorPlan({ maxLoops: 2, maxAssignmentsPerLoop: 4 });
    plan.setWorker(worker);

    let reviews = 0;
    // Reviewer always wants another loop with one new assignment.
    const reviewer = async (): Promise<{ accepted: boolean; nextAssignments: string[] }> => {
      reviews += 1;
      return { accepted: false, nextAssignments: ["keep going"] };
    };

    const summary = await plan.runReviewLoop(["seed prompt"], reviewer);
    expect(plan.loopCount()).toBe(2); // hard-stopped at maxLoops
    expect(reviews).toBe(2);
    expect(summary.loopsRun).toBe(2);
    expect(summary.budgetExceeded).toBe(true);
  });

  it("the loop terminates early when the reviewer accepts (no more assignments)", async () => {
    const worker: DirectorWorker = async (assignment) => ({ text: `done-${assignment.id}`, loop: assignment.loop });
    const plan = createHierarchicalDirectorPlan({ maxLoops: 5 });
    plan.setWorker(worker);

    const reviewer = async (): Promise<{ accepted: boolean; nextAssignments: string[] }> => ({
      accepted: true,
      nextAssignments: []
    });

    const summary = await plan.runReviewLoop(["one job"], reviewer);
    expect(plan.loopCount()).toBe(1);
    expect(summary.loopsRun).toBe(1);
    expect(summary.budgetExceeded).toBe(false);
  });

  it("runReviewLoop throws a STRUCTURED error when seeded with more prompts than the per-loop cap allows", async () => {
    const plan = createHierarchicalDirectorPlan({ maxAssignmentsPerLoop: 2 });
    plan.setWorker(async (a) => ({ text: `x-${a.id}`, loop: a.loop }));
    let caught: unknown;
    try {
      await plan.runReviewLoop(["a", "b", "c"], async () => ({ accepted: true, nextAssignments: [] }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DirectorLoopBudgetExceededError);
    expect((caught as DirectorLoopBudgetExceededError).code).toBe("director_loop_exceeded");
  });

  it("the reviewer's nextAssignments are also capped per loop (structured error, never silent over-fan-out)", async () => {
    const worker: DirectorWorker = async (a) => ({ text: `x-${a.id}`, loop: a.loop });
    const plan = createHierarchicalDirectorPlan({ maxLoops: 3, maxAssignmentsPerLoop: 2 });
    plan.setWorker(worker);
    // First review asks for 3 follow-ups — over the cap of 2.
    const reviewer = async (): Promise<{ accepted: boolean; nextAssignments: string[] }> => ({
      accepted: false,
      nextAssignments: ["one", "two", "three"]
    });
    await expect(plan.runReviewLoop(["seed"], reviewer)).rejects.toBeInstanceOf(DirectorLoopBudgetExceededError);
  });
});

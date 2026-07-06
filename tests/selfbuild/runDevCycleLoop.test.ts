import { describe, expect, it, vi } from "vitest";

import { runDevCycleLoop, type DevCycleFn } from "../../src/selfbuild/runDevCycleLoop.js";
import type { DevCycleReport } from "../../src/selfbuild/runDevCycle.js";

function report(taskId: string, terminal: "done" | "blocked"): DevCycleReport {
  return {
    verdict: terminal === "done" ? "GREEN" : "RED",
    terminal,
    stages: [],
    budget: {} as DevCycleReport["budget"],
    executor: null,
    learned: { taskId, outcome: terminal === "done" ? "shipped" : "blocked", verdict: terminal === "done" ? "GREEN" : "RED", confidence: "parked", fact: "" },
    ledger: [],
    summary: ""
  };
}

describe("runDevCycleLoop (P7) — unattended multi-cycle driver", () => {
  it("runs one cycle per ready task, highest-priority first, until none remain", async () => {
    const order: string[] = [];
    const cycle: DevCycleFn = vi.fn(async (input) => {
      const id = input.executorOptions!.taskId!;
      order.push(id);
      return report(id, "done");
    });
    const result = await runDevCycleLoop({
      tasks: [
        { id: "b", ready: true, priority: 1 },
        { id: "a", ready: true, priority: 9 },
        { id: "not-ready", ready: false, priority: 99 }
      ],
      cycle
    });
    expect(order).toEqual(["a", "b"]); // priority order; not-ready never runs
    expect([...result.completed].sort()).toEqual(["a", "b"]);
    expect(result.stoppedReason).toBe("no-ready-task");
  });

  it("a blocked task is not re-picked (marked processed) — the loop stays finite", async () => {
    const runs: string[] = [];
    const cycle: DevCycleFn = async (input) => {
      const id = input.executorOptions!.taskId!;
      runs.push(id);
      return report(id, id === "flaky" ? "blocked" : "done");
    };
    const result = await runDevCycleLoop({
      tasks: [
        { id: "flaky", ready: true, priority: 5 },
        { id: "ok", ready: true, priority: 4 }
      ],
      cycle
    });
    expect(runs).toEqual(["flaky", "ok"]); // flaky runs once, is not retried
    expect(result.blocked).toEqual(["flaky"]);
    expect(result.completed).toEqual(["ok"]);
  });

  it("stops at the cycle cap with tasks remaining → max-cycles", async () => {
    const cycle: DevCycleFn = async (input) => report(input.executorOptions!.taskId!, "done");
    const result = await runDevCycleLoop({
      tasks: [
        { id: "t1", ready: true, priority: 3 },
        { id: "t2", ready: true, priority: 2 },
        { id: "t3", ready: true, priority: 1 }
      ],
      cycle,
      maxCycles: 2
    });
    expect(result.cycles).toHaveLength(2);
    expect(result.stoppedReason).toBe("max-cycles");
  });

  it("no ready tasks at all → zero cycles, no-ready-task", async () => {
    const cycle: DevCycleFn = vi.fn(async (input) => report(input.executorOptions!.taskId!, "done"));
    const result = await runDevCycleLoop({ tasks: [{ id: "x", ready: false }], cycle });
    expect(result.cycles).toHaveLength(0);
    expect(cycle).not.toHaveBeenCalled();
    expect(result.stoppedReason).toBe("no-ready-task");
  });
});

import { describe, expect, it } from "vitest";

import { createSwarmManager } from '../../src/swarm/manager.js';
import {
  runCrewSequentialProcess,
  type CrewTask
} from '../../src/swarm/crewSequentialProcess.js';

describe("crew sequential process", () => {
  it("empty task list returns success with empty records", async () => {
    const manager = createSwarmManager({});
    const result = await runCrewSequentialProcess(manager, []);
    expect(result.success).toBe(true);
    expect(result.records).toEqual([]);
    expect(result.finalOutput).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it("single task executes successfully", async () => {
    const manager = createSwarmManager({});
    manager.setRunner(async (request) => {
      return { text: `Processed: ${request.prompt}`, toolCallCount: 0 };
    });

    const tasks: CrewTask[] = [
      { prompt: "Task 1", mode: "read-only", label: "T1" }
    ];

    const result = await runCrewSequentialProcess(manager, tasks);
    expect(result.success).toBe(true);
    expect(result.records.length).toBe(1);
    expect(result.records[0]?.label).toBe("T1");
    expect(result.records[0]?.state).toBe("done");
    expect(result.finalOutput).toBe("Processed: Task 1");
  });

  it("multiple tasks execute sequentially, chaining outputs via the default prompt builder", async () => {
    const manager = createSwarmManager({});
    manager.setRunner(async (request) => {
      return { text: `Result of [${request.prompt}]`, toolCallCount: 1 };
    });

    const tasks: CrewTask[] = [
      { prompt: "Task A", mode: "read-only" },
      { prompt: "Task B", mode: "all" },
      { prompt: "Task C", mode: "read-only" }
    ];

    const result = await runCrewSequentialProcess(manager, tasks);
    expect(result.success).toBe(true);
    expect(result.records.length).toBe(3);

    expect(result.records[0]?.state).toBe("done");
    expect(result.records[1]?.state).toBe("done");
    expect(result.records[2]?.state).toBe("done");

    expect(result.finalOutput).toBe(
      "Result of [Task C\n\n[Previous Output]\nResult of [Task B\n\n[Previous Output]\nResult of [Task A]]]"
    );
  });

  it("custom prompt builder is used to chain tasks", async () => {
    const manager = createSwarmManager({});
    manager.setRunner(async (request) => {
      return { text: `OUT(${request.prompt})`, toolCallCount: 0 };
    });

    const customBuilder = (task: CrewTask, prevOutput: string, index: number) => {
      return `Custom[${index}]: ${task.prompt} -> Prev: ${prevOutput || "none"}`;
    };

    const tasks: CrewTask[] = [
      { prompt: "First" },
      { prompt: "Second" }
    ];

    const result = await runCrewSequentialProcess(manager, tasks, customBuilder);
    expect(result.success).toBe(true);
    expect(result.records.length).toBe(2);

    expect(result.finalOutput).toBe(
      "OUT(Custom[1]: Second -> Prev: OUT(Custom[0]: First -> Prev: none))"
    );
  });

  it("stops immediately and returns error if a task fails", async () => {
    const manager = createSwarmManager({});
    let callCount = 0;
    manager.setRunner(async (request) => {
      callCount += 1;
      if (request.prompt.includes("fail")) {
        throw new Error("Simulated task failure");
      }
      return { text: "success", toolCallCount: 0 };
    });

    const tasks: CrewTask[] = [
      { prompt: "ok task" },
      { prompt: "fail task" },
      { prompt: "never runs" }
    ];

    const result = await runCrewSequentialProcess(manager, tasks);
    expect(result.success).toBe(false);
    expect(result.records.length).toBe(2);
    expect(result.records[0]?.state).toBe("done");
    expect(result.records[1]?.state).toBe("failed");
    expect(result.records[1]?.error).toBe("Simulated task failure");
    expect(result.error).toBe("Simulated task failure");
    expect(callCount).toBe(2);
  });

  it("stops immediately and returns error if a task is killed", async () => {
    const manager = createSwarmManager({});
    manager.setRunner(async () => {
      return new Promise((_, reject) => {
        // Will be rejected/killed by manager
      });
    });

    const tasks: CrewTask[] = [
      { prompt: "to be killed" },
      { prompt: "never runs" }
    ];

    const processPromise = runCrewSequentialProcess(manager, tasks);

    // Let the manager queue and run the task
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Kill the running task
    const activeTasks = manager.list();
    const runningTask = activeTasks[0];
    expect(runningTask).toBeDefined();
    manager.kill(runningTask!.id);

    const result = await processPromise;
    expect(result.success).toBe(false);
    expect(result.records.length).toBe(1);
    expect(result.records[0]?.state).toBe("killed");
    expect(result.error).toBeDefined();
  });

  it("handles manager.spawn synchronous error gracefully (e.g., session task cap)", async () => {
    const limitedManager = createSwarmManager({ maxTasksPerSession: 1 });
    limitedManager.setRunner(async () => ({ text: "ok", toolCallCount: 0 }));

    const tasks: CrewTask[] = [
      { prompt: "task 1" },
      { prompt: "task 2" }
    ];

    const result = await runCrewSequentialProcess(limitedManager, tasks);
    expect(result.success).toBe(false);
    expect(result.records.length).toBe(1);
    expect(result.error).toContain("Swarm session task cap reached");
  });
});

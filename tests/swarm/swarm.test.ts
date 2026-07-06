import { describe, expect, it } from "vitest";

import { createSwarmManager, type SwarmWorkerRequest } from "../../src/swarm/manager.js";
import { createSwarmTools } from "../../src/swarm/tools.js";
import { SwarmConfigSchema, SwarmDepthExceededError } from "../../src/swarm/schema.js";

function deferredRunner(): {
  runner: (request: SwarmWorkerRequest) => Promise<{ text: string; toolCallCount: number }>;
  release: (text?: string) => void;
  started: () => number;
} {
  let starts = 0;
  const releases: Array<(value: { text: string; toolCallCount: number }) => void> = [];
  return {
    runner: (request) => {
      starts += 1;
      return new Promise((resolve) => {
        releases.push((value) => resolve({ ...value, text: `${value.text} [${request.mode}]` }));
      });
    },
    release: (text = "done") => {
      const next = releases.shift();
      next?.({ text, toolCallCount: 1 });
    },
    started: () => starts
  };
}

describe("swarm config — hard caps in the schema", () => {
  it("defaults are safe; ultraSwarm cranks the effective ceiling", () => {
    const config = SwarmConfigSchema.parse({});
    expect(config.maxConcurrentWorkers).toBe(3);
    expect(config.workerToolCallBudget).toBeLessThanOrEqual(24);
    const calm = createSwarmManager({});
    expect(calm.effectiveConcurrency()).toBe(3);
    const cranked = createSwarmManager({ ultraSwarm: true });
    expect(cranked.effectiveConcurrency()).toBe(16);
  });

  it("a bad config cannot exceed the schema caps", () => {
    expect(() => SwarmConfigSchema.parse({ maxConcurrentWorkers: 500 })).toThrow();
    expect(() => SwarmConfigSchema.parse({ workerToolCallBudget: 100 })).toThrow();
  });
});

describe("swarm manager — bounded scheduling", () => {
  it("runs at most the configured concurrency; excess spawns queue", async () => {
    const { runner, release, started } = deferredRunner();
    const manager = createSwarmManager({ maxConcurrentWorkers: 2 });
    manager.setRunner(runner);
    const a = manager.spawn("job a", "read-only");
    const b = manager.spawn("job b", "read-only");
    const c = manager.spawn("job c", "read-only");
    expect(started()).toBe(2); // c queued
    expect(manager.get(c.id)?.state).toBe("queued");
    release("a done");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started()).toBe(3); // c started once a slot freed
    release("b done");
    release("c done");
    await manager.drain();
    expect(manager.get(a.id)?.state).toBe("done");
    expect(manager.get(b.id)?.state).toBe("done");
    expect(manager.get(c.id)?.resultText).toContain("c done");
  });

  it("spawn without a runner fails honestly (no fake success)", async () => {
    const manager = createSwarmManager({});
    manager.setRunner(null);
    const record = manager.spawn("orphan job", "read-only");
    expect(manager.get(record.id)?.state).toBe("failed");
    expect(manager.get(record.id)?.error).toContain("No model connected");
  });

  it("kill_task: queued never starts; running result is discarded (mark-and-detach)", async () => {
    const { runner, release, started } = deferredRunner();
    const manager = createSwarmManager({ maxConcurrentWorkers: 1 });
    manager.setRunner(runner);
    const running = manager.spawn("long job", "read-only");
    const queued = manager.spawn("queued job", "read-only");
    manager.kill(queued.id);
    manager.kill(running.id);
    expect(manager.get(queued.id)?.state).toBe("killed");
    release("late result");
    await manager.drain();
    expect(manager.get(running.id)?.state).toBe("killed");
    expect(manager.get(running.id)?.resultText).toBeUndefined(); // discarded
    expect(started()).toBe(1); // the killed-queued worker never started
  });

  it("session task cap is a hard backstop", () => {
    const manager = createSwarmManager({ maxTasksPerSession: 2 });
    manager.setRunner(async () => ({ text: "x", toolCallCount: 0 }));
    manager.spawn("1", "read-only");
    manager.spawn("2", "read-only");
    expect(() => manager.spawn("3", "read-only")).toThrow(/task cap/);
  });

  it("worker failures are recorded, never silent", async () => {
    const manager = createSwarmManager({});
    manager.setRunner(async () => {
      throw new Error("worker exploded");
    });
    const record = manager.spawn("doomed", "all");
    await manager.drain();
    expect(manager.get(record.id)?.state).toBe("failed");
    expect(manager.get(record.id)?.error).toContain("worker exploded");
  });
});

describe("swarm tools — the model-facing trio", () => {
  it("spawn_agent returns immediately with a taskId; get_task_output polls; kill_task kills", async () => {
    const { runner, release } = deferredRunner();
    const manager = createSwarmManager({});
    manager.setRunner(runner);
    const [spawnTool, outputTool, killTool] = createSwarmTools({ manager });

    const spawned = (await spawnTool?.execute({ prompt: "scout the repo", mode: "read-only" }, {} as never)) as { taskId: string; state: string };
    expect(spawned.taskId).toBeTruthy();
    expect(["queued", "running"]).toContain(spawned.state);

    const pending = (await outputTool?.execute({ taskId: spawned.taskId }, {} as never)) as { found: boolean; state: string };
    expect(pending.found).toBe(true);
    expect(pending.state).toBe("running");

    release("scout report");
    await manager.drain();
    const done = (await outputTool?.execute({ taskId: spawned.taskId }, {} as never)) as { state: string; resultText?: string };
    expect(done.state).toBe("done");
    expect(done.resultText).toContain("scout report");
    expect(done.resultText).toContain("[read-only]"); // mode reached the runner

    const missing = (await outputTool?.execute({ taskId: "nope" }, {} as never)) as { found: boolean };
    expect(missing.found).toBe(false);

    const second = (await spawnTool?.execute({ prompt: "another", mode: "read-only" }, {} as never)) as { taskId: string };
    const killed = (await killTool?.execute({ taskId: second.taskId }, {} as never)) as { state: string };
    expect(["killed", "queued", "running"]).toContain(killed.state);
  });
});

describe("swarm GOVERNOR (§17 scenario 5): depth error + per-spawn budgets + mandate snapshot", () => {
  it("the recursion-depth ceiling fires a STRUCTURED error, never a silent stop", () => {
    const manager = createSwarmManager({ maxSpawnDepth: 2 });
    manager.setRunner(async () => ({ text: "x", toolCallCount: 0 }));
    expect(manager.spawn("d0", "read-only").depth).toBe(0);
    expect(manager.spawn("d2", "read-only", "l", { depth: 2 }).depth).toBe(2);
    let caught: unknown;
    try {
      manager.spawn("d3", "read-only", "l", { depth: 3 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SwarmDepthExceededError);
    expect((caught as SwarmDepthExceededError).code).toBe("swarm_depth_exceeded");
    expect((caught as SwarmDepthExceededError).depth).toBe(3);
    expect((caught as SwarmDepthExceededError).limit).toBe(2);
  });

  it("the worker request carries the per-spawn token + iteration budgets and depth", async () => {
    let seen: SwarmWorkerRequest | undefined;
    const manager = createSwarmManager({ workerToolCallBudget: 5, workerTokenBudget: 1234 });
    manager.setRunner(async (request) => {
      seen = request;
      return { text: "ok", toolCallCount: 0 };
    });
    manager.spawn("job", "read-only");
    await manager.drain();
    expect(seen?.toolCallBudget).toBe(5);
    expect(seen?.tokenBudget).toBe(1234);
    expect(seen?.depth).toBe(0);
  });

  it("budget_exceeded from the runner propagates to the record + get_task_output (partial output)", async () => {
    const manager = createSwarmManager({});
    manager.setRunner(async () => ({ text: "partial", toolCallCount: 8, budgetExceeded: true }));
    const [spawnTool, outputTool] = createSwarmTools({ manager });
    const spawned = (await spawnTool?.execute({ prompt: "big job", mode: "read-only" }, {} as never)) as { taskId: string };
    await manager.drain();
    expect(manager.get(spawned.taskId)?.budgetExceeded).toBe(true);
    const out = (await outputTool?.execute({ taskId: spawned.taskId }, {} as never)) as { budgetExceeded?: boolean; summary: string };
    expect(out.budgetExceeded).toBe(true);
    expect(out.summary).toContain("budget_exceeded");
  });

  it("SIBLING ISOLATION: the mandate is snapshotted at SPAWN — a later change never reaches a queued worker", async () => {
    let live = "mandate-v1";
    const seen: unknown[] = [];
    const releases: Array<() => void> = [];
    const manager = createSwarmManager({ maxConcurrentWorkers: 1 });
    manager.setSnapshotProvider(() => live);
    manager.setRunner(
      (request) =>
        new Promise((resolve) => {
          seen.push(request.mandateSnapshot);
          releases.push(() => resolve({ text: "x", toolCallCount: 0 }));
        })
    );
    manager.spawn("a", "read-only"); // snapshot captured NOW = v1; runner invoked (slot free)
    manager.spawn("b", "read-only"); // snapshot captured NOW = v1; QUEUED behind a
    live = "mandate-v2"; // operator changes the mandate AFTER both spawns
    releases[0]?.(); // a finishes → b is pumped and its runner invoked (live is now v2)
    await new Promise((r) => setImmediate(r));
    releases[1]?.();
    await manager.drain();
    // Both workers saw the mandate as it was AT THEIR SPAWN (v1), not the live v2.
    expect(seen).toEqual(["mandate-v1", "mandate-v1"]);
  });
});

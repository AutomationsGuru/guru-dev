import { describe, expect, it } from "vitest";

import {
  DagCycleError,
  runDag,
  type DagNode,
  type DagPlan,
  type DagRunResult,
  type DagWorker
} from '../../src/orchestrator/dagRunner.js';

/**
 * IDEA-F267-DAG-ORCH-01 — orchestrator DAG runner (R-AU-DAG).
 * Plan nodes with deps; ready workers run in parallel (concurrency-capped);
 * a fan-in continue/replan hook decides whether the run continues after each
 * node settles. Bounded: failures skip dependents, cycle/unknown-dep plans are
 * rejected before the first worker runs — no hang, no dead-end.
 */

function deferred(): { release: (value: string) => void; promise: Promise<string> } {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((r) => {
    resolve = r;
  });
  return { release: resolve, promise };
}

function planOf(nodes: readonly DagNode[]): DagPlan {
  return { id: "plan-test", nodes };
}

describe("runDag — ready-node scheduling", () => {
  it("runs all dependency-free nodes in parallel", async () => {
    const gates = new Map<string, ReturnType<typeof deferred>>([
      ["a", deferred()],
      ["b", deferred()],
      ["c", deferred()]
    ]);
    const started: string[] = [];
    const worker: DagWorker = (node) => {
      started.push(node.id);
      return gates.get(node.id)!.promise;
    };

    const runPromise = runDag(
      planOf([{ id: "a" }, { id: "b" }, { id: "c" }]),
      worker
    );

    // All three start before any completes.
    await Promise.resolve();
    expect(started.sort()).toEqual(["a", "b", "c"]);

    for (const gate of gates.values()) {
      gate.release("done");
    }
    const result: DagRunResult = await runPromise;
    expect(result.status).toBe("completed");
    expect(result.outputs.get("a")).toBe("done");
    expect(result.outputs.size).toBe(3);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it("a blocked node waits for its deps and receives their outputs", async () => {
    const seen = new Map<string, ReadonlyMap<string, string>>();
    const worker: DagWorker = (node, inputs) => {
      seen.set(node.id, inputs);
      return Promise.resolve(`${node.id}-out`);
    };

    const result = await runDag(
      planOf([
        { id: "a" },
        { id: "b" },
        { id: "c", deps: ["a", "b"] }
      ]),
      worker
    );

    expect(result.status).toBe("completed");
    expect(seen.get("c")).toEqual(new Map([
      ["a", "a-out"],
      ["b", "b-out"]
    ]));
    // Leaves saw an empty input map.
    expect(seen.get("a")!.size).toBe(0);
  });

  it("respects the concurrency cap while keeping ready nodes flowing", async () => {
    let inFlight = 0;
    let peak = 0;
    const worker: DagWorker = async (node) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return node.id;
    };

    const result = await runDag(
      planOf([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }]),
      worker,
      { maxConcurrency: 2 }
    );

    expect(result.status).toBe("completed");
    expect(peak).toBe(2);
    expect(result.outputs.size).toBe(5);
  });

  it("a dep chain runs in order", async () => {
    const order: string[] = [];
    const worker: DagWorker = (node) => {
      order.push(node.id);
      return Promise.resolve(node.id);
    };

    const result = await runDag(
      planOf([
        { id: "a" },
        { id: "b", deps: ["a"] },
        { id: "c", deps: ["b"] }
      ]),
      worker
    );

    expect(order).toEqual(["a", "b", "c"]);
    expect(result.status).toBe("completed");
  });
});

describe("runDag — failure containment", () => {
  it("a failed node skips its dependents but independent branches still complete", async () => {
    const worker: DagWorker = (node) => {
      if (node.id === "bad") {
        return Promise.reject(new Error("boom"));
      }
      return Promise.resolve(`${node.id}-ok`);
    };

    const result = await runDag(
      planOf([
        { id: "bad" },
        { id: "child", deps: ["bad"] },
        { id: "grandchild", deps: ["child"] },
        { id: "free" }
      ]),
      worker
    );

    expect(result.status).toBe("failed");
    expect(result.failed).toEqual(["bad"]);
    expect([...result.skipped].sort()).toEqual(["child", "grandchild"]);
    expect(result.outputs.get("free")).toBe("free-ok");
  });

  it("a skip cascades: dependents of skipped nodes are skipped, never run", async () => {
    const ran: string[] = [];
    const worker: DagWorker = (node) => {
      ran.push(node.id);
      if (node.id === "a") {
        return Promise.reject(new Error("nope"));
      }
      return Promise.resolve(node.id);
    };

    const result = await runDag(
      planOf([
        { id: "a" },
        { id: "b", deps: ["a"] },
        { id: "c", deps: ["b"] }
      ]),
      worker
    );

    expect(ran).toEqual(["a"]);
    expect([...result.skipped].sort()).toEqual(["b", "c"]);
    expect(result.status).toBe("failed");
  });
});

describe("runDag — fan-in continue/replan hook", () => {
  it("the hook sees each settled node and can request a replan that re-runs the remaining subgraph", async () => {
    const runs = new Map<string, number>();
    const worker: DagWorker = (node) => {
      runs.set(node.id, (runs.get(node.id) ?? 0) + 1);
      return Promise.resolve(`${node.id}#${runs.get(node.id)}`);
    };

    let hookCalls = 0;
    const result = await runDag(
      planOf([
        { id: "a" },
        { id: "b", deps: ["a"] }
      ]),
      worker,
      {
        onNodeSettled: (event) => {
          hookCalls += 1;
          // First time `a` settles, ask for one replan of the downstream subgraph.
          if (event.nodeId === "a" && hookCalls === 1) {
            return { action: "replan", reason: "stale result" };
          }
          return { action: "continue" };
        }
      }
    );

    expect(result.status).toBe("completed");
    // `a` re-ran; `b` had never started (it was still blocked), so it runs
    // exactly once — against the FRESH `a` output, never the stale one.
    expect(runs.get("a")).toBe(2);
    expect(runs.get("b")).toBe(1);
    expect(result.outputs.get("a")).toBe("a#2");
    expect(result.outputs.get("b")).toBe("b#1");
    expect(result.replanCount).toBe(1);
  });

  it("a replan re-runs already-settled downstream nodes against fresh inputs", async () => {
    const bInputs: string[] = [];
    let aRuns = 0;
    const worker: DagWorker = (node, inputs) => {
      if (node.id === "a") {
        aRuns += 1;
        return Promise.resolve(`a#${aRuns}`);
      }
      if (node.id === "b") {
        bInputs.push(inputs.get("a") ?? "");
      }
      return Promise.resolve(`${node.id}-out`);
    };

    // All nodes settle before the hook's first replan: a -> b chain where the
    // hook replans after b's settle (the whole subgraph re-runs).
    let hookCalls = 0;
    const result = await runDag(
      planOf([
        { id: "a" },
        { id: "b", deps: ["a"] }
      ]),
      worker,
      {
        onNodeSettled: (event) => {
          hookCalls += 1;
          if (event.nodeId === "b" && hookCalls === 2) {
            return { action: "replan" };
          }
          return { action: "continue" };
        }
      }
    );

    expect(result.status).toBe("completed");
    // b ran twice: once on stale a#1, once on fresh a#2.
    expect(bInputs).toEqual(["a#1", "a#2"]);
    expect(result.replanCount).toBe(1);
  });

  it("the hook can abort the run: remaining ready nodes never start", async () => {
    const started: string[] = [];
    const gate = deferred();
    const worker: DagWorker = (node) => {
      started.push(node.id);
      if (node.id === "a") {
        return gate.promise;
      }
      return Promise.resolve(node.id);
    };

    const runPromise = runDag(
      planOf([
        { id: "a" },
        { id: "b", deps: ["a"] },
        { id: "c", deps: ["b"] }
      ]),
      worker,
      {
        onNodeSettled: () => ({ action: "abort", reason: "operator stop" })
      }
    );

    await Promise.resolve();
    expect(started).toEqual(["a"]);
    gate.release("a-done");

    const result = await runPromise;
    expect(result.status).toBe("aborted");
    expect(result.abortReason).toBe("operator stop");
    expect(started).toEqual(["a"]);
    expect([...result.skipped].sort()).toEqual(["b", "c"]);
  });

  it("replan is bounded: a hook that always replans stops at maxReplans", async () => {
    let aRuns = 0;
    const worker: DagWorker = (node) => {
      if (node.id === "a") {
        aRuns += 1;
      }
      return Promise.resolve(node.id);
    };

    const result = await runDag(
      planOf([
        { id: "a" },
        { id: "b", deps: ["a"] }
      ]),
      worker,
      {
        maxReplans: 2,
        onNodeSettled: (event) =>
          event.nodeId === "a" ? { action: "replan" } : { action: "continue" }
      }
    );

    expect(aRuns).toBe(3); // initial + 2 replans, then the bound bites
    expect(result.replanCount).toBe(2);
    expect(result.status).toBe("completed");
  });
});

describe("runDag — plan validation (no hang, no silent dead-end)", () => {
  it("rejects a cyclic plan before any worker runs", async () => {
    let ran = false;
    const worker: DagWorker = () => {
      ran = true;
      return Promise.resolve("x");
    };

    await expect(
      runDag(
        planOf([
          { id: "a", deps: ["c"] },
          { id: "b", deps: ["a"] },
          { id: "c", deps: ["b"] }
        ]),
        worker
      )
    ).rejects.toBeInstanceOf(DagCycleError);
    expect(ran).toBe(false);
  });

  it("rejects an unknown dependency before any worker runs", async () => {
    let ran = false;
    const worker: DagWorker = () => {
      ran = true;
      return Promise.resolve("x");
    };

    await expect(
      runDag(planOf([{ id: "a", deps: ["ghost"] }]), worker)
    ).rejects.toThrow(/ghost/);
    expect(ran).toBe(false);
  });

  it("rejects duplicate node ids", async () => {
    await expect(
      runDag(planOf([{ id: "a" }, { id: "a" }]), () => Promise.resolve("x"))
    ).rejects.toThrow(/duplicate/i);
  });

  it("an empty plan completes trivially", async () => {
    const result = await runDag(planOf([]), () => Promise.resolve("x"));
    expect(result.status).toBe("completed");
    expect(result.outputs.size).toBe(0);
  });
});

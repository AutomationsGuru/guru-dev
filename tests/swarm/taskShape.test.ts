import { describe, expect, it } from "vitest";

import { createSwarmManager } from '../../src/swarm/manager.js';
import { createSwarmTools } from '../../src/swarm/tools.js';
import {
  evaluateCompletion,
  resolveTaskShape,
  shapePermitsWriteTools,
  ShipCompletionSchema,
  ScoutCompletionSchema,
  TaskCompletionSchema,
  TaskShapeSchema
} from '../../src/swarm/taskShape.js';

describe("taskShape — the ship/scout discriminator", () => {
  it("only admits 'ship' and 'scout'", () => {
    expect(TaskShapeSchema.parse("ship")).toBe("ship");
    expect(TaskShapeSchema.parse("scout")).toBe("scout");
    expect(() => TaskShapeSchema.parse("explore")).toThrow();
    expect(() => TaskShapeSchema.parse("")).toThrow();
  });

  it("resolveTaskShape: explicit shape always wins", () => {
    expect(resolveTaskShape("ship", "read-only")).toBe("ship");
    expect(resolveTaskShape("scout", "all")).toBe("scout");
  });

  it("resolveTaskShape: read-only/explore defaults to scout; mutation-capable defaults to ship", () => {
    // New spawn API: explore/read-only workers are scouts that must leave a report.
    expect(resolveTaskShape(undefined, "read-only")).toBe("scout");
    // Backward compat: a mutation-capable worker with no explicit shape is a ship.
    expect(resolveTaskShape(undefined, "all")).toBe("ship");
  });

  it("scouts are structurally barred from write tools; ships may register them", () => {
    expect(shapePermitsWriteTools("scout")).toBe(false);
    expect(shapePermitsWriteTools("ship")).toBe(true);
  });
});

describe("taskShape — completion schemas", () => {
  it("ship completion: verification notes OR operator skip", () => {
    expect(ShipCompletionSchema.parse({ shape: "ship", verificationNotes: "ran tests, green" }).verificationNotes).toBeTruthy();
    expect(ShipCompletionSchema.parse({ shape: "ship", operatorSkip: true }).operatorSkip).toBe(true);
    expect(() => ShipCompletionSchema.parse({ shape: "ship", verificationNotes: "" })).toThrow();
  });

  it("scout completion requires a non-empty reportPath", () => {
    expect(ScoutCompletionSchema.parse({ shape: "scout", reportPath: "/x/report.json" }).reportPath).toBe("/x/report.json");
    expect(() => ScoutCompletionSchema.parse({ shape: "scout", reportPath: "" })).toThrow();
    expect(() => ScoutCompletionSchema.parse({ shape: "scout" })).toThrow();
  });

  it("the discriminated union rejects cross-shape evidence", () => {
    expect(() => TaskCompletionSchema.parse({ shape: "scout", verificationNotes: "x" })).toThrow();
    expect(() => TaskCompletionSchema.parse({ shape: "ship", reportPath: "/x" })).toThrow();
  });
});

describe("evaluateCompletion — fail-closed gate", () => {
  it("a scout with NO completion evidence is INCOMPLETE (dispatch is not done)", () => {
    const check = evaluateCompletion("scout", undefined);
    expect(check.complete).toBe(false);
    expect(check.complete === false && check.reason).toMatch(/report/i);
  });

  it("a scout with a reportPath is COMPLETE", () => {
    const check = evaluateCompletion("scout", { shape: "scout", reportPath: "/p/r.json" });
    expect(check.complete).toBe(true);
  });

  it("a ship with no verification and no skip is INCOMPLETE", () => {
    const check = evaluateCompletion("ship", undefined);
    expect(check.complete).toBe(false);
    const empty = evaluateCompletion("ship", { shape: "ship" });
    expect(empty.complete).toBe(false);
  });

  it("a ship with verification notes is COMPLETE", () => {
    expect(evaluateCompletion("ship", { shape: "ship", verificationNotes: "vitest green" }).complete).toBe(true);
  });

  it("a ship with an explicit operator skip is COMPLETE without notes", () => {
    expect(evaluateCompletion("ship", { shape: "ship", operatorSkip: true }).complete).toBe(true);
  });

  it("operatorSkip=false still requires verification notes", () => {
    expect(evaluateCompletion("ship", { shape: "ship", operatorSkip: false }).complete).toBe(false);
  });

  it("shape-mismatched evidence never completes the worker", () => {
    // A scout cannot satisfy completion with ship verification, and vice versa.
    expect(evaluateCompletion("scout", { shape: "ship", verificationNotes: "x" }).complete).toBe(false);
    expect(evaluateCompletion("ship", { shape: "scout", reportPath: "/p" }).complete).toBe(false);
  });
});

describe("swarm manager — taskShape enforced at spawn + completion (IDEA-A2)", () => {
  it("spawn resolves and records the shape (read-only→scout, all→ship, explicit wins)", async () => {
    const manager = createSwarmManager({});
    manager.setRunner(async () => ({ text: "x", toolCallCount: 0 }));
    const scout = manager.spawn("explore the repo", "read-only");
    const ship = manager.spawn("apply the fix", "all");
    const explicit = manager.spawn("read but ship it", "read-only", undefined, { taskShape: "ship" });
    expect(manager.get(scout.id)?.taskShape).toBe("scout");
    expect(manager.get(ship.id)?.taskShape).toBe("ship");
    expect(manager.get(explicit.id)?.taskShape).toBe("ship");
    await manager.drain();
  });

  it("a finished scout with NO report is INCOMPLETE — missing report = incomplete", async () => {
    const manager = createSwarmManager({});
    manager.setRunner(async () => ({ text: "findings", toolCallCount: 1 }));
    const scout = manager.spawn("scout it", "read-only");
    await manager.drain();
    const record = manager.get(scout.id);
    expect(record?.state).toBe("done"); // the RUN finished…
    expect(record?.incompleteReason).toMatch(/report/i); // …but it is not COMPLETE
  });

  it("a finished ship with no verification/skip is INCOMPLETE; verification closes it", async () => {
    const manager = createSwarmManager({});
    manager.setRunner(async () => ({ text: "changed", toolCallCount: 2 }));
    const ship = manager.spawn("ship it", "all");
    await manager.drain();
    expect(manager.get(ship.id)?.incompleteReason).toBeTruthy();
    const closed = manager.complete(ship.id, { shape: "ship", verificationNotes: "vitest green" });
    expect(closed?.incompleteReason).toBeUndefined();
  });

  it("complete(...) closes a scout once a report ref is supplied; bad evidence stays incomplete", async () => {
    const manager = createSwarmManager({});
    manager.setRunner(async () => ({ text: "findings", toolCallCount: 1 }));
    const scout = manager.spawn("scout it", "read-only");
    await manager.drain();
    // Cross-shape evidence does NOT close a scout.
    const wrong = manager.complete(scout.id, { shape: "ship", verificationNotes: "x" });
    expect(wrong?.incompleteReason).toBeTruthy();
    // A real report ref closes it.
    const closed = manager.complete(scout.id, { shape: "scout", reportPath: "/p/scout.json" });
    expect(closed?.incompleteReason).toBeUndefined();
  });

  it("get_task_output surfaces taskShape, incomplete flag, and reportPath honestly", async () => {
    const manager = createSwarmManager({});
    manager.setRunner(async () => ({ text: "findings", toolCallCount: 1 }));
    const [spawnTool, outputTool] = createSwarmTools({ manager });

    const spawned = (await spawnTool?.execute({ prompt: "scout the seam", mode: "read-only" }, {} as never)) as { taskId: string };
    await manager.drain();
    const out = (await outputTool?.execute({ taskId: spawned.taskId }, {} as never)) as {
      taskShape?: string;
      incomplete?: boolean;
      incompleteReason?: string;
      summary: string;
    };
    expect(out.taskShape).toBe("scout");
    expect(out.incomplete).toBe(true);
    expect(out.incompleteReason).toMatch(/report/i);
    expect(out.summary).toContain("INCOMPLETE");

    manager.complete(spawned.taskId, { shape: "scout", reportPath: "/p/r.json" });
    const closed = (await outputTool?.execute({ taskId: spawned.taskId }, {} as never)) as {
      incomplete?: boolean;
      reportPath?: string;
      summary: string;
    };
    expect(closed.incomplete).toBeUndefined();
    expect(closed.reportPath).toBe("/p/r.json");
    expect(closed.summary).not.toContain("INCOMPLETE");
  });

  it("spawn_agent threads an explicit taskShape through to the manager", async () => {
    const manager = createSwarmManager({});
    manager.setRunner(async () => ({ text: "x", toolCallCount: 0 }));
    const [spawnTool] = createSwarmTools({ manager });
    const spawned = (await spawnTool?.execute({ prompt: "read-only but a ship", mode: "read-only", taskShape: "ship" }, {} as never)) as {
      taskId: string;
    };
    expect(manager.get(spawned.taskId)?.taskShape).toBe("ship");
    await manager.drain();
  });
});

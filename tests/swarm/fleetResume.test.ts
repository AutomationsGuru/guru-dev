import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFleetLedger, type FleetLedger } from '../../src/swarm/fleetLedger.js';
import { resumeFleetRun } from '../../src/swarm/fleetResume.js';

let root: string;
let ledger: FleetLedger;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fleet-resume-"));
  ledger = createFleetLedger({ directory: root });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const spawnAndFail = (runId: string, workerId: string, failureClass: "transient" | "task" | "verifier" | "needs_human"): void => {
  ledger.append({ kind: "worker_spawned", runId, workerId, role: "builder" });
  ledger.append({ kind: "worker_finished", runId, workerId, status: "failed", failureClass });
};

describe("resume — requeue transient within the retry budget", () => {
  it("requeues a transient-failed worker and bumps its attempt", () => {
    spawnAndFail("r1", "w1", "transient");
    const result = resumeFleetRun({ ledger, runId: "r1", retryBudget: 3 });
    expect(result.requeued).toEqual(["w1"]);
    expect(result.escalated).toEqual([]);
    const action = result.actions.find((entry) => entry.workerId === "w1")!;
    expect(action.action).toBe("requeue");
    expect(action.attempt).toBe(2); // spawn was attempt 1; requeue is attempt 2
  });

  it("persists the requeue to the ledger so a later process sees it", () => {
    spawnAndFail("r1", "w1", "transient");
    resumeFleetRun({ ledger, runId: "r1", retryBudget: 3 });
    const worker = ledger.workers("r1")[0]!;
    expect(worker.status).toBe("queued"); // back to queued, ready to run again
    expect(worker.attempts).toBe(2);
  });
});

describe("resume — escalate when the budget is exhausted", () => {
  it("escalates a transient failure that has already spent its retries", () => {
    spawnAndFail("r1", "w1", "transient");
    // Burn the budget: two prior resumes requeued it (attempts now at the cap).
    resumeFleetRun({ ledger, runId: "r1", retryBudget: 2 });
    ledger.append({ kind: "worker_finished", runId: "r1", workerId: "w1", status: "failed", failureClass: "transient" });
    const result = resumeFleetRun({ ledger, runId: "r1", retryBudget: 2 });
    expect(result.requeued).toEqual([]);
    expect(result.escalated).toEqual(["w1"]);
    const action = result.actions.find((entry) => entry.workerId === "w1")!;
    expect(action.action).toBe("escalate");
  });

  it("an escalated worker is marked needs_human (terminal, not silently dropped)", () => {
    spawnAndFail("r1", "w1", "transient");
    resumeFleetRun({ ledger, runId: "r1", retryBudget: 1 }); // budget 1 → first failure escalates
    const worker = ledger.workers("r1")[0]!;
    expect(worker.status).toBe("needs_human");
  });
});

describe("resume — non-transient failures are not auto-requeued", () => {
  it.each(["task", "verifier", "needs_human"] as const)("escalates a %s failure instead of requeueing", (failureClass) => {
    spawnAndFail("r1", "w1", failureClass);
    const result = resumeFleetRun({ ledger, runId: "r1", retryBudget: 5 });
    expect(result.requeued).toEqual([]);
    expect(result.escalated).toEqual(["w1"]);
  });
});

describe("resume — orphaned leases from a crashed process", () => {
  it("requeues a worker that was spawned but never finished (lost lease)", () => {
    ledger.append({ kind: "worker_spawned", runId: "r1", workerId: "w1", role: "scout" });
    ledger.append({ kind: "heartbeat", runId: "r1", workerId: "w1" });
    // process died here — no worker_finished
    const result = resumeFleetRun({ ledger, runId: "r1", retryBudget: 3 });
    expect(result.requeued).toEqual(["w1"]);
  });
});

describe("resume — terminal workers are left alone", () => {
  it("does not touch a worker that completed", () => {
    ledger.append({ kind: "worker_spawned", runId: "r1", workerId: "w1", role: "builder" });
    ledger.append({ kind: "worker_finished", runId: "r1", workerId: "w1", status: "done" });
    const result = resumeFleetRun({ ledger, runId: "r1", retryBudget: 3 });
    expect(result.requeued).toEqual([]);
    expect(result.escalated).toEqual([]);
    expect(result.actions.find((entry) => entry.workerId === "w1")!.action).toBe("complete");
  });
});

describe("resume — idempotency", () => {
  it("a second resume over the same run makes no new decision", () => {
    spawnAndFail("r1", "w1", "transient");
    const first = resumeFleetRun({ ledger, runId: "r1", retryBudget: 3 });
    expect(first.requeued).toEqual(["w1"]);
    const second = resumeFleetRun({ ledger, runId: "r1", retryBudget: 3 });
    // w1 is now queued (requeued), not failed — nothing to re-decide.
    expect(second.requeued).toEqual([]);
    expect(second.escalated).toEqual([]);
  });

  it("re-resuming an already-escalated worker does not double-escalate", () => {
    spawnAndFail("r1", "w1", "task");
    resumeFleetRun({ ledger, runId: "r1", retryBudget: 3 });
    const before = ledger.readAll().length;
    const second = resumeFleetRun({ ledger, runId: "r1", retryBudget: 3 });
    expect(second.escalated).toEqual([]);
    expect(ledger.readAll().length).toBe(before); // no new events appended
  });
});

describe("resume — run isolation", () => {
  it("only reconciles the requested run", () => {
    spawnAndFail("r1", "w1", "transient");
    spawnAndFail("r2", "w2", "transient");
    const result = resumeFleetRun({ ledger, runId: "r1", retryBudget: 3 });
    expect(result.requeued).toEqual(["w1"]);
    expect(ledger.workers("r2")[0]!.status).toBe("failed"); // untouched
  });
});

import { describe, expect, it } from "vitest";

import {
  evaluateSessionEndGuard,
  isLiveSelfBuildStatus,
  isSessionEndAllowed,
  LIVE_SELF_BUILD_STATUSES
} from '../../src/runtime/sessionEndGuard.js';
import { buildFleetSnapshot, type FleetSnapshot } from '../../src/swarm/fleetSnapshot.js';
import { createSwarmManager, type SwarmWorkerRequest } from '../../src/swarm/manager.js';

const fixedNow = () => new Date("2026-07-18T12:00:00.000Z");

function deferredRunner(): {
  runner: (request: SwarmWorkerRequest) => Promise<{ text: string; toolCallCount: number }>;
  release: (text?: string) => void;
} {
  const releases: Array<(value: { text: string; toolCallCount: number }) => void> = [];
  return {
    runner: () =>
      new Promise((resolve) => {
        releases.push((value) => resolve(value));
      }),
    release: (text = "done") => {
      const next = releases.shift();
      next?.({ text, toolCallCount: 1 });
    }
  };
}

function snapshotWith(options: { selfBuildTasks?: Array<{ id: string; title: string; status: string }>; packetNames?: readonly string[] } = {}): {
  manager: ReturnType<typeof createSwarmManager>;
  snapshot: () => FleetSnapshot;
} {
  const manager = createSwarmManager({});
  const selfBuild = options.selfBuildTasks ? { tasks: options.selfBuildTasks } : undefined;
  return {
    manager,
    snapshot: () =>
      buildFleetSnapshot({
        manager,
        now: fixedNow,
        ...(selfBuild ? { selfBuild } : {})
      })
  };
}

describe("session end guard — allow paths", () => {
  it("an empty fleet allows the end immediately", () => {
    const { snapshot } = snapshotWith();
    const decision = evaluateSessionEndGuard(snapshot());
    expect(decision.outcome).toBe("allow");
    expect(decision.reasons).toEqual(["no-active-fleet-work"]);
    expect(decision.blockers).toEqual([]);
    expect(isSessionEndAllowed(decision)).toBe(true);
  });

  it("terminal-only workers (done/failed/killed) never block the end", async () => {
    const { runner, release } = deferredRunner();
    const manager = createSwarmManager({ maxConcurrentWorkers: 1 });
    manager.setRunner(runner);
    const done = manager.spawn("will finish", "read-only");
    const killed = manager.spawn("will die", "read-only");
    // Killed while still queued: terminal without a dangling runner promise.
    manager.kill(killed.id);
    release("ok");
    await manager.drain();
    expect(manager.get(done.id)?.state).toBe("done");

    const decision = evaluateSessionEndGuard(buildFleetSnapshot({ manager, now: fixedNow }));
    expect(decision.outcome).toBe("allow");
    expect(decision.reasons).toEqual(["no-active-fleet-work"]);
  });

  it("ready/blocked self-build backlog does not block the end", () => {
    const { snapshot } = snapshotWith({
      selfBuildTasks: [
        { id: "t1", title: "Ready", status: "ready" },
        { id: "t2", title: "Blocked", status: "blocked" },
        { id: "t3", title: "Done", status: "done" }
      ]
    });
    const decision = evaluateSessionEndGuard(snapshot());
    expect(decision.outcome).toBe("allow");
    expect(decision.reasons).toEqual(["no-active-fleet-work"]);
  });

  it("open packets advise but never block the end", () => {
    const manager = createSwarmManager({});
    const snapshot = buildFleetSnapshot({
      manager,
      now: fixedNow,
      packetDirs: []
    });
    // Inject packets via a rebuilt snapshot shape: open packets are informational.
    const withPackets: FleetSnapshot = {
      ...snapshot,
      openPackets: [{ name: "handoff.md", source: "/tmp/packets" }],
      counts: { ...snapshot.counts, openPackets: 1 }
    };
    const decision = evaluateSessionEndGuard(withPackets);
    expect(decision.outcome).toBe("allow");
    expect(decision.advisories).toHaveLength(1);
    expect(decision.advisories[0]).toContain("handoff.md");
    expect(decision.openPackets).toBe(1);
  });
});

describe("session end guard — no blind end", () => {
  it("a running worker flips the outcome to needs_confirm with named blockers", () => {
    const { runner } = deferredRunner();
    const manager = createSwarmManager({});
    manager.setRunner(runner);
    const worker = manager.spawn("long job", "read-only", "long-label");
    expect(manager.get(worker.id)?.state).toBe("running");

    const decision = evaluateSessionEndGuard(buildFleetSnapshot({ manager, now: fixedNow }));
    expect(decision.outcome).toBe("needs_confirm");
    expect(decision.reasons).toContain("active-workers");
    expect(decision.blockers).toHaveLength(1);
    expect(decision.blockers[0]).toContain(worker.id);
    expect(decision.blockers[0]).toContain("long-label");
    expect(decision.blockers[0]).toContain("running");
    expect(decision.activeWorkers).toBe(1);
    expect(isSessionEndAllowed(decision)).toBe(false);
  });

  it("a queued worker also blocks — it can still act on the world", () => {
    const { runner } = deferredRunner();
    const manager = createSwarmManager({ maxConcurrentWorkers: 1 });
    manager.setRunner(runner);
    manager.spawn("occupies slot", "read-only");
    const queued = manager.spawn("waiting", "read-only");
    expect(manager.get(queued.id)?.state).toBe("queued");

    const decision = evaluateSessionEndGuard(buildFleetSnapshot({ manager, now: fixedNow }));
    expect(decision.outcome).toBe("needs_confirm");
    expect(decision.blockers[0]).toContain("queued");
    expect(decision.activeWorkers).toBe(2);
  });

  it("an in_progress self-build task blocks the end", () => {
    const { snapshot } = snapshotWith({
      selfBuildTasks: [
        { id: "wip-1", title: "Mid-cycle task", status: "in_progress" },
        { id: "t-ready", title: "Queued backlog", status: "ready" }
      ]
    });
    const decision = evaluateSessionEndGuard(snapshot());
    expect(decision.outcome).toBe("needs_confirm");
    expect(decision.reasons).toContain("self-build-in-progress");
    expect(decision.blockers[0]).toContain("wip-1");
    expect(decision.blockers[0]).toContain("in_progress");
    expect(decision.inProgressSelfBuild).toBe(1);
  });

  it("workers and self-build blockers compose into one needs_confirm decision", () => {
    const { runner } = deferredRunner();
    const manager = createSwarmManager({});
    manager.setRunner(runner);
    manager.spawn("live worker", "read-only");

    const snapshot = buildFleetSnapshot({
      manager,
      now: fixedNow,
      selfBuild: { tasks: [{ id: "wip", title: "Cycle", status: "in_progress" }] }
    });
    const decision = evaluateSessionEndGuard(snapshot);
    expect(decision.outcome).toBe("needs_confirm");
    expect(decision.reasons).toEqual(expect.arrayContaining(["active-workers", "self-build-in-progress"]));
    expect(decision.blockers).toHaveLength(2);
  });
});

describe("session end guard — explicit ways through", () => {
  it("force=true allows the end but keeps the live work visible in blockers", () => {
    const { runner } = deferredRunner();
    const manager = createSwarmManager({});
    manager.setRunner(runner);
    const worker = manager.spawn("forced past", "read-only");

    const decision = evaluateSessionEndGuard(buildFleetSnapshot({ manager, now: fixedNow }), { force: true });
    expect(decision.outcome).toBe("allow");
    expect(decision.reasons).toEqual(expect.arrayContaining(["active-workers", "forced"]));
    // The override is never blind: the abandoned worker is still named.
    expect(decision.blockers[0]).toContain(worker.id);
    expect(decision.activeWorkers).toBe(1);
    expect(isSessionEndAllowed(decision)).toBe(true);
  });

  it("the honest drain path: drain, re-snapshot, re-evaluate → allow", async () => {
    const { runner, release } = deferredRunner();
    const manager = createSwarmManager({});
    manager.setRunner(runner);
    manager.spawn("drain me", "read-only");

    const before = evaluateSessionEndGuard(buildFleetSnapshot({ manager, now: fixedNow }));
    expect(before.outcome).toBe("needs_confirm");

    release("drained");
    await manager.drain();

    const after = evaluateSessionEndGuard(buildFleetSnapshot({ manager, now: fixedNow }));
    expect(after.outcome).toBe("allow");
    expect(after.reasons).toEqual(["no-active-fleet-work"]);
  });

  it("there is no attestation bypass: an unknown request field is rejected by the schema", () => {
    const { runner } = deferredRunner();
    const manager = createSwarmManager({});
    manager.setRunner(runner);
    manager.spawn("live", "read-only");
    const snapshot = buildFleetSnapshot({ manager, now: fixedNow });
    // A hypothetical `drained: true` attestation must not exist on the strict schema.
    expect(() => evaluateSessionEndGuard(snapshot, { drained: true } as never)).toThrow();
    expect(evaluateSessionEndGuard(snapshot).outcome).toBe("needs_confirm");
  });
});

describe("session end guard — classifiers", () => {
  it("only in_progress is live for self-build tasks", () => {
    expect(LIVE_SELF_BUILD_STATUSES).toEqual(["in_progress"]);
    expect(isLiveSelfBuildStatus("in_progress")).toBe(true);
    expect(isLiveSelfBuildStatus("ready")).toBe(false);
    expect(isLiveSelfBuildStatus("blocked")).toBe(false);
    expect(isLiveSelfBuildStatus("done")).toBe(false);
    expect(isLiveSelfBuildStatus("skipped")).toBe(false);
  });
});

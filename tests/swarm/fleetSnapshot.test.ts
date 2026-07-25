import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildFleetSnapshot,
  isActiveSelfBuildStatus,
  isActiveWorkerState,
  listPacketDirNames,
  parseFleetSnapshot,
  renderFleetSnapshot,
  serializeFleetSnapshot
} from '../../src/swarm/fleetSnapshot.js';
import { createSwarmManager, type SwarmWorkerRequest } from '../../src/swarm/manager.js';

const FIXED_NOW = new Date("2026-07-18T12:00:00.000Z");
const fixedNow = () => FIXED_NOW;

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

const tempDirs: string[] = [];

function makePacketDir(files: readonly string[], subdirs: readonly string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "fleet-snapshot-"));
  tempDirs.push(dir);
  for (const file of files) {
    writeFileSync(join(dir, file), "packet body — contents must never reach the snapshot\n");
  }
  for (const subdir of subdirs) {
    mkdirSync(join(dir, subdir));
  }
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("fleet snapshot — struct and counts", () => {
  it("an empty fleet yields a zeroed, schema-valid snapshot", () => {
    const snapshot = buildFleetSnapshot({ manager: createSwarmManager({}), now: fixedNow });
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.updatedAt).toBe("2026-07-18T12:00:00.000Z");
    expect(snapshot.workers).toEqual([]);
    expect(snapshot.selfBuild).toEqual([]);
    expect(snapshot.openPackets).toEqual([]);
    expect(snapshot.counts).toEqual({
      workersTotal: 0,
      workersActive: 0,
      workersTerminal: 0,
      selfBuildTotal: 0,
      selfBuildOpen: 0,
      selfBuildTerminal: 0,
      openPackets: 0
    });
  });

  it("maps worker records into entries and splits active vs terminal counts", async () => {
    const { runner, release } = deferredRunner();
    const manager = createSwarmManager({ maxConcurrentWorkers: 1 });
    manager.setRunner(runner);
    const running = manager.spawn("job running", "all", "run-label");
    const queued = manager.spawn("job queued", "read-only");
    const doomed = manager.spawn("job to kill", "read-only");
    // Killed while still queued (slot occupied): never starts, no dangling runner promise.
    manager.kill(doomed.id);

    const midSnapshot = buildFleetSnapshot({ manager, now: fixedNow });
    expect(midSnapshot.counts.workersTotal).toBe(3);
    // running + queued are active; killed is terminal.
    expect(midSnapshot.counts.workersActive).toBe(2);
    expect(midSnapshot.counts.workersTerminal).toBe(1);

    const runningEntry = midSnapshot.workers.find((worker) => worker.taskId === running.id);
    expect(runningEntry?.state).toBe("running");
    expect(runningEntry?.label).toBe("run-label");
    expect(runningEntry?.mode).toBe("all");
    expect(runningEntry?.depth).toBe(0);
    expect(runningEntry?.endedAt).toBeUndefined();

    const killedEntry = midSnapshot.workers.find((worker) => worker.taskId === doomed.id);
    expect(killedEntry?.state).toBe("killed");
    expect(killedEntry?.endedAt).toBeDefined();

    release("a finished"); // running settles; the queued worker takes the slot on the next tick
    await new Promise((resolve) => setTimeout(resolve, 10));
    release("b finished"); // queued settles; killed worker never starts
    await manager.drain();

    const endSnapshot = buildFleetSnapshot({ manager, now: fixedNow });
    expect(endSnapshot.counts.workersActive).toBe(0);
    expect(endSnapshot.counts.workersTerminal).toBe(3);
    const doneEntry = endSnapshot.workers.find((worker) => worker.taskId === running.id);
    expect(doneEntry?.state).toBe("done");
    expect(doneEntry?.toolCallCount).toBe(1);
    expect(doneEntry?.endedAt).toBeDefined();
  });

  it("maps self-build tasks and splits open vs terminal counts", () => {
    const snapshot = buildFleetSnapshot({
      manager: createSwarmManager({}),
      now: fixedNow,
      selfBuild: {
        tasks: [
          { id: "t-ready", title: "Ready task", status: "ready", priority: "now" },
          { id: "t-wip", title: "In progress task", status: "in_progress" },
          { id: "t-blocked", title: "Blocked task", status: "blocked" },
          { id: "t-done", title: "Done task", status: "done" },
          { id: "t-skipped", title: "Skipped task", status: "skipped" }
        ]
      }
    });
    expect(snapshot.counts.selfBuildTotal).toBe(5);
    expect(snapshot.counts.selfBuildOpen).toBe(3); // ready + in_progress + blocked
    expect(snapshot.counts.selfBuildTerminal).toBe(2); // done + skipped
    const ready = snapshot.selfBuild.find((task) => task.taskId === "t-ready");
    expect(ready?.priority).toBe("now");
    const wip = snapshot.selfBuild.find((task) => task.taskId === "t-wip");
    expect(wip?.priority).toBeUndefined();
  });
});

describe("fleet snapshot — open packet dirs", () => {
  it("lists packet files by name across known dirs and ignores non-packets", () => {
    const dir = makePacketDir(["b-packet.json", "a-packet.md", "notes.txt"], ["nested.md"]);
    const snapshot = buildFleetSnapshot({ manager: createSwarmManager({}), now: fixedNow, packetDirs: [dir] });
    expect(snapshot.counts.openPackets).toBe(2);
    // Sorted names; .txt and directories named *.md are excluded.
    expect(snapshot.openPackets.map((packet) => packet.name)).toEqual(["a-packet.md", "b-packet.json"]);
    expect(snapshot.openPackets.every((packet) => packet.source === dir)).toBe(true);
  });

  it("a missing or unreadable packet dir is skipped honestly, not an error", () => {
    const real = makePacketDir(["one.md"]);
    const snapshot = buildFleetSnapshot({
      manager: createSwarmManager({}),
      now: fixedNow,
      packetDirs: [join(tmpdir(), "fleet-snapshot-does-not-exist"), real]
    });
    expect(snapshot.counts.openPackets).toBe(1);
    expect(snapshot.openPackets[0]?.name).toBe("one.md");
  });

  it("snapshot is names-only: packet file contents never appear in the serialized form", () => {
    const dir = makePacketDir(["secretish.md"]);
    writeFileSync(join(dir, "secretish.md"), "SK-LEAK-ME-NOT-1234567890\n");
    const snapshot = buildFleetSnapshot({ manager: createSwarmManager({}), now: fixedNow, packetDirs: [dir] });
    const serialized = serializeFleetSnapshot(snapshot);
    expect(serialized).toContain("secretish.md");
    expect(serialized).not.toContain("SK-LEAK-ME-NOT-1234567890");
  });

  it("listPacketDirNames returns names only", () => {
    const dir = makePacketDir(["x.md", "y.json", "z.txt"]);
    expect(listPacketDirNames(dir)).toEqual(["x.md", "y.json"]);
  });
});

describe("fleet snapshot — rendering and round-trip", () => {
  it("renders one line per section with counts and entries", () => {
    const dir = makePacketDir(["pack.md"]);
    const { runner } = deferredRunner();
    const manager = createSwarmManager({});
    manager.setRunner(runner);
    manager.spawn("render job", "read-only", "render-label");
    const snapshot = buildFleetSnapshot({
      manager,
      now: fixedNow,
      packetDirs: [dir],
      selfBuild: { tasks: [{ id: "t1", title: "Task one", status: "ready" }] }
    });
    const rendered = renderFleetSnapshot(snapshot);
    expect(rendered).toContain("Fleet snapshot (2026-07-18T12:00:00.000Z)");
    expect(rendered).toContain("workers: 1 active / 1 total");
    expect(rendered).toContain("[running] render-label");
    expect(rendered).toContain("self-build: 1 open / 1 total");
    expect(rendered).toContain("t1 [ready] Task one");
    expect(rendered).toContain("open packets: 1");
    expect(rendered).toContain("pack.md");
  });

  it("serialize → parse round-trips through the schema", () => {
    const manager = createSwarmManager({});
    manager.spawn("round trip", "read-only");
    const snapshot = buildFleetSnapshot({ manager, now: fixedNow });
    const parsed = parseFleetSnapshot(serializeFleetSnapshot(snapshot));
    expect(parsed).toEqual(snapshot);
  });
});

describe("fleet snapshot — state classifiers", () => {
  it("queued/running are active; done/failed/killed are terminal", () => {
    expect(isActiveWorkerState("queued")).toBe(true);
    expect(isActiveWorkerState("running")).toBe(true);
    expect(isActiveWorkerState("done")).toBe(false);
    expect(isActiveWorkerState("failed")).toBe(false);
    expect(isActiveWorkerState("killed")).toBe(false);
  });

  it("ready/in_progress/blocked are open; done/skipped are terminal", () => {
    expect(isActiveSelfBuildStatus("ready")).toBe(true);
    expect(isActiveSelfBuildStatus("in_progress")).toBe(true);
    expect(isActiveSelfBuildStatus("blocked")).toBe(true);
    expect(isActiveSelfBuildStatus("done")).toBe(false);
    expect(isActiveSelfBuildStatus("skipped")).toBe(false);
    expect(isActiveSelfBuildStatus("unknown-future-status")).toBe(false);
  });
});

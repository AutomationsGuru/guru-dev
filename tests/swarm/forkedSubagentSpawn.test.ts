import { describe, expect, it } from "vitest";

import { createForkedSubagentSpawner } from '../../src/swarm/forkedSubagentSpawn.js';

describe("forked subagent spawn (IDEA-F186-FORK-SUB-01)", () => {
  it("fork(parentId) returns a childId plus a snapshotRef cloned from the parent", () => {
    const spawner = createForkedSubagentSpawner();
    const result = spawner.fork("parent-1");
    expect(result.childId).toBeTruthy();
    expect(result.snapshotRef).toBeTruthy();
    expect(result.childId).not.toBe(result.snapshotRef);
    expect(result.childId).not.toBe("parent-1");
  });

  it("each fork produces a unique child id and a unique snapshot ref", () => {
    const spawner = createForkedSubagentSpawner();
    const a = spawner.fork("parent-1");
    const b = spawner.fork("parent-1");
    expect(a.childId).not.toBe(b.childId);
    expect(a.snapshotRef).not.toBe(b.snapshotRef);
  });

  it("the snapshot is recorded under the new ref and resolvable later", () => {
    const spawner = createForkedSubagentSpawner();
    const result = spawner.fork("parent-1");
    expect(spawner.snapshotParent(result.snapshotRef)).toBe("parent-1");
    expect(spawner.snapshotParent("unknown-ref")).toBeUndefined();
  });

  it("rejects a blank parent id honestly (no silent fork)", () => {
    const spawner = createForkedSubagentSpawner();
    expect(() => spawner.fork("")).toThrow();
    expect(() => spawner.fork("   ")).toThrow();
  });
});

import { describe, expect, it } from "vitest";

import { AgentHealthSnapshotInputSchema, buildAgentHealthSnapshot } from '../../src/fleet/agentHealthSnapshot.js';
import type { AgentHealthSnapshotInput } from '../../src/fleet/agentHealthSnapshot.js';

function baseInput(overrides: Partial<AgentHealthSnapshotInput> = {}): AgentHealthSnapshotInput {
  return {
    sessionId: "sess-123",
    state: "running",
    queueDepth: 0,
    toolCallCount: 0,
    ...overrides
  };
}

describe("agentHealthSnapshot — schema", () => {
  it("rejects missing required fields", () => {
    expect(() => AgentHealthSnapshotInputSchema.parse({})).toThrow();
    expect(() => AgentHealthSnapshotInputSchema.parse({ sessionId: "x" })).toThrow();
  });

  it("rejects unknown fields (strict)", () => {
    expect(() =>
      AgentHealthSnapshotInputSchema.parse({ sessionId: "x", state: "running", queueDepth: 0, toolCallCount: 0, mystery: true })
    ).toThrow();
  });

  it("accepts a healthy running session with zero queue depth", () => {
    const parsed = AgentHealthSnapshotInputSchema.parse({
      sessionId: "s1",
      state: "running",
      queueDepth: 0,
      toolCallCount: 7
    });
    expect(parsed.sessionId).toBe("s1");
    expect(parsed.state).toBe("running");
    expect(parsed.queueDepth).toBe(0);
    expect(parsed.toolCallCount).toBe(7);
  });
});

describe("buildAgentHealthSnapshot — empty fleet", () => {
  it("returns an empty snapshots array with a captured updatedAt", async () => {
    const snap = buildAgentHealthSnapshot({ agents: [] });
    expect(snap.snapshots).toEqual([]);
    expect(typeof snap.updatedAt).toBe("string");
    // ISO-8601 sanity — must round-trip through Date without NaN.
    expect(Number.isNaN(new Date(snap.updatedAt).getTime())).toBe(false);
    // updatedAt should reflect roughly "now" — within 2s of the test wall clock.
    const drift = Math.abs(Date.now() - new Date(snap.updatedAt).getTime());
    expect(drift).toBeLessThan(2_000);
  });
});

describe("buildAgentHealthSnapshot — error field set", () => {
  it("includes lastError on a failed agent; omits lastError on a healthy agent", () => {
    const failed = baseInput({
      state: "failed",
      error: "model timeout: no route replied within 30s",
      toolCallCount: 2
    });
    const healthy = baseInput({ state: "done", toolCallCount: 9 });
    const queued = baseInput({ state: "queued", queueDepth: 3 });

    const snap = buildAgentHealthSnapshot({ agents: [failed, healthy, queued] });

    expect(snap.snapshots).toHaveLength(3);

    const failedSnap = snap.snapshots[0]!;
    expect(failedSnap).toMatchObject({
      sessionId: "sess-123",
      status: "failed",
      queueDepth: 0,
      lastError: "model timeout: no route replied within 30s"
    });

    const healthySnap = snap.snapshots[1]!;
    expect(healthySnap).toMatchObject({
      sessionId: "sess-123",
      status: "done",
      queueDepth: 0
    });
    expect(healthySnap.lastError).toBeUndefined();

    const queuedSnap = snap.snapshots[2]!;
    expect(queuedSnap).toMatchObject({
      sessionId: "sess-123",
      status: "queued",
      queueDepth: 3
    });
    expect(queuedSnap.lastError).toBeUndefined();
  });

  it("carries an updatedAt timestamp on every snapshot", () => {
    const snap = buildAgentHealthSnapshot({
      agents: [baseInput({ sessionId: "a" }), baseInput({ sessionId: "b" })]
    });
    for (const entry of snap.snapshots) {
      expect(typeof entry.updatedAt).toBe("string");
      expect(Number.isNaN(new Date(entry.updatedAt).getTime())).toBe(false);
    }
  });
});

describe("buildAgentHealthSnapshot — input shape", () => {
  it("the operator-facing fields are the strict subset {sessionId, status, queueDepth, updatedAt} plus lastError when set — no internals leaked", () => {
    const healthySnap = buildAgentHealthSnapshot({
      agents: [baseInput({ state: "running", toolCallCount: 11 })]
    }).snapshots[0];
    expect(healthySnap).not.toBeNull();
    if (!healthySnap) return;
    // healthy: no internals, no lastError
    const healthyKeys = Object.keys(healthySnap).sort();
    expect(healthyKeys).not.toContain("toolCallCount");
    expect(healthyKeys).not.toContain("state");
    expect(healthyKeys).not.toContain("error");
    expect(healthyKeys).toEqual(["queueDepth", "sessionId", "status", "updatedAt"].sort());

    // errored: adds exactly lastError, nothing else
    const erroredSnap = buildAgentHealthSnapshot({
      agents: [baseInput({ state: "failed", error: "boom", toolCallCount: 3 })]
    }).snapshots[0];
    expect(erroredSnap).not.toBeNull();
    if (!erroredSnap) return;
    const erroredKeys = Object.keys(erroredSnap).sort();
    expect(erroredKeys).toEqual(
      ["lastError", "queueDepth", "sessionId", "status", "updatedAt"].sort()
    );
  });
});

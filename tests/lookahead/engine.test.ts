import { describe, expect, it, vi } from "vitest";

import { createLookAheadEngine, type ForkEnumerator, type ScoutSpawn } from "../../src/lookahead/engine.js";
import { createForkEnumerator } from "../../src/lookahead/forks.js";
import { LookAheadConfigSchema } from "../../src/lookahead/schema.js";

const forks: ForkEnumerator = (toolId, k) =>
  [
    { triggerCondition: `${toolId} failed error`, prompt: "fix and retry" },
    { triggerCondition: `${toolId} blocked policy`, prompt: "explain the gate" },
    { triggerCondition: `${toolId} empty result`, prompt: "try a different query" }
  ].slice(0, k);

function trackingSpawn(): { spawn: ScoutSpawn; spawned: () => number } {
  let n = 0;
  return { spawn: () => ({ taskId: `t${(n += 1)}` }), spawned: () => n };
}

describe("look-ahead config — hard caps", () => {
  it("defaults off; forkWidth/leadDepth/budget bounded", () => {
    const config = LookAheadConfigSchema.parse({});
    expect(config.enabled).toBe(false);
    expect(config.leadDepth).toBeLessThanOrEqual(3);
    expect(() => LookAheadConfigSchema.parse({ forkWidth: 99 })).toThrow();
  });
});

describe("the LAW: scouts run ONLY when enabled AND in dead time", () => {
  it("disabled engine never spawns (byte-identical to the plain loop)", () => {
    const { spawn, spawned } = trackingSpawn();
    const engine = createLookAheadEngine({ config: { enabled: false }, spawnScout: spawn, enumerateForks: forks });
    expect(engine.scoutPendingStep("bash", { inDeadTime: true })).toEqual([]);
    expect(spawned()).toBe(0);
  });

  it("enabled but NOT in dead time never spawns", () => {
    const { spawn, spawned } = trackingSpawn();
    const engine = createLookAheadEngine({ config: { enabled: true }, spawnScout: spawn, enumerateForks: forks });
    expect(engine.scoutPendingStep("bash", { inDeadTime: false })).toEqual([]);
    expect(engine.scoutPendingStep("bash")).toEqual([]); // no signal = not dead time
    expect(spawned()).toBe(0);
  });

  it("enabled + dead time + allowlisted spawns up to forkWidth read-only scouts", () => {
    const { spawn, spawned } = trackingSpawn();
    const engine = createLookAheadEngine({ config: { enabled: true, forkWidth: 2, idempotentAllowlist: ["bash"] }, spawnScout: spawn, enumerateForks: forks });
    const branches = engine.scoutPendingStep("bash", { inDeadTime: true });
    expect(branches).toHaveLength(2);
    expect(spawned()).toBe(2);
    expect(branches.every((branch) => branch.state === "open")).toBe(true);
  });
});

describe("fall-through: HIT promotes a warm hint, MISS degrades", () => {
  it("HIT — reality matches a pre-explored fork → warm hint + others pruned", () => {
    const { spawn } = trackingSpawn();
    const resolved = vi.fn();
    const engine = createLookAheadEngine({ config: { enabled: true, forkWidth: 3, idempotentAllowlist: ["bash"] }, spawnScout: spawn, enumerateForks: forks, onBranchResolved: resolved });
    engine.scoutPendingStep("bash", { inDeadTime: true });
    const match = engine.matchBranch({ toolId: "bash", status: "failed", detail: "command failed with error 1" });
    expect(match.outcome).toBe("hit");
    expect(match.warmHint).toContain("scout foresaw this fork");
    expect(match.warmHint).toContain("fix and retry");
    expect(engine.openBranches()).toHaveLength(0); // losers pruned
    expect(resolved).toHaveBeenCalledWith(expect.objectContaining({ outcome: "hit" }));
  });

  it("MISS — reality did something no scout foresaw → degrade silently, log blind fork", () => {
    const { spawn } = trackingSpawn();
    const resolved = vi.fn();
    const engine = createLookAheadEngine({ config: { enabled: true, idempotentAllowlist: ["bash"] }, spawnScout: spawn, enumerateForks: () => [{ triggerCondition: "network timeout upstream", prompt: "x" }], onBranchResolved: resolved });
    engine.scoutPendingStep("bash", { inDeadTime: true });
    const match = engine.matchBranch({ toolId: "bash", status: "succeeded", detail: "everything fine" });
    expect(match.outcome).toBe("miss");
    expect(match.warmHint).toBeUndefined();
    expect(engine.openBranches()).toHaveLength(0);
    expect(resolved).toHaveBeenCalledWith(expect.objectContaining({ outcome: "miss" }));
  });

  it("reset clears branches at a turn boundary", () => {
    const { spawn } = trackingSpawn();
    const engine = createLookAheadEngine({ config: { enabled: true, idempotentAllowlist: ["bash"] }, spawnScout: spawn, enumerateForks: forks });
    engine.scoutPendingStep("bash", { inDeadTime: true });
    expect(engine.openBranches().length).toBeGreaterThan(0);
    engine.reset();
    expect(engine.openBranches()).toHaveLength(0);
  });
});

describe("the GOVERNOR (§17 scenario 8): allowlist + session budget + miss-rate throttle", () => {
  it("idempotency allowlist defaults to NOTHING — enabled + dead time still speculates zero", () => {
    const { spawn, spawned } = trackingSpawn();
    const engine = createLookAheadEngine({ config: { enabled: true }, spawnScout: spawn, enumerateForks: forks });
    expect(engine.scoutPendingStep("bash", { inDeadTime: true })).toEqual([]); // "bash" not allowlisted
    expect(spawned()).toBe(0);
    expect(engine.stats().lastSkip).toContain("not in the idempotency allowlist");
    // Only an allowlisted step is speculated.
    expect(engine.scoutPendingStep("grep", { inDeadTime: true })).toEqual([]);
  });

  it("per-session scout budget is a HARD cap and is never silently exceeded", () => {
    const { spawn, spawned } = trackingSpawn();
    const engine = createLookAheadEngine({
      config: { enabled: true, forkWidth: 3, idempotentAllowlist: ["bash"], maxScoutsPerSession: 4 },
      spawnScout: spawn,
      enumerateForks: forks
    });
    engine.scoutPendingStep("bash", { inDeadTime: true }); // spawns 3
    const second = engine.scoutPendingStep("bash", { inDeadTime: true }); // budget leaves 1 → spawns 1
    expect(spawned()).toBe(4);
    expect(second).toHaveLength(1);
    expect(engine.scoutPendingStep("bash", { inDeadTime: true })).toEqual([]); // exhausted
    expect(engine.stats().budgetRemaining).toBe(0);
    expect(engine.stats().lastSkip).toContain("budget exhausted");
  });

  it("miss-rate throttle engages after the min sample and stops further speculation", () => {
    const { spawn } = trackingSpawn();
    const engine = createLookAheadEngine({
      config: { enabled: true, forkWidth: 1, idempotentAllowlist: ["bash"], missRateThreshold: 0.5, minSamplesBeforeThrottle: 3, maxScoutsPerSession: 100 },
      spawnScout: spawn,
      enumerateForks: () => [{ triggerCondition: "totally-unrelated-fork", prompt: "x" }]
    });
    // Four rounds, each a MISS (the real result never matches the fork).
    for (let i = 0; i < 4; i += 1) {
      engine.scoutPendingStep("bash", { inDeadTime: true });
      engine.matchBranch({ toolId: "bash", status: "succeeded", detail: "no match here" });
    }
    const stats = engine.stats();
    expect(stats.misses).toBe(4);
    expect(stats.missRate).toBe(1);
    expect(stats.throttled).toBe(true);
    // Now throttled → no more scouts even though budget + allowlist are fine.
    expect(engine.scoutPendingStep("bash", { inDeadTime: true })).toEqual([]);
    expect(engine.stats().lastSkip).toContain("throttled");
  });

  it("stats() reports hits/misses; a healthy hit rate does NOT throttle", () => {
    const { spawn } = trackingSpawn();
    const engine = createLookAheadEngine({
      config: { enabled: true, forkWidth: 1, idempotentAllowlist: ["bash"], minSamplesBeforeThrottle: 3 },
      spawnScout: spawn,
      enumerateForks: () => [{ triggerCondition: "bash failed error", prompt: "retry" }]
    });
    for (let i = 0; i < 4; i += 1) {
      engine.scoutPendingStep("bash", { inDeadTime: true });
      engine.matchBranch({ toolId: "bash", status: "failed", detail: "bash failed error" }); // HIT
    }
    expect(engine.stats().hits).toBe(4);
    expect(engine.stats().throttled).toBe(false);
  });
});

describe("fork enumerator — failure surface + garage priors", () => {
  it("returns tool-specific forks and never throws without memory", () => {
    const enumerate = createForkEnumerator();
    const bash = enumerate("bash", 3);
    expect(bash.length).toBeGreaterThan(0);
    expect(bash[0]?.triggerCondition).toContain("bash");
    expect(enumerate("some_unknown_tool", 3).length).toBeGreaterThan(0); // default fork
  });
});

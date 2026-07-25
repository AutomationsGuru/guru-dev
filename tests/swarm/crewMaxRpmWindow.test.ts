import { describe, expect, it } from "vitest";

import { createCrewMaxRpmWindow } from '../../src/swarm/crewMaxRpmWindow.js';

describe("crew max RPM window — sliding-window per-agent rate cap", () => {
  it("allows requests under the cap", () => {
    const window = createCrewMaxRpmWindow();
    expect(window.tryConsume("agent-a", 1_000, 3)).toBe(true);
    expect(window.tryConsume("agent-a", 2_000, 3)).toBe(true);
    expect(window.tryConsume("agent-a", 3_000, 3)).toBe(true);
  });

  it("rejects once the agent is at the cap, and does not record the rejected request", () => {
    const window = createCrewMaxRpmWindow();
    expect(window.tryConsume("agent-a", 1_000, 2)).toBe(true);
    expect(window.tryConsume("agent-a", 2_000, 2)).toBe(true);
    // Third request inside the window: at cap → reject.
    expect(window.tryConsume("agent-a", 3_000, 2)).toBe(false);
    // A rejected request must NOT consume budget: after the oldest request
    // ages out, the next request succeeds on the first try.
    expect(window.tryConsume("agent-a", 61_001, 2)).toBe(true);
    expect(window.tryConsume("agent-a", 62_001, 2)).toBe(true);
    expect(window.tryConsume("agent-a", 62_002, 2)).toBe(false);
  });

  it("counts only requests inside the sliding window (older than 60s are pruned)", () => {
    const window = createCrewMaxRpmWindow();
    expect(window.tryConsume("agent-a", 1_000, 1)).toBe(true);
    expect(window.tryConsume("agent-a", 2_000, 1)).toBe(false);
    // 61s later the first request is outside [nowMs - 60_000, nowMs].
    expect(window.tryConsume("agent-a", 62_000, 1)).toBe(true);
  });

  it("treats the window as INCLUSIVE of nowMs - 60_000 (a request exactly 60s old still counts)", () => {
    const window = createCrewMaxRpmWindow();
    expect(window.tryConsume("agent-a", 10_000, 1)).toBe(true);
    // nowMs - 60_000 === 10_000 exactly: the prior request is still in-window.
    expect(window.tryConsume("agent-a", 70_000, 1)).toBe(false);
    // One ms later it is out of window.
    expect(window.tryConsume("agent-a", 70_001, 1)).toBe(true);
  });

  it("isolates windows per agent", () => {
    const window = createCrewMaxRpmWindow();
    expect(window.tryConsume("agent-a", 1_000, 1)).toBe(true);
    expect(window.tryConsume("agent-a", 1_001, 1)).toBe(false);
    // agent-b has its own budget at the same timestamps.
    expect(window.tryConsume("agent-b", 1_000, 1)).toBe(true);
    expect(window.tryConsume("agent-b", 1_001, 1)).toBe(false);
  });

  it("rejects everything when maxRpm is non-positive", () => {
    const window = createCrewMaxRpmWindow();
    expect(window.tryConsume("agent-a", 1_000, 0)).toBe(false);
    expect(window.tryConsume("agent-a", 1_000, -5)).toBe(false);
    // Rejected non-positive calls do not build up history either.
    expect(window.tryConsume("agent-a", 1_001, 1)).toBe(true);
  });

  it("prunes aged-out entries so memory stays bounded", () => {
    const window = createCrewMaxRpmWindow();
    for (let i = 0; i < 1_000; i += 1) {
      expect(window.tryConsume("agent-a", i, 1_000)).toBe(true);
    }
    // A call far in the future prunes the whole history; the cap applies fresh.
    expect(window.tryConsume("agent-a", 1_000_000, 1)).toBe(true);
    // And a brand-new agent id seen only long ago behaves like a fresh agent.
    expect(window.tryConsume("agent-stale", 500, 1)).toBe(true);
    expect(window.tryConsume("agent-stale", 1_000_000, 1)).toBe(true);
  });

  it("honours maxRpm as a per-call parameter (cap can change between calls)", () => {
    const window = createCrewMaxRpmWindow();
    expect(window.tryConsume("agent-a", 1_000, 2)).toBe(true);
    expect(window.tryConsume("agent-a", 2_000, 2)).toBe(true);
    expect(window.tryConsume("agent-a", 3_000, 2)).toBe(false);
    // Raising the cap lets more through against the same history.
    expect(window.tryConsume("agent-a", 3_000, 3)).toBe(true);
    expect(window.tryConsume("agent-a", 3_001, 3)).toBe(false);
  });
});

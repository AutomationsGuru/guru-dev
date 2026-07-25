import { describe, expect, it } from "vitest";

import { createEligibilityGate } from '../../src/lookahead/eligibility.js';
import { createMissMonitor } from '../../src/lookahead/missMonitor.js';

describe("eligibility gate", () => {
  it("default allowlist is empty → every task is denied", () => {
    const gate = createEligibilityGate();
    expect(gate.allowlist().tags).toEqual([]);
    expect(gate.allowlist().toolIds).toEqual([]);

    const decision = gate.decide({ toolId: "bash" });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("not in lookahead allowlist");
  });

  it("allowlists a task by toolId", () => {
    const gate = createEligibilityGate({ toolIds: ["bash", "grep"] });
    const allowed = gate.decide({ toolId: "bash" });
    expect(allowed.allowed).toBe(true);
    expect(allowed.reason).toContain("toolId");

    const denied = gate.decide({ toolId: "write" });
    expect(denied.allowed).toBe(false);
  });

  it("allowlists a task by tag", () => {
    const gate = createEligibilityGate({ tags: ["read-only", "idempotent"] });
    const allowed = gate.decide({ toolId: "unknown", tags: ["read-only"] });
    expect(allowed.allowed).toBe(true);
    expect(allowed.reason).toContain("tag");

    const denied = gate.decide({ toolId: "unknown", tags: ["mutating"] });
    expect(denied.allowed).toBe(false);
  });

  it("toolId matches take precedence over tags in reason only; both grant access", () => {
    const gate = createEligibilityGate({ toolIds: ["bash"], tags: ["safe"] });
    const toolHit = gate.decide({ toolId: "bash", tags: ["unsafe"] });
    expect(toolHit.allowed).toBe(true);
    expect(toolHit.reason).toContain("toolId");

    const tagHit = gate.decide({ toolId: "ls", tags: ["safe"] });
    expect(tagHit.allowed).toBe(true);
    expect(tagHit.reason).toContain("tag");
  });
});

describe("miss monitor", () => {
  it("starts at zero", () => {
    const monitor = createMissMonitor();
    expect(monitor.stats().total).toBe(0);
    expect(monitor.records()).toEqual([]);
  });

  it("records a miss and reports the count", () => {
    const monitor = createMissMonitor();
    monitor.record("bash", ["read-only"]);
    monitor.record("edit");
    expect(monitor.stats().total).toBe(2);

    const records = monitor.records();
    expect(records).toHaveLength(2);
    expect(records[0]?.toolId).toBe("bash");
    expect(records[1]?.toolId).toBe("edit");
  });

  it("reset clears session-scoped counters", () => {
    const monitor = createMissMonitor();
    monitor.record("bash");
    monitor.reset();
    expect(monitor.stats().total).toBe(0);
    expect(monitor.records()).toEqual([]);
  });
});

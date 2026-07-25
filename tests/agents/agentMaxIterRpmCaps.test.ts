import { describe, expect, it } from "vitest";

import {
  AgentCapsSchema,
  initialCapState,
  mayContinue,
  recordRequest,
  rollWindow,
  RPM_WINDOW_MS,
  type AgentCapState
} from '../../src/agents/agentMaxIterRpmCaps.js';

const T0 = 1_000_000;

describe("agentMaxIterRpmCaps / maxIter", () => {
  it("stops when iteration reaches maxIter with reason max_iter_exceeded", () => {
    const state: AgentCapState = { iteration: 5, windowStartedAtMs: T0, requestsInWindow: 0 };
    const decision = mayContinue(state, { maxIter: 5 }, T0);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("max_iter_exceeded");
  });

  it("stops when iteration exceeds maxIter", () => {
    const state: AgentCapState = { iteration: 7, windowStartedAtMs: T0, requestsInWindow: 0 };
    const decision = mayContinue(state, { maxIter: 5 }, T0);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("max_iter_exceeded");
  });

  it("allows while iteration is below maxIter", () => {
    const state: AgentCapState = { iteration: 4, windowStartedAtMs: T0, requestsInWindow: 0 };
    const decision = mayContinue(state, { maxIter: 5 }, T0);
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBeUndefined();
  });
});

describe("agentMaxIterRpmCaps / maxRpm", () => {
  it("stops when requestsInWindow reaches maxRpm inside the window", () => {
    const state: AgentCapState = { iteration: 0, windowStartedAtMs: T0, requestsInWindow: 10 };
    const decision = mayContinue(state, { maxRpm: 10 }, T0 + 30_000);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("max_rpm_exceeded");
    expect(decision.windowRolled).toBe(false);
  });

  it("allows while requestsInWindow is below maxRpm inside the window", () => {
    const state: AgentCapState = { iteration: 0, windowStartedAtMs: T0, requestsInWindow: 9 };
    const decision = mayContinue(state, { maxRpm: 10 }, T0 + 59_999);
    expect(decision.allowed).toBe(true);
    expect(decision.windowRolled).toBe(false);
  });

  it("allows and reports windowRolled when the 60s window has passed even at the rpm cap", () => {
    const state: AgentCapState = { iteration: 0, windowStartedAtMs: T0, requestsInWindow: 10 };
    const decision = mayContinue(state, { maxRpm: 10 }, T0 + RPM_WINDOW_MS + 1);
    expect(decision.allowed).toBe(true);
    expect(decision.windowRolled).toBe(true);
  });

  it("treats exactly 60_000ms elapsed as rolled (>= semantics)", () => {
    const state: AgentCapState = { iteration: 0, windowStartedAtMs: T0, requestsInWindow: 10 };
    const decision = mayContinue(state, { maxRpm: 10 }, T0 + RPM_WINDOW_MS);
    expect(decision.allowed).toBe(true);
    expect(decision.windowRolled).toBe(true);
  });
});

describe("agentMaxIterRpmCaps / no caps and precedence", () => {
  it("always allows when no caps are set", () => {
    const state: AgentCapState = { iteration: 1_000_000, windowStartedAtMs: T0, requestsInWindow: 1_000_000 };
    const decision = mayContinue(state, {}, T0 + 500);
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBeUndefined();
  });

  it("evaluates maxIter before maxRpm when both would trip", () => {
    const state: AgentCapState = { iteration: 5, windowStartedAtMs: T0, requestsInWindow: 10 };
    const decision = mayContinue(state, { maxIter: 5, maxRpm: 10 }, T0 + 1_000);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("max_iter_exceeded");
  });
});

describe("agentMaxIterRpmCaps / AgentCapsSchema", () => {
  it("accepts a fully populated caps object", () => {
    expect(AgentCapsSchema.parse({ maxIter: 25, maxRpm: 60 })).toEqual({ maxIter: 25, maxRpm: 60 });
  });

  it("accepts partial and empty caps (absent cap = no limit)", () => {
    expect(AgentCapsSchema.parse({ maxIter: 3 })).toEqual({ maxIter: 3 });
    expect(AgentCapsSchema.parse({})).toEqual({});
  });

  it("rejects non-positive or non-integer caps", () => {
    expect(() => AgentCapsSchema.parse({ maxIter: 0 })).toThrow();
    expect(() => AgentCapsSchema.parse({ maxIter: -1 })).toThrow();
    expect(() => AgentCapsSchema.parse({ maxRpm: 2.5 })).toThrow();
    expect(() => AgentCapsSchema.parse({ maxRpm: "60" })).toThrow();
  });
});

describe("agentMaxIterRpmCaps / counter helpers", () => {
  it("initialCapState seeds a zeroed counter window at nowMs", () => {
    const state = initialCapState(T0);
    expect(state).toEqual({ iteration: 0, windowStartedAtMs: T0, requestsInWindow: 0 });
  });

  it("recordRequest returns new state with incremented counters and leaves the original unchanged", () => {
    const state: AgentCapState = { iteration: 2, windowStartedAtMs: T0, requestsInWindow: 3 };
    const next = recordRequest(state, T0 + 1_000);
    expect(next).toEqual({ iteration: 3, windowStartedAtMs: T0, requestsInWindow: 4 });
    expect(state).toEqual({ iteration: 2, windowStartedAtMs: T0, requestsInWindow: 3 });
    expect(next).not.toBe(state);
  });

  it("recordRequest rolls the window when 60s have elapsed", () => {
    const state: AgentCapState = { iteration: 2, windowStartedAtMs: T0, requestsInWindow: 9 };
    const next = recordRequest(state, T0 + RPM_WINDOW_MS);
    expect(next).toEqual({ iteration: 3, windowStartedAtMs: T0 + RPM_WINDOW_MS, requestsInWindow: 1 });
    expect(state).toEqual({ iteration: 2, windowStartedAtMs: T0, requestsInWindow: 9 });
  });

  it("rollWindow returns fresh zeroed rpm state and leaves the original unchanged", () => {
    const state: AgentCapState = { iteration: 4, windowStartedAtMs: T0, requestsInWindow: 7 };
    const rolled = rollWindow(state, T0 + 60_001);
    expect(rolled).toEqual({ iteration: 4, windowStartedAtMs: T0 + 60_001, requestsInWindow: 0 });
    expect(state).toEqual({ iteration: 4, windowStartedAtMs: T0, requestsInWindow: 7 });
    expect(rolled).not.toBe(state);
  });

  it("rollWindow is a no-op copy when the window has not elapsed", () => {
    const state: AgentCapState = { iteration: 4, windowStartedAtMs: T0, requestsInWindow: 7 };
    const rolled = rollWindow(state, T0 + 10_000);
    expect(rolled).toEqual(state);
    expect(rolled).not.toBe(state);
  });
});

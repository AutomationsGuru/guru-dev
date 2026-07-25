import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  approveSpec,
  assertImplementAllowed,
  enterPlanOnly,
  getSpecHandoffState,
  hardLimitsAlwaysBind,
  mayMutate,
  resetSpecHandoff
} from '../../src/mandates/specAutonomyHandoff.js';

describe("specAutonomyHandoff — F129 / R-FD-SPEC", () => {
  beforeEach(() => {
    resetSpecHandoff();
  });
  afterEach(() => {
    resetSpecHandoff();
  });

  it("defaults to plan-only, not approved, medium autonomy, hard limits enforced", () => {
    const state = getSpecHandoffState();
    expect(state.phase).toBe("plan-only");
    expect(state.approved).toBe(false);
    expect(state.autonomy).toBe("medium");
    expect(state.hardLimitsEnforced).toBe(true);
    expect(mayMutate()).toBe(false);
    expect(hardLimitsAlwaysBind()).toBe(true);
  });

  it("approveSpec('keep') while plan-only → implement, autonomy unchanged (keep current)", () => {
    const result = approveSpec("keep");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.previous.phase).toBe("plan-only");
    expect(result.state.phase).toBe("implement");
    expect(result.state.approved).toBe(true);
    expect(result.state.autonomy).toBe("medium"); // default preserved by keep
    expect(result.state.hardLimitsEnforced).toBe(true);
    expect(mayMutate()).toBe(true);
  });

  it("enterPlanOnly(low) then approveSpec keep → implement at low", () => {
    enterPlanOnly("low");
    expect(getSpecHandoffState()).toMatchObject({
      phase: "plan-only",
      autonomy: "low",
      approved: false
    });
    const result = approveSpec({ level: "keep" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toMatchObject({
      phase: "implement",
      autonomy: "low",
      approved: true,
      hardLimitsEnforced: true
    });
  });

  it("approveSpec('medium') raises autonomy to medium and implements", () => {
    enterPlanOnly("low");
    const result = approveSpec("medium");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.previous.autonomy).toBe("low");
    expect(result.state.phase).toBe("implement");
    expect(result.state.autonomy).toBe("medium");
    expect(result.state.approved).toBe(true);
  });

  it("while plan-only, assertImplementAllowed and mayMutate reject", () => {
    expect(mayMutate()).toBe(false);
    const gate = assertImplementAllowed();
    expect(gate.allowed).toBe(false);
    if (gate.allowed) return;
    expect(gate.reason).toContain("plan-only");
    expect(gate.reason).toContain("approveSpec");
    expect(gate.state.phase).toBe("plan-only");
  });

  it("after approve, mayMutate true and assertImplementAllowed allows", () => {
    approveSpec("high");
    expect(mayMutate()).toBe(true);
    const gate = assertImplementAllowed();
    expect(gate.allowed).toBe(true);
    if (!gate.allowed) return;
    expect(gate.state.phase).toBe("implement");
    expect(gate.state.autonomy).toBe("high");
  });

  it("deny invalid autonomy choices (fail closed, state unchanged)", () => {
    const before = getSpecHandoffState();
    for (const bad of ["yolo", "", "off", "ultra", "KEEP", 3, null, undefined] as unknown[]) {
      const result = approveSpec(bad as "keep");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toMatch(/invalid autonomy choice/i);
      expect(result.state).toEqual(before);
    }
    // still plan-only — no silent approval
    expect(getSpecHandoffState()).toEqual(before);
    expect(mayMutate()).toBe(false);
  });

  it("high autonomy still has hardLimitsEnforced true", () => {
    const result = approveSpec("high");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.autonomy).toBe("high");
    expect(result.state.hardLimitsEnforced).toBe(true);
    expect(hardLimitsAlwaysBind()).toBe(true);
  });

  it("re-approval while implement may change autonomy", () => {
    approveSpec("low");
    const again = approveSpec("high");
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.previous.autonomy).toBe("low");
    expect(again.state).toMatchObject({
      phase: "implement",
      autonomy: "high",
      approved: true,
      hardLimitsEnforced: true
    });
  });

  it("enterPlanOnly after implement clears approval and freezes mutation", () => {
    approveSpec("medium");
    expect(mayMutate()).toBe(true);
    enterPlanOnly();
    expect(getSpecHandoffState()).toMatchObject({
      phase: "plan-only",
      approved: false,
      autonomy: "medium"
    });
    expect(mayMutate()).toBe(false);
    expect(assertImplementAllowed().allowed).toBe(false);
  });
});

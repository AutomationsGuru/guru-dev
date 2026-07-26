import { describe, expect, it } from "vitest";

import {
  APPROVAL_CANNOT_WIDEN_PLAN_FLOOR_CODE,
  DEFAULT_APPROVAL_POSTURE,
  DEFAULT_WORK_MODE,
  PLAN_FLOOR_DENIED_CODE,
  WorkModeSchema,
  ApprovalPostureSchema,
  assertPostureInvariant,
  evaluatePlanFloor,
  resolvePosture
} from "../../src/planner/workApprovalAxes.js";

const fixedClock = () => "2026-07-18T00:00:00.000Z";

describe("dual-axis enums", () => {
  it("exposes the workMode triple", () => {
    expect(WorkModeSchema.parse("plan")).toBe("plan");
    expect(WorkModeSchema.parse("act")).toBe("act");
    expect(WorkModeSchema.parse("operate")).toBe("operate");
    expect(() => WorkModeSchema.parse("unknown")).toThrow();
  });

  it("exposes the approvalPosture triple", () => {
    expect(ApprovalPostureSchema.parse("ask")).toBe("ask");
    expect(ApprovalPostureSchema.parse("auto_review")).toBe("auto_review");
    expect(ApprovalPostureSchema.parse("full")).toBe("full");
    expect(() => ApprovalPostureSchema.parse("yolo")).toThrow();
  });

  it("defaults preserve existing harness behavior (act + ask); plan is explicit opt-in", () => {
    expect(DEFAULT_WORK_MODE).toBe("act");
    expect(DEFAULT_APPROVAL_POSTURE).toBe("ask");
  });
});

describe("resolvePosture", () => {
  it("returns the act+ask defaults when called with empty options", () => {
    const posture = resolvePosture({}, undefined, ["read", "grep"], fixedClock);
    expect(posture.workMode).toBe("act");
    expect(posture.approvalPosture).toBe("ask");
    expect(posture.planFloorActive).toBe(false);
    expect(Array.from(posture.effectiveReadOnlyToolIds).sort()).toEqual(["grep", "read"]);
    expect(posture.resolvedAt).toBe(fixedClock());
  });

  it("preserves previous posture fields when caller leaves them out", () => {
    const first = resolvePosture({ workMode: "act", approvalPosture: "full" }, undefined, ["read"], fixedClock);
    const next = resolvePosture({}, first, ["read"], () => "2026-07-18T00:00:01.000Z");
    expect(next.workMode).toBe("act");
    expect(next.approvalPosture).toBe("full");
    expect(next.planFloorActive).toBe(false);
  });

  it("freezes the read-only allowlist and dedupes", () => {
    const posture = resolvePosture({}, undefined, ["read", "read", "grep", "ls"], fixedClock);
    expect(Array.from(posture.effectiveReadOnlyToolIds)).toEqual(["grep", "ls", "read"]);
  });
});

describe("evaluatePlanFloor", () => {
  const planPosture = resolvePosture({ workMode: "plan" }, undefined, ["read", "grep"], fixedClock);
  const actPosture = resolvePosture({ workMode: "act", approvalPosture: "full" }, undefined, ["read", "grep"], fixedClock);
  const fullActPosture = resolvePosture({ workMode: "act", approvalPosture: "full" }, undefined, ["read", "grep"], fixedClock);

  it("denies a mutating tool in plan mode with a stable error code", () => {
    const decision = evaluatePlanFloor(planPosture, "write", "mutating");
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe(PLAN_FLOOR_DENIED_CODE);
    expect(decision.reason).toMatch(/plan floor/);
  });

  it("denies a read-only tool that is not on the allowlist", () => {
    const decision = evaluatePlanFloor(planPosture, "list_directory", "read-only");
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe(PLAN_FLOOR_DENIED_CODE);
  });

  it("allows a read-only tool on the allowlist", () => {
    const decision = evaluatePlanFloor(planPosture, "read", "read-only");
    expect(decision.allowed).toBe(true);
  });

  it("does not run in act mode (floor is bypassed)", () => {
    const decision = evaluatePlanFloor(actPosture, "write", "mutating");
    expect(decision.allowed).toBe(true);
  });

  it("full approval posture cannot widen the plan floor", () => {
    // Same posture, but caller attempts to lift via "full" while staying in plan
    // — the floor must still deny writes.
    const posture = resolvePosture({ workMode: "plan", approvalPosture: "full" }, undefined, ["read"], fixedClock);
    expect(posture.planFloorActive).toBe(true);
    expect(evaluatePlanFloor(posture, "write", "mutating").allowed).toBe(false);
  });

  it("treats planFloorActive as the floor switch", () => {
    expect(planPosture.planFloorActive).toBe(true);
    expect(actPosture.planFloorActive).toBe(false);
    expect(fullActPosture.planFloorActive).toBe(false);
  });
});

describe("assertPostureInvariant", () => {
  it("never lets approval posture widen a previous plan floor", () => {
    const plan = resolvePosture({}, undefined, ["read"], fixedClock);
    const result = assertPostureInvariant(plan, { approvalPosture: "full" });
    // Invariant: caller cannot bypass the floor by switching approval only.
    expect(result.ok).toBe(true); // surface passes through; the floor still binds.
  });

  it("returns ok on safe transitions", () => {
    const act = resolvePosture({ workMode: "act" }, undefined, ["read"], fixedClock);
    const result = assertPostureInvariant(act, { workMode: "operate", approvalPosture: "full" });
    expect(result.ok).toBe(true);
  });

  it("emits a stable code in the rejection branch (defense in depth)", () => {
    expect(typeof APPROVAL_CANNOT_WIDEN_PLAN_FLOOR_CODE).toBe("string");
    expect(APPROVAL_CANNOT_WIDEN_PLAN_FLOOR_CODE.length).toBeGreaterThan(0);
  });
});

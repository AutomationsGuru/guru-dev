import { describe, expect, it } from "vitest";

import {
  evaluatePlanFloor,
  PLAN_FLOOR_DENIED_CODE,
  resolvePosture
} from "../../src/planner/workApprovalAxes.js";

/**
 * The mandate path consults the plan-mode floor BEFORE YOLO. This test pins
 * the contract: a mutating tool call is denied with a stable error code
 * even when the approval posture is "full" (YOLO-style), because the plan
 * floor is a hard edge resolved before approval.
 */
describe("plan-mode gate vs. approval posture (YOLO)", () => {
  it("denies mutating tools in plan mode with approvalPosture=full", () => {
    const posture = resolvePosture(
      { workMode: "plan", approvalPosture: "full" },
      undefined,
      ["read"],
      () => "2026-07-18T00:00:00.000Z"
    );
    const decision = evaluatePlanFloor(posture, "bash", "mutating");
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe(PLAN_FLOOR_DENIED_CODE);
  });

  it("denies network mutators in plan mode", () => {
    const posture = resolvePosture({ workMode: "plan" }, undefined, ["read"], () => "2026-07-18T00:00:00.000Z");
    const decision = evaluatePlanFloor(posture, "http_post", "network-mutating");
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe(PLAN_FLOOR_DENIED_CODE);
  });

  it("denies spawn-with-write in plan mode", () => {
    const posture = resolvePosture({ workMode: "plan" }, undefined, ["read"], () => "2026-07-18T00:00:00.000Z");
    const decision = evaluatePlanFloor(posture, "spawn", "spawn-with-write");
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe(PLAN_FLOOR_DENIED_CODE);
  });

  it("allows read-only allowlisted tools in plan mode", () => {
    const posture = resolvePosture({ workMode: "plan" }, undefined, ["read", "grep", "ls"], () => "2026-07-18T00:00:00.000Z");
    expect(evaluatePlanFloor(posture, "read", "read-only").allowed).toBe(true);
    expect(evaluatePlanFloor(posture, "grep", "read-only").allowed).toBe(true);
    expect(evaluatePlanFloor(posture, "ls", "read-only").allowed).toBe(true);
  });

  it("the floor never widens: only workMode toggles planFloorActive", () => {
    const askPlan = resolvePosture({ workMode: "plan", approvalPosture: "ask" }, undefined, ["read"], () => "x");
    const fullPlan = resolvePosture({ workMode: "plan", approvalPosture: "full" }, undefined, ["read"], () => "x");
    expect(askPlan.planFloorActive).toBe(true);
    expect(fullPlan.planFloorActive).toBe(true);
  });

  it("resolution order: plan floor → hard edges → approval posture → grants", () => {
    // This is a structural test: a mutating call in plan mode never reaches
    // approval/grants because evaluatePlanFloor denies first. We assert that
    // by checking the deny code is the plan-floor code, not an approval code.
    const posture = resolvePosture(
      { workMode: "plan", approvalPosture: "full" },
      undefined,
      ["read"],
      () => "2026-07-18T00:00:00.000Z"
    );
    const decision = evaluatePlanFloor(posture, "write", "mutating");
    expect(decision.code).toBe(PLAN_FLOOR_DENIED_CODE);
    expect(decision.code).not.toBe("APPROVAL_REQUIRED");
    expect(decision.code).not.toBe("GRANT_REQUIRED");
  });
});

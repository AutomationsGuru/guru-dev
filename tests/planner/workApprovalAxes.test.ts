import {
  APPROVAL_POSTURES,
  DEFAULT_WORK_APPROVAL_AXES,
  evaluatePlanModeGate,
  parseApprovalPosture,
  parseWorkApprovalAxes,
  parseWorkMode,
  PLAN_MODE_DENY_CODE,
  WORK_MODES,
  WorkApprovalAxesSchema
} from '../../src/planner/workApprovalAxes.js';

describe("workMode / approvalPosture enums", () => {
  it("exposes exactly the three work modes in fixed order and frozen", () => {
    expect(WORK_MODES).toEqual(["plan", "act", "operate"]);
    expect(Object.isFrozen(WORK_MODES)).toBe(true);
  });

  it("exposes exactly the three approval postures in fixed order and frozen", () => {
    expect(APPROVAL_POSTURES).toEqual(["ask", "auto_review", "full"]);
    expect(Object.isFrozen(APPROVAL_POSTURES)).toBe(true);
  });

  it("ships fail-closed defaults of plan + ask and freezes them", () => {
    expect(DEFAULT_WORK_APPROVAL_AXES).toEqual({ workMode: "plan", approvalPosture: "ask" });
    expect(Object.isFrozen(DEFAULT_WORK_APPROVAL_AXES)).toBe(true);
  });
});

describe("WorkApprovalAxesSchema", () => {
  it("defaults a missing axis to the fail-closed value independently", () => {
    expect(WorkApprovalAxesSchema.parse({})).toEqual({ workMode: "plan", approvalPosture: "ask" });
    expect(WorkApprovalAxesSchema.parse({ workMode: "act" })).toEqual({ workMode: "act", approvalPosture: "ask" });
    expect(WorkApprovalAxesSchema.parse({ approvalPosture: "full" })).toEqual({ workMode: "plan", approvalPosture: "full" });
  });

  it("rejects unknown axis values legibly", () => {
    expect(WorkApprovalAxesSchema.safeParse({ workMode: "yolo" }).success).toBe(false);
    expect(WorkApprovalAxesSchema.safeParse({ approvalPosture: "yolo" }).success).toBe(false);
  });

  it("rejects extra keys (strict shape)", () => {
    expect(WorkApprovalAxesSchema.safeParse({ workMode: "plan", extra: true }).success).toBe(false);
  });
});

describe("parseWorkMode / parseApprovalPosture / parseWorkApprovalAxes", () => {
  it("parses valid values and falls back to fail-closed defaults on garbage", () => {
    expect(parseWorkMode("act")).toBe("act");
    expect(parseWorkMode("nonsense")).toBe("plan");
    expect(parseWorkMode(undefined)).toBe("plan");
    expect(parseApprovalPosture("auto_review")).toBe("auto_review");
    expect(parseApprovalPosture("nonsense")).toBe("ask");
    expect(parseApprovalPosture(null)).toBe("ask");
  });

  it("parses a full axes object with per-axis fail-closed fallback", () => {
    expect(parseWorkApprovalAxes({ workMode: "operate", approvalPosture: "full" })).toEqual({
      workMode: "operate",
      approvalPosture: "full"
    });
    expect(parseWorkApprovalAxes({ workMode: "bogus", approvalPosture: "full" })).toEqual({
      workMode: "plan",
      approvalPosture: "full"
    });
    expect(parseWorkApprovalAxes(undefined)).toEqual({ workMode: "plan", approvalPosture: "ask" });
    expect(parseWorkApprovalAxes("act")).toEqual({ workMode: "plan", approvalPosture: "ask" });
  });
});

describe("evaluatePlanModeGate", () => {
  it("allows a certified read-only tool in plan mode at any posture", () => {
    for (const approvalPosture of APPROVAL_POSTURES) {
      const decision = evaluatePlanModeGate({ workMode: "plan", approvalPosture }, "read", true);
      expect(decision).toEqual({ allowed: true });
    }
  });

  it("denies a non-certified tool in plan mode with the stable error code", () => {
    const decision = evaluatePlanModeGate({ workMode: "plan", approvalPosture: "ask" }, "write", false);

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.code).toBe(PLAN_MODE_DENY_CODE);
      expect(decision.reason).toContain("write");
    }
  });

  it("never lets a full approval posture widen the plan floor", () => {
    const decision = evaluatePlanModeGate({ workMode: "plan", approvalPosture: "full" }, "bash", false);

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.code).toBe(PLAN_MODE_DENY_CODE);
    }
  });

  it("does not gate tools when workMode is act or operate (dual-axis independence)", () => {
    for (const workMode of ["act", "operate"] as const) {
      for (const approvalPosture of APPROVAL_POSTURES) {
        expect(evaluatePlanModeGate({ workMode, approvalPosture }, "write", false)).toEqual({ allowed: true });
        expect(evaluatePlanModeGate({ workMode, approvalPosture }, "read", true)).toEqual({ allowed: true });
      }
    }
  });

  it("fails closed on garbage axes input", () => {
    const decision = evaluatePlanModeGate({ workMode: "bogus", approvalPosture: "bogus" }, "write", false);

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.code).toBe(PLAN_MODE_DENY_CODE);
    }
  });

  it("exposes a stable deny code", () => {
    expect(PLAN_MODE_DENY_CODE).toBe("PLAN_MODE_TOOL_DENIED");
  });
});

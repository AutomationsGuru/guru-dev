import { describe, it, expect } from "vitest";
import {
  DEFAULT_DUAL_SAFETY_POSTURE,
  withSandbox,
  withApproval,
  validate,
  combine,
  type DualSafetyPosture
} from '../../src/security/dualSafetyPosture.js';

describe("DualSafetyPosture", () => {
  it("defaults to workspace-write + on-request", () => {
    expect(DEFAULT_DUAL_SAFETY_POSTURE.sandboxMode).toBe("workspace-write");
    expect(DEFAULT_DUAL_SAFETY_POSTURE.approvalPolicy).toBe("on-request");
    expect(validate(DEFAULT_DUAL_SAFETY_POSTURE)).toBe(true);
  });

  it("withSandbox updates only sandbox axis (axes independent)", () => {
    const updated = withSandbox(DEFAULT_DUAL_SAFETY_POSTURE, "full");
    expect(updated.sandboxMode).toBe("full");
    expect(updated.approvalPolicy).toBe("on-request"); // unchanged
    expect(validate(updated)).toBe(true); // full + on-request is valid
  });

  it("withApproval updates only approval axis (axes independent)", () => {
    const updated = withApproval(DEFAULT_DUAL_SAFETY_POSTURE, "never");
    expect(updated.approvalPolicy).toBe("never");
    expect(updated.sandboxMode).toBe("workspace-write"); // unchanged
    expect(validate(updated)).toBe(true);
  });

  it("validate accepts valid independent combos", () => {
    expect(validate({ sandboxMode: "off", approvalPolicy: "on-request" })).toBe(true);
    expect(validate({ sandboxMode: "workspace-write", approvalPolicy: "auto-approve" })).toBe(true);
    expect(validate({ sandboxMode: "full", approvalPolicy: "on-request" })).toBe(true);
  });

  it("validate/combine reject invalid combos (hard limit enforcement)", () => {
    expect(validate({ sandboxMode: "full", approvalPolicy: "auto-approve" })).toBe(false);
    expect(() => combine("full", "auto-approve")).toThrow(/Invalid dual safety combo/);
    expect(() => combine("off", "on-request")).not.toThrow();
  });

  it("combine produces valid posture from independent axes", () => {
    const p = combine("workspace-write", "on-request");
    expect(p.sandboxMode).toBe("workspace-write");
    expect(p.approvalPolicy).toBe("on-request");
  });
});

import { describe, expect, it } from "vitest";

import {
  approvePhase,
  canImplement,
  createSpecPacket,
  enableQuickPlan,
  isQuickPlan,
  type SpecPacket
} from '../../src/planning/quickPlanBypass.js';

/**
 * Quick plan bypass (IDEA-F145-QUICK-PLAN-01, R-KR-QUICK) — gated vs quick.
 *
 * Default path requires requirements+design approval before implement.
 * quickPlan skips phase gates when artifacts are present; empty artifacts
 * always fail closed.
 */

describe("gated path (quickPlan: false)", () => {
  it("cannot implement when phases are still draft", () => {
    const packet = createSpecPacket();
    expect(packet.quickPlan).toBe(false);
    expect(packet.phases.requirements).toBe("draft");
    expect(packet.phases.design).toBe("draft");
    expect(canImplement(packet)).toBe(false);
  });

  it("can implement after approving requirements and design", () => {
    let packet = createSpecPacket();
    packet = approvePhase(packet, "requirements");
    packet = approvePhase(packet, "design");
    expect(packet.phases.tasks).toBe("draft");
    expect(canImplement(packet)).toBe(true);
  });

  it("still cannot implement when only requirements is approved", () => {
    const packet = approvePhase(createSpecPacket(), "requirements");
    expect(packet.phases.requirements).toBe("approved");
    expect(packet.phases.design).toBe("draft");
    expect(canImplement(packet)).toBe(false);
  });
});

describe("quick plan path", () => {
  it("enableQuickPlan sets the flag and canImplement is true with draft phases", () => {
    const gated = createSpecPacket();
    const result = enableQuickPlan(gated);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.packet.quickPlan).toBe(true);
    expect(isQuickPlan(result.packet)).toBe(true);
    expect(result.packet.phases.requirements).toBe("draft");
    expect(result.packet.phases.design).toBe("draft");
    expect(result.packet.phases.tasks).toBe("draft");
    expect(canImplement(result.packet)).toBe(true);
  });

  it("enableQuickPlan preserves artifact content", () => {
    const gated = createSpecPacket({
      artifacts: {
        requirements: "req body alpha",
        design: "design body beta",
        tasks: "tasks body gamma"
      }
    });
    const result = enableQuickPlan(gated);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.packet.artifacts.requirements).toBe("req body alpha");
    expect(result.packet.artifacts.design).toBe("design body beta");
    expect(result.packet.artifacts.tasks).toBe("tasks body gamma");
  });

  it("enableQuickPlan does not mutate the original packet", () => {
    const original = createSpecPacket({ id: "immutable-1" });
    const snapshot: SpecPacket = {
      id: original.id,
      kind: original.kind,
      artifacts: { ...original.artifacts },
      phases: { ...original.phases },
      quickPlan: original.quickPlan
    };
    const result = enableQuickPlan(original);
    expect(result.ok).toBe(true);
    expect(original).toEqual(snapshot);
    expect(original.quickPlan).toBe(false);
    if (result.ok) {
      expect(result.packet).not.toBe(original);
      expect(result.packet.quickPlan).toBe(true);
    }
  });
});

describe("fail closed on empty / missing artifacts", () => {
  it("enableQuickPlan rejects empty artifacts", () => {
    const emptyReqs = createSpecPacket({
      artifacts: {
        requirements: "   ",
        design: "design",
        tasks: "tasks"
      }
    });
    const result = enableQuickPlan(emptyReqs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/non-empty/i);
    }
  });

  it("canImplement is false for quick plan with empty artifacts", () => {
    const packet = createSpecPacket({
      quickPlan: true,
      artifacts: {
        requirements: "ok",
        design: "",
        tasks: "ok"
      }
    });
    expect(packet.quickPlan).toBe(true);
    expect(canImplement(packet)).toBe(false);
  });

  it("canImplement is false for gated packet with empty artifacts even if phases approved", () => {
    let packet = createSpecPacket({
      artifacts: {
        requirements: "ok",
        design: "ok",
        tasks: "  "
      }
    });
    packet = approvePhase(packet, "requirements");
    packet = approvePhase(packet, "design");
    expect(canImplement(packet)).toBe(false);
  });

  it("canImplement is false for a malformed packet", () => {
    expect(canImplement({} as SpecPacket)).toBe(false);
    expect(canImplement(null as unknown as SpecPacket)).toBe(false);
  });
});

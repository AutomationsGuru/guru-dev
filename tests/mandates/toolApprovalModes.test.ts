import { describe, it, expect } from "vitest";
import { resolveApproval, ToolApprovalModeSchema, type ToolApprovalMode } from '../../src/mandates/toolApprovalModes.js';

describe("toolApprovalModes", () => {
  describe("resolveApproval", () => {
    it("never_require allows non-hard tool (auto_allow)", () => {
      const res = resolveApproval("safe-tool", "never_require", false);
      expect(res.requiresApproval).toBe(false);
      expect(res.effective).toBe("auto_allow");
      expect(res.reason).toContain("never_require");
    });

    it("hard-limit tool always requires approval regardless of declared mode", () => {
      const modes: ToolApprovalMode[] = ["always_require", "never_require", "ask"];
      for (const mode of modes) {
        const res = resolveApproval("destructive-tool", mode, true);
        expect(res.requiresApproval).toBe(true);
        expect(res.effective).toBe("require");
        expect(res.reason).toContain("Hard-limit");
      }
    });

    it("always_require forces prompt on non-hard", () => {
      const res = resolveApproval("risky-tool", "always_require", false);
      expect(res.requiresApproval).toBe(true);
      expect(res.effective).toBe("require");
    });

    it("default ask requires approval on non-hard", () => {
      const res = resolveApproval("normal-tool");
      expect(res.requiresApproval).toBe(true);
      expect(res.effective).toBe("require");
      expect(res.reason).toContain("ask");
    });

    it("schema validates declared modes", () => {
      expect(() => ToolApprovalModeSchema.parse("ask")).not.toThrow();
      expect(() => ToolApprovalModeSchema.parse("never_require")).not.toThrow();
      expect(() => ToolApprovalModeSchema.parse("always_require")).not.toThrow();
      expect(() => ToolApprovalModeSchema.parse("invalid")).toThrow();
    });
  });
});

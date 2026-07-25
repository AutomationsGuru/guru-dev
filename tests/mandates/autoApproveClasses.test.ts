import { describe, expect, it } from "vitest";

import {
  AutoApproveConfigSchema,
  DEFAULT_AUTO_APPROVE_CONFIG,
  GATED_AUTO_APPROVE_CLASSES,
  HARD_LIMIT_AUTO_APPROVE_CLASSES,
  mayAuto,
  type AutoApproveClass
} from '../../src/mandates/autoApproveClasses.js';

const hardLimitClasses: readonly AutoApproveClass[] = HARD_LIMIT_AUTO_APPROVE_CLASSES;

describe("auto-approve class matrix", () => {
  it("maps YOLO defaults to routine classes while keeping shell-risk gated", () => {
    expect(DEFAULT_AUTO_APPROVE_CONFIG).toMatchObject({
      read: true,
      write: true,
      "shell-safe": true,
      "shell-risk": false,
      network: true
    });
    expect(mayAuto("read", DEFAULT_AUTO_APPROVE_CONFIG)).toBe(true);
    expect(mayAuto("write", DEFAULT_AUTO_APPROVE_CONFIG)).toBe(true);
    expect(mayAuto("shell-safe", DEFAULT_AUTO_APPROVE_CONFIG)).toBe(true);
    expect(mayAuto("shell-risk", DEFAULT_AUTO_APPROVE_CONFIG)).toBe(false);
  });

  it.each([...hardLimitClasses, "shell-risk"] as const)("never auto-approves gated class %s", (toolClass) => {
    expect(mayAuto(toolClass, { ...DEFAULT_AUTO_APPROVE_CONFIG, [toolClass]: true })).toBe(false);
  });

  it("exposes shell-risk and hard-limit classes as gated", () => {
    expect(GATED_AUTO_APPROVE_CLASSES).toEqual(["shell-risk", ...hardLimitClasses]);
  });

  it("auto-approves a class only when its sticky session setting is enabled", () => {
    const config = AutoApproveConfigSchema.parse({ read: true });

    expect(mayAuto("read", config)).toBe(true);
    expect(mayAuto("write", config)).toBe(false);
    expect(mayAuto("shell-risk", config)).toBe(false);
  });

  it("fails closed for unknown classes and malformed config", () => {
    expect(mayAuto("unknown" as AutoApproveClass, DEFAULT_AUTO_APPROVE_CONFIG)).toBe(false);
    expect(() => AutoApproveConfigSchema.parse({ read: "yes" })).toThrow();
  });
});

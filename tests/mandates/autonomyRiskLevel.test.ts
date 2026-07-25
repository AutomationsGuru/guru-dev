import { describe, expect, it } from "vitest";

import {
  AUTONOMY_RISK_LEVEL_ORDER,
  AutonomyRiskLevelSchema,
  autonomyRiskLevelRank,
  classifyCommandRisk,
  mayAutoRun,
  mayAutoRunCommand
} from '../../src/mandates/autonomyRiskLevel.js';

describe("autonomy risk levels", () => {
  it("keeps levels ordered off < low < medium < high", () => {
    expect(AUTONOMY_RISK_LEVEL_ORDER).toEqual({ off: 0, low: 1, medium: 2, high: 3 });
    expect(autonomyRiskLevelRank("off")).toBeLessThan(autonomyRiskLevelRank("low"));
    expect(autonomyRiskLevelRank("low")).toBeLessThan(autonomyRiskLevelRank("medium"));
    expect(autonomyRiskLevelRank("medium")).toBeLessThan(autonomyRiskLevelRank("high"));
    expect(AutonomyRiskLevelSchema.safeParse("high").success).toBe(true);
    expect(AutonomyRiskLevelSchema.safeParse("invalid").success).toBe(false);
  });

  it("classifies read-only tools at off and ordinary edits at low", () => {
    expect(classifyCommandRisk("read")).toBe("off");
    expect(classifyCommandRisk("edit")).toBe("low");
    expect(classifyCommandRisk("write")).toBe("low");
  });

  it("classifies shell and push commands conservatively", () => {
    expect(classifyCommandRisk("bash", "npm test")).toBe("medium");
    expect(classifyCommandRisk("bash", "git push origin main")).toBe("high");
  });

  it("classifies constitutional hard-limit operations before autonomy", () => {
    expect(classifyCommandRisk("bash", "rm -rf build")).toBe("hard-limit");
    expect(classifyCommandRisk("write", "config/.env")).toBe("hard-limit");
    expect(classifyCommandRisk("spend")).toBe("hard-limit");
  });

  it("off blocks edits while low permits edits but not push-class work", () => {
    expect(mayAutoRun("off", "low")).toBe(false);
    expect(mayAutoRun("low", "low")).toBe(true);
    expect(mayAutoRun("low", "high")).toBe(false);
    expect(mayAutoRunCommand("off", "edit")).toBe(false);
    expect(mayAutoRunCommand("low", "edit")).toBe(true);
    expect(mayAutoRunCommand("low", "bash", "git push origin main")).toBe(false);
  });

  it("high still blocks every hard-limit class", () => {
    expect(mayAutoRun("high", "hard-limit")).toBe(false);
    expect(mayAutoRunCommand("high", "bash", "rm -rf build")).toBe(false);
    expect(mayAutoRunCommand("high", "write", "config/.env")).toBe(false);
  });

  it("fails closed for malformed level or risk values", () => {
    expect(mayAutoRun("unknown" as "high", "low")).toBe(false);
    expect(mayAutoRun("high", "unknown" as "high")).toBe(false);
  });
});

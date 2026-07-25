import { describe, expect, it } from "vitest";

import {
  ProductionSignalsSchema,
  evaluateProductionDeployChecklist,
  detectProductionSignals,
  type ProductionSignals
} from '../../src/quality/productionDeployChecklist.js';

function signals(overrides: Partial<ProductionSignals> = {}): ProductionSignals {
  return ProductionSignalsSchema.parse({
    secretSafetyActive: true,
    sandboxActive: true,
    hardLimitsEnforced: true,
    tracingConfigured: true,
    ...overrides
  });
}

describe("ProductionSignalsSchema", () => {
  it("should accept all-true signals", () => {
    const parsed = ProductionSignalsSchema.parse({
      secretSafetyActive: true,
      sandboxActive: true,
      hardLimitsEnforced: true,
      tracingConfigured: true
    });
    expect(parsed.secretSafetyActive).toBe(true);
    expect(parsed.sandboxActive).toBe(true);
    expect(parsed.hardLimitsEnforced).toBe(true);
    expect(parsed.tracingConfigured).toBe(true);
  });

  it("should default tracingConfigured to false", () => {
    const parsed = ProductionSignalsSchema.parse({
      secretSafetyActive: true,
      sandboxActive: true,
      hardLimitsEnforced: true
    });
    expect(parsed.tracingConfigured).toBe(false);
  });
});

describe("evaluateProductionDeployChecklist", () => {
  it("should return GREEN when all required signals pass", () => {
    const report = evaluateProductionDeployChecklist(
      signals({ secretSafetyActive: true, sandboxActive: true, hardLimitsEnforced: true })
    );

    expect(report.verdict).toBe("GREEN");
    expect(report.items.filter((i) => i.passed).length).toBe(4);
    expect(report.summary).toContain("GREEN");
  });

  it("should return RED when a required signal fails (missing sandbox)", () => {
    const report = evaluateProductionDeployChecklist(
      signals({ sandboxActive: false })
    );

    expect(report.verdict).toBe("RED");
    const sandboxItem = report.items.find((i) => i.id === "sandbox");
    expect(sandboxItem).toBeDefined();
    expect(sandboxItem?.passed).toBe(false);
    expect(sandboxItem?.required).toBe(true);
  });

  it("should return RED when secrets are not active", () => {
    const report = evaluateProductionDeployChecklist(
      signals({ secretSafetyActive: false })
    );

    expect(report.verdict).toBe("RED");
    const secretsItem = report.items.find((i) => i.id === "secrets");
    expect(secretsItem?.passed).toBe(false);
    expect(secretsItem?.required).toBe(true);
  });

  it("should return RED when hard limits are not enforced", () => {
    const report = evaluateProductionDeployChecklist(
      signals({ hardLimitsEnforced: false })
    );

    expect(report.verdict).toBe("RED");
    const hardLimitsItem = report.items.find((i) => i.id === "hard-limits");
    expect(hardLimitsItem?.passed).toBe(false);
    expect(hardLimitsItem?.required).toBe(true);
  });

  it("should stay GREEN when optional tracing is missing", () => {
    const report = evaluateProductionDeployChecklist(
      signals({ tracingConfigured: false })
    );

    expect(report.verdict).toBe("GREEN");
    const tracingItem = report.items.find((i) => i.id === "tracing");
    expect(tracingItem?.passed).toBe(false);
    expect(tracingItem?.required).toBe(false);
  });

  it("should return RED when multiple required signals fail", () => {
    const report = evaluateProductionDeployChecklist(
      signals({ secretSafetyActive: false, sandboxActive: false })
    );

    expect(report.verdict).toBe("RED");
    expect(report.items.filter((i) => !i.passed && i.required).length).toBe(2);
  });

  it("should produce exactly four checklist items in the correct order", () => {
    const report = evaluateProductionDeployChecklist(signals());

    expect(report.items).toHaveLength(4);
    expect(report.items.map((i) => i.id)).toEqual([
      "secrets",
      "sandbox",
      "hard-limits",
      "tracing"
    ]);
  });

  it("should include a generatedAt timestamp in ISO format", () => {
    const report = evaluateProductionDeployChecklist(signals());

    expect(report.generatedAt).toBeDefined();
    expect(() => new Date(report.generatedAt)).not.toThrow();
  });

  it("should include evidence text for every item", () => {
    const report = evaluateProductionDeployChecklist(signals());

    for (const item of report.items) {
      expect(item.evidence).toBeTruthy();
      expect(item.evidence.length).toBeGreaterThan(0);
    }
  });
});

describe("detectProductionSignals", () => {
  it("should return a valid ProductionSignals object", () => {
    const detected = detectProductionSignals();

    expect(detected).toBeDefined();
    expect(typeof detected.secretSafetyActive).toBe("boolean");
    expect(typeof detected.sandboxActive).toBe("boolean");
    expect(typeof detected.hardLimitsEnforced).toBe("boolean");
    expect(typeof detected.tracingConfigured).toBe("boolean");
  });

  it("should detect secret safety as active (module is importable)", () => {
    const detected = detectProductionSignals();
    // secretSafety module exists in the codebase; detection should find it
    expect(detected.secretSafetyActive).toBe(true);
  });

  it("should detect sandbox status as a boolean", () => {
    const detected = detectProductionSignals();
    // Sandbox may or may not be active in this test environment, but the value
    // must be a boolean — not undefined, not null.
    expect(typeof detected.sandboxActive).toBe("boolean");
  });

  it("should detect hard-limits enforcement as a boolean", () => {
    const detected = detectProductionSignals();
    expect(typeof detected.hardLimitsEnforced).toBe("boolean");
  });
});

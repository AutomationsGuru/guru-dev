import { describe, expect, it } from "vitest";

import { resolveEffort } from '../../src/providers/modelEffortDial.js';

describe("model effort dial", () => {
  it("should resolve bounded caps for every effort level", () => {
    expect(resolveEffort("low")).toEqual({ maxSteps: 5, maxTokens: 2_048 });
    expect(resolveEffort("med")).toEqual({ maxSteps: 10, maxTokens: 4_096 });
    expect(resolveEffort("high")).toEqual({ maxSteps: 25, maxTokens: 8_192 });
  });

  it("should increase maxSteps and token caps with effort", () => {
    const low = resolveEffort("low");
    const med = resolveEffort("med");
    const high = resolveEffort("high");

    expect(high.maxSteps).toBeGreaterThanOrEqual(med.maxSteps);
    expect(med.maxSteps).toBeGreaterThanOrEqual(low.maxSteps);
    expect(high.maxTokens).toBeGreaterThanOrEqual(med.maxTokens);
    expect(med.maxTokens).toBeGreaterThanOrEqual(low.maxTokens);
  });
});

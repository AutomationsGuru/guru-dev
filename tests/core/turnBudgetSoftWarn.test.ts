import { shouldSoftWarn } from '../../src/core/turnBudgetSoftWarn.js';

describe("shouldSoftWarn", () => {
  // --- above soft threshold: no warn ---

  it("returns false when remaining is above the soft threshold (absolute counts)", () => {
    // remaining=50, threshold=25 → 50 > 25 → no warn
    expect(shouldSoftWarn(50, 25)).toBe(false);
  });

  it("returns false when remaining is well above the soft threshold", () => {
    // remaining=1000, threshold=100 → 1000 > 100 → no warn
    expect(shouldSoftWarn(1000, 100)).toBe(false);
  });

  it("returns false when remaining is one unit above the threshold", () => {
    // remaining=26, threshold=25 → 26 > 25 → no warn
    expect(shouldSoftWarn(26, 25)).toBe(false);
  });

  // --- at soft threshold: warn ---

  it("returns true when remaining is exactly at the soft threshold", () => {
    // remaining=25, threshold=25 → 25 ≤ 25 → warn
    expect(shouldSoftWarn(25, 25)).toBe(true);
  });

  it("returns true when remaining is exactly at zero threshold", () => {
    // remaining=0, threshold=0 → 0 ≤ 0 → warn
    expect(shouldSoftWarn(0, 0)).toBe(true);
  });

  // --- below soft threshold: warn ---

  it("returns true when remaining is below the soft threshold", () => {
    // remaining=10, threshold=25 → 10 ≤ 25 → warn
    expect(shouldSoftWarn(10, 25)).toBe(true);
  });

  it("returns true when remaining is zero (budget exhausted) with a positive threshold", () => {
    // remaining=0, threshold=20 → 0 ≤ 20 → warn
    expect(shouldSoftWarn(0, 20)).toBe(true);
  });

  it("returns true when remaining is one unit below threshold", () => {
    // remaining=24, threshold=25 → 24 ≤ 25 → warn
    expect(shouldSoftWarn(24, 25)).toBe(true);
  });

  // --- callers using percentage-derived thresholds ---

  it("works with caller-computed absolute thresholds (20% of 200 = 40)", () => {
    const maxCalls = 200;
    const softThreshold = Math.floor(maxCalls * 0.2); // 40

    // 80 calls left → well above 40 → no warn
    expect(shouldSoftWarn(80, softThreshold)).toBe(false);
    // 40 calls left → at threshold → warn
    expect(shouldSoftWarn(40, softThreshold)).toBe(true);
    // 20 calls left → below threshold → warn
    expect(shouldSoftWarn(20, softThreshold)).toBe(true);
  });

  it("works with caller-computed absolute thresholds (10% of 500 = 50)", () => {
    const maxTokens = 500;
    const softThreshold = Math.floor(maxTokens * 0.1); // 50

    expect(shouldSoftWarn(100, softThreshold)).toBe(false);
    expect(shouldSoftWarn(50, softThreshold)).toBe(true);
    expect(shouldSoftWarn(1, softThreshold)).toBe(true);
  });

  // --- input validation ---

  it("throws when remaining is negative", () => {
    expect(() => shouldSoftWarn(-1, 25)).toThrow("Invalid turn-budget soft-warn input");
  });

  it("throws when softPct is negative", () => {
    expect(() => shouldSoftWarn(10, -5)).toThrow("Invalid turn-budget soft-warn input");
  });

  it("throws when remaining is NaN", () => {
    expect(() => shouldSoftWarn(NaN, 25)).toThrow("Invalid turn-budget soft-warn input");
  });

  it("throws when softPct is Infinity", () => {
    expect(() => shouldSoftWarn(10, Infinity)).toThrow("Invalid turn-budget soft-warn input");
  });
});

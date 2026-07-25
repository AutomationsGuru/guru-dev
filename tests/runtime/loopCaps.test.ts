import {
  LOOP_CAPS_ABSOLUTE_CEILINGS,
  LoopCapExceededError,
  assertLoopCapConfig,
  createLoopCaps,
  type LoopUsage
} from "../../src/runtime/loopCaps.js";

function usage(overrides: Partial<LoopUsage> = {}): LoopUsage {
  return {
    iterations: 0,
    totalTokens: 0,
    wallClockMs: 0,
    fanoutWidth: 0,
    spendUsd: 0,
    ...overrides
  };
}

describe("loopCaps", () => {
  it("should leave the loop open when no caps are configured", () => {
    const caps = createLoopCaps();

    expect(caps.configured).toBe(false);
    expect(caps.check(usage())).toEqual({ ok: true, exceeded: [] });
    expect(
      caps.check(
        usage({
          iterations: Number.MAX_SAFE_INTEGER,
          totalTokens: Number.MAX_SAFE_INTEGER,
          wallClockMs: Number.MAX_SAFE_INTEGER,
          fanoutWidth: Number.MAX_SAFE_INTEGER,
          spendUsd: Number.MAX_SAFE_INTEGER
        })
      ).ok
    ).toBe(true);
    expect(() => caps.throwIfExceeded(usage({ iterations: 10_000 }))).not.toThrow();
  });

  it("should fail closed when the iteration cap is reached", () => {
    const caps = createLoopCaps({ maxIterations: 3 });

    expect(caps.configured).toBe(true);
    expect(caps.check(usage({ iterations: 2 }))).toEqual({ ok: true, exceeded: [] });

    const verdict = caps.check(usage({ iterations: 3 }));
    expect(verdict.ok).toBe(false);
    expect(verdict.exceeded).toEqual([{ cap: "maxIterations", limit: 3, actual: 3 }]);
  });

  it("should fail closed when the cumulative token cap is exceeded", () => {
    const caps = createLoopCaps({ maxTokens: 1_000 });

    expect(caps.check(usage({ totalTokens: 999 })).ok).toBe(true);

    const verdict = caps.check(usage({ totalTokens: 1_001 }));
    expect(verdict.ok).toBe(false);
    expect(verdict.exceeded).toEqual([{ cap: "maxTokens", limit: 1_000, actual: 1_001 }]);
  });

  it("should fail closed when the wall-clock cap is reached", () => {
    const caps = createLoopCaps({ maxWallClockMs: 5_000 });

    expect(caps.check(usage({ wallClockMs: 4_999 })).ok).toBe(true);
    expect(caps.check(usage({ wallClockMs: 5_000 })).exceeded).toEqual([
      { cap: "maxWallClockMs", limit: 5_000, actual: 5_000 }
    ]);
  });

  it("should fail closed when the fanout width exceeds the configured bound", () => {
    const caps = createLoopCaps({ maxFanoutWidth: 4 });

    expect(caps.check(usage({ fanoutWidth: 4 })).ok).toBe(true);
    expect(caps.check(usage({ fanoutWidth: 5 })).exceeded).toEqual([
      { cap: "maxFanoutWidth", limit: 4, actual: 5 }
    ]);
  });

  it("should deny any positive spend under a $0 ceiling and allow exactly zero", () => {
    const caps = createLoopCaps({ maxSpendUsd: 0 });

    expect(caps.check(usage({ spendUsd: 0 })).ok).toBe(true);
    expect(caps.check(usage({ spendUsd: 0.01 })).exceeded).toEqual([
      { cap: "maxSpendUsd", limit: 0, actual: 0.01 }
    ]);
  });

  it("should fail closed when the spend cap is exceeded", () => {
    const caps = createLoopCaps({ maxSpendUsd: 2.5 });

    expect(caps.check(usage({ spendUsd: 2.5 })).ok).toBe(true);
    expect(caps.check(usage({ spendUsd: 2.5001 })).exceeded).toEqual([
      { cap: "maxSpendUsd", limit: 2.5, actual: 2.5001 }
    ]);
  });

  it("should report every exceeded cap in a single verdict", () => {
    const caps = createLoopCaps({ maxIterations: 1, maxTokens: 10, maxSpendUsd: 0.5 });
    const verdict = caps.check(usage({ iterations: 5, totalTokens: 50, spendUsd: 5 }));

    expect(verdict.ok).toBe(false);
    expect(verdict.exceeded).toEqual([
      { cap: "maxIterations", limit: 1, actual: 5 },
      { cap: "maxTokens", limit: 10, actual: 50 },
      { cap: "maxSpendUsd", limit: 0.5, actual: 5 }
    ]);
  });

  it("should throw a structured LoopCapExceededError from throwIfExceeded", () => {
    const caps = createLoopCaps({ maxIterations: 2, maxTokens: 100 });

    let caught: unknown;
    try {
      caps.throwIfExceeded(usage({ iterations: 2, totalTokens: 500 }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LoopCapExceededError);
    const error = caught as LoopCapExceededError;
    expect(error.code).toBe("LOOP_CAP_EXCEEDED");
    expect(error.exceeded).toEqual([
      { cap: "maxIterations", limit: 2, actual: 2 },
      { cap: "maxTokens", limit: 100, actual: 500 }
    ]);
    expect(error.message).toContain("maxIterations");
    expect(error.message).toContain("maxTokens");
  });

  it("should reject invalid cap values instead of silently ignoring them", () => {
    expect(() => createLoopCaps({ maxIterations: -1 })).toThrow(/maxIterations/);
    expect(() => createLoopCaps({ maxIterations: 0 })).toThrow(/maxIterations/);
    expect(() => createLoopCaps({ maxIterations: 1.5 })).toThrow(/maxIterations/);
    expect(() => createLoopCaps({ maxTokens: 0 })).toThrow(/maxTokens/);
    expect(() => createLoopCaps({ maxWallClockMs: -10 })).toThrow(/maxWallClockMs/);
    expect(() => createLoopCaps({ maxFanoutWidth: 0 })).toThrow(/maxFanoutWidth/);
    expect(() => createLoopCaps({ maxSpendUsd: -0.01 })).toThrow(/maxSpendUsd/);
    expect(() => createLoopCaps({ maxSpendUsd: Number.NaN })).toThrow(/maxSpendUsd/);
    expect(() => assertLoopCapConfig({ maxTokens: Number.POSITIVE_INFINITY })).toThrow(/maxTokens/);
  });

  it("should clamp absurd configured values to the absolute ceilings so every loop stays bounded", () => {
    const caps = createLoopCaps({
      maxIterations: Number.MAX_SAFE_INTEGER,
      maxTokens: 1e30,
      maxWallClockMs: 1e30,
      maxFanoutWidth: 1e30,
      maxSpendUsd: 1e30
    });

    expect(caps.limits).toEqual({
      maxIterations: LOOP_CAPS_ABSOLUTE_CEILINGS.maxIterations,
      maxTokens: LOOP_CAPS_ABSOLUTE_CEILINGS.maxTokens,
      maxWallClockMs: LOOP_CAPS_ABSOLUTE_CEILINGS.maxWallClockMs,
      maxFanoutWidth: LOOP_CAPS_ABSOLUTE_CEILINGS.maxFanoutWidth,
      maxSpendUsd: LOOP_CAPS_ABSOLUTE_CEILINGS.maxSpendUsd
    });
    expect(caps.check(usage({ iterations: LOOP_CAPS_ABSOLUTE_CEILINGS.maxIterations })).ok).toBe(false);
  });

  it("should expose the effective limits for reporting", () => {
    const caps = createLoopCaps({ maxIterations: 10, maxSpendUsd: 1 });

    expect(caps.limits).toEqual({ maxIterations: 10, maxSpendUsd: 1 });
  });
});

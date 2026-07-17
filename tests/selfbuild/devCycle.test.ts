import { describe, expect, it } from "vitest";

import {
  DevCycleBudget,
  RunDevCycleConfigSchema,
  nextStage,
  type Clock,
  type DevStage
} from "../../src/selfbuild/devCycle.js";

const cfg = (over: Record<string, unknown> = {}) => RunDevCycleConfigSchema.parse(over);

describe("DevCycleBudget (P7 spine) — every model loop is triply bounded + spend-gated", () => {
  it("halts on the attempt cap", () => {
    const b = new DevCycleBudget(cfg({ maxIterations: 2 }));
    expect(b.exhaustedReason()).toBeNull();
    b.recordAttempt();
    expect(b.exhaustedReason()).toBeNull();
    b.recordAttempt();
    expect(b.exhaustedReason()).toMatch(/attempt cap/u);
  });

  it("halts on the token budget INDEPENDENTLY of the attempt cap", () => {
    const b = new DevCycleBudget(cfg({ maxIterations: 100, tokenBudget: 1_000 }));
    b.recordTokens(999);
    expect(b.exhaustedReason()).toBeNull();
    b.recordTokens(1);
    expect(b.exhaustedReason()).toMatch(/token budget/u);
  });

  it("halts on wall-clock INDEPENDENTLY, via an injected clock", () => {
    let t = 1_000;
    const clock: Clock = { now: () => t };
    const b = new DevCycleBudget(cfg({ maxIterations: 100, tokenBudget: 10 ** 9, wallClockMs: 500 }), clock);
    t = 1_400;
    expect(b.exhaustedReason()).toBeNull();
    t = 1_500;
    expect(b.exhaustedReason()).toMatch(/wall-clock/u);
  });

  it("a $0 ceiling denies ALL positive spend, allows free actions", () => {
    const b = new DevCycleBudget(cfg({ spend: { ceilingUsd: 0 } }));
    expect(b.canSpend(0)).toBe(true);
    expect(b.canSpend(0.0001)).toBe(false);
    expect(b.canSpend(100)).toBe(false);
  });

  it("a positive ceiling permits within budget and denies once it would exceed", () => {
    const b = new DevCycleBudget(cfg({ spend: { ceilingUsd: 5, spentUsd: 4 } }));
    expect(b.canSpend(1)).toBe(true);
    expect(b.canSpend(1.01)).toBe(false);
    b.recordSpend(1);
    expect(b.canSpend(0.01)).toBe(false);
    expect(b.snapshot().spentUsd).toBe(5);
  });

  it("config is strict — unknown budget knobs are rejected", () => {
    expect(() => RunDevCycleConfigSchema.parse({ maxAttempts: 3 })).toThrow();
  });

  it("hydrates attempts, tokens, spend, and elapsed time from a validated resume seed", () => {
    let now = 10_000;
    const clock: Clock = { now: () => now };
    const b = new DevCycleBudget(
      cfg({ maxIterations: 5, tokenBudget: 10_000, wallClockMs: 2_000, spend: { ceilingUsd: 10, spentUsd: 0 } }),
      clock,
      { attempts: 2, tokens: 3_000, spentUsd: 4, elapsedMs: 1_000 }
    );

    expect(b.snapshot()).toMatchObject({ attempts: 2, tokens: 3_000, spentUsd: 4, elapsedMs: 1_000 });
    now = 10_999;
    expect(b.exhaustedReason()).toBeNull();
    now = 11_000;
    expect(b.exhaustedReason()).toMatch(/wall-clock/u);
  });

  it("does not grant a fresh attempt budget when a resumed seed is already exhausted", () => {
    const b = new DevCycleBudget(cfg({ maxIterations: 2 }), undefined, {
      attempts: 2,
      tokens: 0,
      spentUsd: 0,
      elapsedMs: 0
    });

    expect(b.exhaustedReason()).toMatch(/attempt cap reached \(2\/2\)/u);
  });

  it("rejects invalid or unknown resume-seed fields", () => {
    expect(
      () =>
        new DevCycleBudget(cfg(), undefined, {
          attempts: -1,
          tokens: 0,
          spentUsd: 0,
          elapsedMs: 0
        })
    ).toThrow();
    expect(
      () =>
        new DevCycleBudget(cfg(), undefined, {
          attempts: 0,
          tokens: 0,
          spentUsd: 0,
          elapsedMs: 0,
          resetBudget: true
        } as never)
    ).toThrow();
  });
});

describe("nextStage (P7 spine) — pure 0→7 routing", () => {
  it("drives the happy path SELECT→…→DONE", () => {
    const path: DevStage[] = [];
    let stage: DevStage = "select";
    for (let i = 0; i < 10 && stage !== "done" && stage !== "blocked"; i += 1) {
      path.push(stage);
      stage = nextStage(stage, "GREEN");
    }
    expect(path).toEqual(["select", "build", "test", "smoke", "review", "ship", "learn"]);
    expect(stage).toBe("done");
  });

  it("routes TEST/SMOKE RED into DEBUG, and DEBUG-GREEN re-validates from TEST", () => {
    expect(nextStage("test", "RED")).toBe("debug");
    expect(nextStage("smoke", "RED")).toBe("debug");
    expect(nextStage("debug", "GREEN")).toBe("test");
  });

  it("terminates (blocked) on give-up DEBUG, review-RED, build-RED, ship-RED", () => {
    expect(nextStage("debug", "RED")).toBe("blocked"); // gave up
    expect(nextStage("review", "RED")).toBe("blocked"); // a real defect must NOT ship
    expect(nextStage("build", "RED")).toBe("blocked");
    expect(nextStage("ship", "RED")).toBe("blocked");
  });

  it("SELECT with no ready task (RED) → done, not blocked", () => {
    expect(nextStage("select", "RED")).toBe("done");
  });

  it("YELLOW is a legible pass — the loop still advances", () => {
    expect(nextStage("test", "YELLOW")).toBe("smoke");
    expect(nextStage("review", "YELLOW")).toBe("ship");
  });
});

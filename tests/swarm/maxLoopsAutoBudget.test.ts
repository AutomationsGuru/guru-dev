import { describe, expect, it } from "vitest";

import { shouldContinue, type AutoBudgetPolicy, type AutoBudgetState } from '../../src/swarm/maxLoopsAutoBudget.js';

function freshState(overrides: Partial<AutoBudgetState> = {}): AutoBudgetState {
  return {
    iterationsUsed: 0,
    toolCallsUsed: 0,
    tokensUsed: 0,
    wallMsUsed: 0,
    done: false,
    ...overrides
  };
}

describe("max-loops auto budget — shouldContinue", () => {
  it("continues when not done and every axis is under its ceiling", () => {
    const policy: AutoBudgetPolicy = { maxIterations: 10, maxToolCalls: 50, maxTokens: 10_000, maxWallMs: 60_000 };
    const decision = shouldContinue(freshState({ iterationsUsed: 3, toolCallsUsed: 7, tokensUsed: 900, wallMsUsed: 5_000 }), policy);
    expect(decision.continue).toBe(true);
    expect(decision.reason).toBeUndefined();
  });

  it("continues when the policy is empty (fully unbounded) and not done", () => {
    const decision = shouldContinue(freshState({ iterationsUsed: 1_000_000, tokensUsed: 9_999_999 }), {});
    expect(decision.continue).toBe(true);
  });

  it("stops with reason=done the moment the done flag flips, even with budget left", () => {
    const policy: AutoBudgetPolicy = { maxIterations: 100 };
    const decision = shouldContinue(freshState({ done: true, iterationsUsed: 1 }), policy);
    expect(decision).toEqual({ continue: false, reason: "done" });
  });

  it("done short-circuits BEFORE the budget check — exhausted budget + done still reports done", () => {
    // The happy path must win: when the outcome lands on the same turn the
    // budget exhausts, the loop reports `done`, not a budget failure.
    const policy: AutoBudgetPolicy = { maxIterations: 5 };
    const decision = shouldContinue(freshState({ done: true, iterationsUsed: 5 }), policy);
    expect(decision).toEqual({ continue: false, reason: "done" });
  });

  it("budget stops auto: iterations ceiling reached → iterations_exhausted", () => {
    const policy: AutoBudgetPolicy = { maxIterations: 3 };
    expect(shouldContinue(freshState({ iterationsUsed: 2 }), policy).continue).toBe(true);
    const at = shouldContinue(freshState({ iterationsUsed: 3 }), policy);
    expect(at).toEqual({ continue: false, reason: "iterations_exhausted" });
    const past = shouldContinue(freshState({ iterationsUsed: 4 }), policy);
    expect(past).toEqual({ continue: false, reason: "iterations_exhausted" });
  });

  it("budget stops auto: tool-call ceiling reached → tool_calls_exhausted", () => {
    const policy: AutoBudgetPolicy = { maxToolCalls: 24 };
    expect(shouldContinue(freshState({ toolCallsUsed: 23 }), policy).continue).toBe(true);
    expect(shouldContinue(freshState({ toolCallsUsed: 24 }), policy)).toEqual({ continue: false, reason: "tool_calls_exhausted" });
  });

  it("budget stops auto: token ceiling reached → tokens_exhausted", () => {
    const policy: AutoBudgetPolicy = { maxTokens: 8_192 };
    expect(shouldContinue(freshState({ tokensUsed: 8_191 }), policy).continue).toBe(true);
    expect(shouldContinue(freshState({ tokensUsed: 8_192 }), policy)).toEqual({ continue: false, reason: "tokens_exhausted" });
  });

  it("budget stops auto: wall-clock ceiling reached → wall_ms_exhausted", () => {
    const policy: AutoBudgetPolicy = { maxWallMs: 120_000 };
    expect(shouldContinue(freshState({ wallMsUsed: 119_999 }), policy).continue).toBe(true);
    expect(shouldContinue(freshState({ wallMsUsed: 120_000 }), policy)).toEqual({ continue: false, reason: "wall_ms_exhausted" });
  });

  it("deterministic reason when several axes exhaust on the same turn (fixed order: iterations first)", () => {
    const policy: AutoBudgetPolicy = { maxIterations: 1, maxToolCalls: 1, maxTokens: 1, maxWallMs: 1 };
    const decision = shouldContinue(freshState({ iterationsUsed: 1, toolCallsUsed: 1, tokensUsed: 1, wallMsUsed: 1 }), policy);
    expect(decision).toEqual({ continue: false, reason: "iterations_exhausted" });
  });

  it("a zero ceiling is already-exhausted on the first check", () => {
    // maxIterations: 0 means "never run" — a ceiling, not a target of zero free turns.
    expect(shouldContinue(freshState(), { maxIterations: 0 })).toEqual({ continue: false, reason: "iterations_exhausted" });
  });

  it("an omitted axis is unbounded and never stops the loop on that axis", () => {
    const policy: AutoBudgetPolicy = { maxIterations: 2 };
    const decision = shouldContinue(freshState({ iterationsUsed: 1, toolCallsUsed: 999_999, tokensUsed: 999_999, wallMsUsed: 999_999 }), policy);
    expect(decision.continue).toBe(true);
  });

  it("auto mode runs until done flag OR budget hits — a simulated session", () => {
    // Walk a synthetic loop: each turn consumes budget; the loop must stop
    // exactly at the iteration ceiling when done never lands.
    const policy: AutoBudgetPolicy = { maxIterations: 4, maxToolCalls: 1_000, maxTokens: 1_000_000, maxWallMs: 3_600_000 };
    const state = { iterationsUsed: 0, toolCallsUsed: 0, tokensUsed: 0, wallMsUsed: 0, done: false };
    let turns = 0;
    let lastReason: string | undefined;
    for (;;) {
      const d = shouldContinue(state, policy);
      if (!d.continue) {
        lastReason = d.reason;
        break;
      }
      turns += 1;
      state.iterationsUsed += 1;
      state.toolCallsUsed += 3;
      state.tokensUsed += 512;
      state.wallMsUsed += 750;
    }
    expect(turns).toBe(4);
    expect(lastReason).toBe("iterations_exhausted");
  });

  it("auto mode stops mid-budget the turn the done flag lands", () => {
    const policy: AutoBudgetPolicy = { maxIterations: 100 };
    const state = { iterationsUsed: 0, toolCallsUsed: 0, tokensUsed: 0, wallMsUsed: 0, done: false };
    let turns = 0;
    let lastReason: string | undefined;
    for (;;) {
      const d = shouldContinue(state, policy);
      if (!d.continue) {
        lastReason = d.reason;
        break;
      }
      turns += 1;
      state.iterationsUsed += 1;
      if (turns === 7) {
        state.done = true; // outcome lands on turn 7, long before the ceiling
      }
    }
    expect(turns).toBe(7);
    expect(lastReason).toBe("done");
  });
});

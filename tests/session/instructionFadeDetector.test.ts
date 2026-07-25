import { describe, expect, it } from "vitest";

import {
  DEFAULT_FADE_THRESHOLDS,
  createFadeState,
  markReminded,
  shouldRemind
} from '../../src/session/instructionFadeDetector.js';

describe("instructionFadeDetector", () => {
  it("returns false when both counters are under the default thresholds", () => {
    expect(shouldRemind({ turnsSince: 0, tokensSince: 0 })).toBe(false);
    expect(shouldRemind({ turnsSince: 5, tokensSince: 2000 })).toBe(false);
    expect(shouldRemind({ turnsSince: DEFAULT_FADE_THRESHOLDS.turns - 1, tokensSince: DEFAULT_FADE_THRESHOLDS.tokens - 1 })).toBe(false);
  });

  it("returns true when turnsSince exceeds the turns threshold", () => {
    const result = shouldRemind({
      turnsSince: DEFAULT_FADE_THRESHOLDS.turns + 1,
      tokensSince: 0
    });
    expect(result).toBe(true);
  });

  it("returns true when tokensSince exceeds the tokens threshold", () => {
    const result = shouldRemind({
      turnsSince: 0,
      tokensSince: DEFAULT_FADE_THRESHOLDS.tokens + 250
    });
    expect(result).toBe(true);
  });

  it("respects caller-supplied thresholds", () => {
    expect(
      shouldRemind({
        turnsSince: 3,
        tokensSince: 100,
        thresholds: { turns: 2, tokens: 50 }
      })
    ).toBe(true);
    expect(
      shouldRemind({
        turnsSince: 1,
        tokensSince: 10,
        thresholds: { turns: 2, tokens: 50 }
      })
    ).toBe(false);
  });

  it("markReminded returns a new state that resets the offset", () => {
    const initial = createFadeState({ turn: 0, tokens: 0 });
    const reminded = markReminded(initial, { turn: 50, tokens: 12_000 });
    expect(reminded).not.toBe(initial);
    expect(reminded).toEqual({ lastRemindedTurn: 50, lastRemindedTokens: 12_000 });

    // From the new anchor, 5 turns / 100 tokens must NOT trigger; 11 turns / 4001 must.
    expect(shouldRemind({ turnsSince: 5, tokensSince: 100 })).toBe(false);
    expect(shouldRemind({ turnsSince: 11, tokensSince: 4001 })).toBe(true);
  });

  it("treats negative counters as not-due (defensive against underflow)", () => {
    expect(shouldRemind({ turnsSince: -1, tokensSince: 100 })).toBe(false);
    expect(shouldRemind({ turnsSince: 5, tokensSince: -1 })).toBe(false);
  });
});
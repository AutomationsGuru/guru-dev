import { describe, expect, it } from "vitest";

import {
  createSpendCap,
  DEFAULT_SPEND_CAP_CONFIG,
  mayCallModel,
  recordSpend,
  snapshot,
  SpendCapConfigSchema
} from '../../src/session/spendCap.js';

describe("session spend cap", () => {
  describe("createSpendCap / config", () => {
    it("defaults to a $0-denies-all fail-closed ceiling", () => {
      const cap = createSpendCap();
      expect(cap.ceilingUsd).toBe(0);
      expect(cap.spentUsd).toBe(0);
      // The default config object matches the parsed default state.
      expect(DEFAULT_SPEND_CAP_CONFIG.ceilingUsd).toBe(0);
      expect(DEFAULT_SPEND_CAP_CONFIG.spentUsd).toBe(0);
    });

    it("parses a partial config and seeds spentUsd", () => {
      const cap = createSpendCap({ ceilingUsd: 5, spentUsd: 1.5 });
      expect(cap).toEqual({ ceilingUsd: 5, spentUsd: 1.5 });
    });

    it("rejects an out-of-range ceiling (fail-closed, never permissive)", () => {
      expect(() => SpendCapConfigSchema.parse({ ceilingUsd: -1 })).toThrow();
      expect(() => createSpendCap({ spentUsd: -0.01 })).toThrow();
    });
  });

  describe("mayCallModel", () => {
    it("blocks every call when the ceiling is $0 (deny-all)", () => {
      const cap = createSpendCap(); // ceiling 0
      expect(mayCallModel(cap)).toBe(false);
      expect(mayCallModel(cap, 0)).toBe(false);
      expect(mayCallModel(cap, 0.001)).toBe(false);
    });

    it("allows a call that stays within budget", () => {
      const cap = createSpendCap({ ceilingUsd: 1 });
      expect(mayCallModel(cap, 0.1)).toBe(true);
      expect(mayCallModel(cap, 1)).toBe(true);
    });

    it("blocks a call that would push the session over budget", () => {
      const cap = createSpendCap({ ceilingUsd: 1, spentUsd: 0.9 });
      // A 0.2 call would land at 1.1 > 1 → blocked.
      expect(mayCallModel(cap, 0.2)).toBe(false);
      // Exactly to the ceiling is still allowed (≤, not <).
      expect(mayCallModel(cap, 0.1)).toBe(true);
    });

    it("treats a negative estimate as 0 — it never rescues an over-budget cap", () => {
      // At-budget (spent == ceiling): a zero/negative call is still allowed,
      // consistent with `next = spentUsd + 0 <= ceiling`.
      const atBudget = createSpendCap({ ceilingUsd: 1, spentUsd: 1 });
      expect(mayCallModel(atBudget, -5)).toBe(true);

      // Genuinely over-budget: a negative must NOT claw back headroom.
      const over = createSpendCap({ ceilingUsd: 1, spentUsd: 1.5 });
      expect(mayCallModel(over, -5)).toBe(false);

      // And a deny-all ceiling stays deny-all regardless of a negative estimate.
      const denyAll = createSpendCap({ ceilingUsd: 0 });
      expect(mayCallModel(denyAll, -5)).toBe(false);
    });
  });

  describe("recordSpend + snapshot", () => {
    it("accumulates spend and flips overBudget once past the ceiling", () => {
      const cap = createSpendCap({ ceilingUsd: 2 });

      const a = recordSpend(cap, 0.5);
      expect(a.spentUsd).toBe(0.5);
      expect(a.overBudget).toBe(false);
      expect(a.remainingUsd).toBe(1.5);
      expect(mayCallModel(cap, 1.5)).toBe(true);

      // Land exactly on the ceiling: not over yet.
      const b = recordSpend(cap, 1.5);
      expect(b.spentUsd).toBe(2);
      expect(b.overBudget).toBe(false);
      expect(b.remainingUsd).toBe(0);
      // A positive call is now blocked even though we are exactly at budget.
      expect(mayCallModel(cap, 0.01)).toBe(false);

      // One cent over: overBudget flips, remaining clamps at 0.
      const c = recordSpend(cap, 0.01);
      expect(c.spentUsd).toBe(2.01);
      expect(c.overBudget).toBe(true);
      expect(c.remainingUsd).toBe(0);
    });

    it("refuses to record a negative or non-finite amount", () => {
      const cap = createSpendCap({ ceilingUsd: 1 });
      expect(() => recordSpend(cap, -0.01)).toThrow(RangeError);
      expect(() => recordSpend(cap, Number.NaN)).toThrow(RangeError);
      expect(() => recordSpend(cap, Infinity)).toThrow(RangeError);
      // Nothing was recorded on the failed calls.
      expect(snapshot(cap).spentUsd).toBe(0);
    });

    it("reports overBudget for a deny-all ceiling regardless of spend", () => {
      const cap = createSpendCap({ ceilingUsd: 0 });
      expect(snapshot(cap).overBudget).toBe(true);
    });
  });
});

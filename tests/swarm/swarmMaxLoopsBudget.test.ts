import { describe, expect, it } from "vitest";

import { resolveMaxLoops, SwarmMaxLoopsBudgetError } from '../../src/swarm/swarmMaxLoopsBudget.js';

describe("swarm max-loops budget (IDEA-F598-MAXLOOP-01 / R-SW-AUTOLOOP)", () => {
  describe("fixed mode", () => {
    it("returns the fixed value when it is within the budget cap", () => {
      expect(resolveMaxLoops("fixed", 3, 10)).toBe(3);
    });

    it("clamps the fixed value down to the budget cap", () => {
      expect(resolveMaxLoops("fixed", 25, 10)).toBe(10);
    });

    it("clamps the fixed value up to at least 1 — zero loops is never a silent no-op", () => {
      expect(resolveMaxLoops("fixed", 0, 10)).toBe(1);
      expect(resolveMaxLoops("fixed", -5, 10)).toBe(1);
    });

    it("truncates fractional fixed values to an integer loop count", () => {
      expect(resolveMaxLoops("fixed", 4.9, 10)).toBe(4);
    });
  });

  describe("auto mode", () => {
    it("never exceeds the budget cap — auto is unbounded in intent, capped in fact", () => {
      expect(resolveMaxLoops("auto", undefined, 10)).toBe(10);
      expect(resolveMaxLoops("auto", 999, 10)).toBe(10);
    });

    it("ignores any caller-supplied fixed hint — the cap is the whole budget", () => {
      expect(resolveMaxLoops("auto", 1, 7)).toBe(7);
    });
  });

  describe("budget cap validation (fail closed)", () => {
    it("rejects a non-positive cap — a zero or negative cap would silently disable work", () => {
      expect(() => resolveMaxLoops("fixed", 3, 0)).toThrow(SwarmMaxLoopsBudgetError);
      expect(() => resolveMaxLoops("fixed", 3, -1)).toThrow(SwarmMaxLoopsBudgetError);
    });

    it("rejects a non-integer or non-finite cap", () => {
      expect(() => resolveMaxLoops("auto", undefined, 2.5)).toThrow(SwarmMaxLoopsBudgetError);
      expect(() => resolveMaxLoops("auto", undefined, Number.POSITIVE_INFINITY)).toThrow(
        SwarmMaxLoopsBudgetError
      );
      expect(() => resolveMaxLoops("auto", undefined, Number.NaN)).toThrow(SwarmMaxLoopsBudgetError);
    });

    it("rejects a non-finite fixed value rather than clamping nonsense into a loop count", () => {
      expect(() => resolveMaxLoops("fixed", Number.NaN, 10)).toThrow(SwarmMaxLoopsBudgetError);
      expect(() => resolveMaxLoops("fixed", Number.POSITIVE_INFINITY, 10)).toThrow(
        SwarmMaxLoopsBudgetError
      );
    });
  });

  describe("invariant", () => {
    it("the result is always an integer in [1, budgetCap] for valid inputs, either mode", () => {
      for (const mode of ["fixed", "auto"] as const) {
        for (const fixed of [undefined, 0, 1, 5, 100]) {
          for (const cap of [1, 3, 24]) {
            const loops = resolveMaxLoops(mode, fixed, cap);
            expect(Number.isInteger(loops)).toBe(true);
            expect(loops).toBeGreaterThanOrEqual(1);
            expect(loops).toBeLessThanOrEqual(cap);
          }
        }
      }
    });
  });
});

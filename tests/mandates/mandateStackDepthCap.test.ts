import { describe, expect, it } from "vitest";

import {
  createMandateStackDepthCap,
  MandateStackDepthExceededError,
  MANDATE_STACK_DEPTH_HARD_MAX
} from '../../src/mandates/mandateStackDepthCap.js';

describe("mandate stack depth cap (R-MDEPTH-01)", () => {
  it("push/pop tracks nesting depth up to maxDepth", () => {
    const cap = createMandateStackDepthCap({ maxDepth: 3 });
    expect(cap.depth()).toBe(0);
    cap.push();
    cap.push();
    cap.push();
    expect(cap.depth()).toBe(3);
    cap.pop();
    expect(cap.depth()).toBe(2);
    cap.pop();
    cap.pop();
    expect(cap.depth()).toBe(0);
  });

  it("depth+1 rejects with a structured error and leaves the stack unchanged", () => {
    const cap = createMandateStackDepthCap({ maxDepth: 2 });
    cap.push();
    cap.push();
    try {
      cap.push();
      expect.unreachable("push at depth+1 must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MandateStackDepthExceededError);
      const exceeded = error as MandateStackDepthExceededError;
      expect(exceeded.code).toBe("mandate_stack_depth_exceeded");
      expect(exceeded.depth).toBe(3);
      expect(exceeded.limit).toBe(2);
    }
    // Failed push did not leak depth — still exactly at the cap.
    expect(cap.depth()).toBe(2);
  });

  it("pop restores capacity: a push after pop succeeds again", () => {
    const cap = createMandateStackDepthCap({ maxDepth: 2 });
    cap.push();
    cap.push();
    expect(() => cap.push()).toThrow(MandateStackDepthExceededError);
    cap.pop();
    cap.push(); // capacity restored — back at the cap, no throw
    expect(cap.depth()).toBe(2);
  });

  it("pop on an empty stack fails closed instead of going negative", () => {
    const cap = createMandateStackDepthCap({ maxDepth: 3 });
    expect(() => cap.pop()).toThrow(/underflow/u);
    expect(cap.depth()).toBe(0);
  });

  it("defaults to maxDepth 3 and clamps config above the hard max (limits never weakened)", () => {
    expect(createMandateStackDepthCap().maxDepth).toBe(3);
    const clamped = createMandateStackDepthCap({ maxDepth: 64 });
    expect(clamped.maxDepth).toBe(MANDATE_STACK_DEPTH_HARD_MAX);
    for (let index = 0; index < MANDATE_STACK_DEPTH_HARD_MAX; index += 1) {
      clamped.push();
    }
    expect(() => clamped.push()).toThrow(MandateStackDepthExceededError);
  });

  it("rejects non-positive / non-integer maxDepth config", () => {
    expect(() => createMandateStackDepthCap({ maxDepth: 0 })).toThrow(/positive integer/u);
    expect(() => createMandateStackDepthCap({ maxDepth: -1 })).toThrow(/positive integer/u);
    expect(() => createMandateStackDepthCap({ maxDepth: 1.5 })).toThrow(/positive integer/u);
  });
});

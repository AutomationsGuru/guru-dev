import { describe, expect, it } from "vitest";

import {
  DEFAULT_SWARM_FANOUT_LIMIT,
  SwarmFanoutSaturatedError,
  createSwarmFanoutLimiter
} from '../../src/swarm/swarmFanoutLimits.js';

describe("swarmFanoutLimits — token limiter", () => {
  it("defaults to the documented ceiling when no max is given", () => {
    const limiter = createSwarmFanoutLimiter();
    expect(limiter.max).toBe(DEFAULT_SWARM_FANOUT_LIMIT);
    expect(limiter.activeCount()).toBe(0);
  });

  it("acquires up to max, then rejects with a structured saturation error", () => {
    const limiter = createSwarmFanoutLimiter({ max: 2 });
    const first = limiter.tryAcquire();
    const second = limiter.tryAcquire();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(limiter.activeCount()).toBe(2);

    const third = limiter.tryAcquire();
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.error).toBeInstanceOf(SwarmFanoutSaturatedError);
      expect(third.error.code).toBe("swarm_fanout_saturated");
      expect(third.error.limit).toBe(2);
      expect(third.error.active).toBe(2);
    }
    // Rejection must not consume a slot.
    expect(limiter.activeCount()).toBe(2);
  });

  it("release frees a slot so a new acquire succeeds", () => {
    const limiter = createSwarmFanoutLimiter({ max: 1 });
    const first = limiter.tryAcquire();
    expect(first.ok).toBe(true);
    expect(limiter.tryAcquire().ok).toBe(false);

    if (first.ok) {
      first.token.release();
    }
    expect(limiter.activeCount()).toBe(0);

    const second = limiter.tryAcquire();
    expect(second.ok).toBe(true);
    expect(limiter.activeCount()).toBe(1);
  });

  it("release is idempotent — double-release does not over-free", () => {
    const limiter = createSwarmFanoutLimiter({ max: 1 });
    const first = limiter.tryAcquire();
    expect(first.ok).toBe(true);
    if (first.ok) {
      first.token.release();
      first.token.release();
    }
    expect(limiter.activeCount()).toBe(0);
  });

  it("rejects non-positive or non-integer max at construction", () => {
    expect(() => createSwarmFanoutLimiter({ max: 0 })).toThrow();
    expect(() => createSwarmFanoutLimiter({ max: -1 })).toThrow();
    expect(() => createSwarmFanoutLimiter({ max: 1.5 })).toThrow();
  });

  it("tokens from one limiter cannot release into another", () => {
    const a = createSwarmFanoutLimiter({ max: 1 });
    const b = createSwarmFanoutLimiter({ max: 1 });
    const acquired = a.tryAcquire();
    expect(acquired.ok).toBe(true);
    expect(b.activeCount()).toBe(0);
    if (acquired.ok) {
      acquired.token.release();
    }
    expect(a.activeCount()).toBe(0);
    expect(b.activeCount()).toBe(0);
  });

  it("churn invariant: 0 <= activeCount <= max across a mixed acquire/release loop", () => {
    const max = 3;
    const limiter = createSwarmFanoutLimiter({ max });
    const held: Array<{ release(): void }> = [];
    for (let i = 0; i < 200; i += 1) {
      // Deterministic pseudo-random pattern: alternate fill and drain phases.
      if (i % 3 === 2 && held.length > 0) {
        held.shift()?.release();
      } else {
        const result = limiter.tryAcquire();
        if (result.ok) held.push(result.token);
      }
      expect(limiter.activeCount()).toBeGreaterThanOrEqual(0);
      expect(limiter.activeCount()).toBeLessThanOrEqual(max);
      expect(limiter.activeCount()).toBe(held.length);
    }
    for (const token of held) token.release();
    expect(limiter.activeCount()).toBe(0);
  });
});

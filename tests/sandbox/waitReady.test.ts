import { describe, expect, it } from "vitest";

import { waitReady } from '../../src/sandbox/waitReady.js';

describe("waitReady", () => {
  it("returns when the predicate is immediately ready", () => {
    let calls = 0;

    expect(() =>
      waitReady({
        isReady: () => {
          calls += 1;
          return true;
        },
        timeoutMs: 100,
        now: () => 0
      })
    ).not.toThrow();
    expect(calls).toBe(1);
  });

  it("polls until the predicate becomes ready", () => {
    let attempts = 0;
    const now = (() => {
      let current = 0;
      return () => current++;
    })();

    waitReady({
      isReady: () => {
        attempts += 1;
        return attempts === 3;
      },
      timeoutMs: 10,
      now
    });

    expect(attempts).toBe(3);
  });

  it("throws when the predicate remains unready until the timeout", () => {
    const now = (() => {
      let current = 0;
      return () => current++;
    })();

    expect(() => waitReady({ isReady: () => false, timeoutMs: 3, now })).toThrow("Sandbox did not become ready within 3ms.");
  });
});

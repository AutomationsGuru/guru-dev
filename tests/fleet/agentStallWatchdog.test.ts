import { describe, expect, it } from "vitest";

import { isStalled } from '../../src/fleet/agentStallWatchdog.js';

describe("isStalled", () => {
  it("returns true when the clock is past the stall timeout", () => {
    expect(isStalled(1_000, 2_001, 1_000)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import { nextFire } from '../../src/fleet/heartbeatSchedulePolicy.js';

describe("heartbeatSchedulePolicy", () => {
  it("advances by exact interval", () => {
    const last = new Date("2026-07-19T10:00:00Z");
    const next = nextFire(last, 60_000);
    expect(next).toEqual(new Date("2026-07-19T10:01:00Z"));
  });

  it("rejects zero or negative interval (zero invalid)", () => {
    expect(() => nextFire(Date.now(), 0)).toThrow(/positive/);
    expect(() => nextFire(Date.now(), -100)).toThrow(/positive/);
  });
});

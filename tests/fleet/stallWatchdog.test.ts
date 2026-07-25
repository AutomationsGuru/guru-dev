import { describe, it, expect } from "vitest";

import {
  checkStall,
  isStalled,
  NO_PROGRESS,
  StallVerdictSchema,
  type LastProgress
} from '../../src/fleet/stallWatchdog.js';

const TIMEOUT = 60_000;
const T0 = 1_000_000;

describe("stall watchdog check (pure clock-driven)", () => {
  it("elapsed past timeout ⇒ stalled, carrying elapsed evidence", () => {
    const result = checkStall(T0, T0 + TIMEOUT + 1, TIMEOUT);
    expect(result.verdict).toBe("stalled");
    expect(result.elapsedMs).toBeUndefined();
    expect(result.evidence).toContain("elapsed");
    expect(result.evidence).toContain(`${TIMEOUT + 1}ms`);
  });

  it("exactly at timeout ⇒ progressing (strictly greater-than boundary)", () => {
    const result = checkStall(T0, T0 + TIMEOUT, TIMEOUT);
    expect(result.verdict).toBe("progressing");
  });

  it("well within timeout ⇒ progressing", () => {
    const result = checkStall(T0, T0 + 5_000, TIMEOUT);
    expect(result.verdict).toBe("progressing");
  });

  it("unknown last progress ⇒ unknown, never rounds up to stalled", () => {
    const result = checkStall(NO_PROGRESS, T0 + TIMEOUT + 1, TIMEOUT);
    expect(result.verdict).toBe("unknown");
    expect(result.evidence).toContain("no progress");
  });

  it("invalid timeoutMs ⇒ unknown (a malformed limit is not a stall verdict)", () => {
    expect(checkStall(T0, T0 + 10, NaN).verdict).toBe("unknown");
    expect(checkStall(T0, T0 + 10, -1).verdict).toBe("unknown");
    expect(checkStall(T0, T0 + 10, Number.POSITIVE_INFINITY).verdict).toBe("unknown");
  });

  it("invalid now ⇒ unknown", () => {
    expect(checkStall(T0, NaN, TIMEOUT).verdict).toBe("unknown");
  });

  it("clock skew (lastProgress in the future) never raises a false stall", () => {
    const result = checkStall(T0 + 5_000, T0, TIMEOUT);
    expect(result.verdict).toBe("progressing");
  });

  it("zero timeout: any positive elapsed ⇒ stalled, equal ⇒ progressing", () => {
    expect(checkStall(T0, T0 + 1, 0).verdict).toBe("stalled");
    expect(checkStall(T0, T0, 0).verdict).toBe("progressing");
  });

  it("isStalled helper mirrors the verdict flag", () => {
    expect(isStalled(T0, T0 + TIMEOUT + 1, TIMEOUT)).toBe(true);
    expect(isStalled(T0, T0 + 1, TIMEOUT)).toBe(false);
    expect(isStalled(NO_PROGRESS, T0 + TIMEOUT + 1, TIMEOUT)).toBe(false);
  });

  it("NO_PROGRESS is a stable symbol distinct from any epoch", () => {
    const symbol: LastProgress = NO_PROGRESS;
    expect(typeof symbol).toBe("symbol");
    expect(symbol === (0 as LastProgress)).toBe(false);
  });

  it("verdict schema accepts the three canonical states", () => {
    expect(StallVerdictSchema.parse("stalled")).toBe("stalled");
    expect(StallVerdictSchema.parse("progressing")).toBe("progressing");
    expect(StallVerdictSchema.parse("unknown")).toBe("unknown");
    expect(() => StallVerdictSchema.parse("killed")).toThrow();
  });
});

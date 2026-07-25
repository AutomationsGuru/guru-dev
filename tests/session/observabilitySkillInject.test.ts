import { describe, expect, it } from "vitest";

import {
  hooksFor,
  type ObservabilityProfile
} from '../../src/session/observabilitySkillInject.js';

describe("observabilitySkillInject — hooksFor", () => {
  it("returns empty when profile is off", () => {
    expect(hooksFor("off")).toEqual([]);
  });

  it("returns trace and log hooks when profile is on", () => {
    expect(hooksFor("on")).toEqual(["obs.trace", "obs.log"]);
  });

  it("fails closed for non-on runtime values", () => {
    expect(hooksFor("off" as ObservabilityProfile)).toEqual([]);
    // Runtime callers may pass unexpected strings; non-on must stay empty.
    expect(hooksFor("maybe" as ObservabilityProfile)).toEqual([]);
    expect(hooksFor("" as ObservabilityProfile)).toEqual([]);
  });

  it("does not mutate the on-hooks list across calls", () => {
    const first = hooksFor("on");
    const second = hooksFor("on");
    expect(first).toBe(second);
    expect(first).toEqual(["obs.trace", "obs.log"]);
  });
});

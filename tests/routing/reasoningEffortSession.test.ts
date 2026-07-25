import { describe, expect, it, beforeEach } from "vitest";

import {
  type ReasoningEffort,
  type ReasoningEffortParams,
  effortMap,
  setEffort,
  getEffort,
  clear,
  toProviderParams,
} from '../../src/routing/reasoningEffortSession.js';

describe("reasoningEffortSession", () => {
  beforeEach(() => {
    clear();
  });

  it("sets and gets the current reasoning effort", () => {
    setEffort("high");
    expect(getEffort()).toBe("high");

    setEffort("none");
    expect(getEffort()).toBe("none");
  });

  it("defaults to medium", () => {
    expect(getEffort()).toBe("medium");
  });

  it("clear() resets to the default effort (medium)", () => {
    setEffort("high");
    expect(getEffort()).toBe("high");

    clear();
    expect(getEffort()).toBe("medium");
  });

  it("rejects an unknown effort level", () => {
    expect(() => setEffort("turbo" as ReasoningEffort)).toThrow(
      /Invalid reasoning effort/,
    );
  });

  it("maps each level to provider params without emitting a model id", () => {
    const cases: Array<[ReasoningEffort, ReasoningEffortParams]> = [
      ["none", { reasoning_effort: undefined, thinking: false }],
      ["minimal", { reasoning_effort: "minimal", thinking: false }],
      ["low", { reasoning_effort: "low", thinking: true }],
      ["medium", { reasoning_effort: "medium", thinking: true }],
      ["high", { reasoning_effort: "high", thinking: true }],
    ];

    for (const [level, expected] of cases) {
      expect(toProviderParams(level)).toEqual(expected);
    }
  });

  it("toProviderParams('high') surfaces reasoning_effort='high'", () => {
    expect(toProviderParams("high").reasoning_effort).toBe("high");
    expect(toProviderParams("high").thinking).toBe(true);
  });

  it("toProviderParams('none') disables reasoning effort and thinking", () => {
    const params = toProviderParams("none");
    expect(params.reasoning_effort).toBeUndefined();
    expect(params.thinking).toBe(false);
  });

  it("toProviderParams() with no arg uses the current effort", () => {
    setEffort("low");
    expect(toProviderParams()).toEqual(toProviderParams("low"));
  });

  it("exposes the full effort map", () => {
    expect(Object.keys(effortMap).sort()).toEqual(
      ["high", "low", "medium", "minimal", "none"].sort(),
    );
    expect(effortMap["high"]).toEqual({
      reasoning_effort: "high",
      thinking: true,
    });
  });
});

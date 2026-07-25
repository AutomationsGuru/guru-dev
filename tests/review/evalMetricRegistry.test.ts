import { describe, expect, it } from "vitest";

import { createEvalMetricRegistry, type EvalMetricScorer } from '../../src/review/evalMetricRegistry.js';

describe("eval metric registry", () => {
  it("registers a metric and runs its scorer by id", () => {
    const registry = createEvalMetricRegistry<number, number>();
    const scorer: EvalMetricScorer<number, number> = (value) => value * 2;

    registry.register("double", scorer);

    expect(registry.get("double")).toBe(scorer);
    expect(registry.score("double", 3)).toBe(6);
  });

  it("lists available metric ids in deterministic order", () => {
    const registry = createEvalMetricRegistry<string, number>();

    registry.register("quality", (value) => value.length);
    registry.register("coverage", (value) => value.length * 2);

    expect(registry.list()).toEqual(["coverage", "quality"]);
  });

  it("rejects duplicate metric ids", () => {
    const registry = createEvalMetricRegistry<number, number>();
    registry.register("quality", (value) => value);

    expect(() => registry.register("quality", (value) => value + 1)).toThrow("Metric already registered: quality");
  });

  it("fails clearly when a requested metric is missing", () => {
    const registry = createEvalMetricRegistry<number, number>();

    expect(registry.get("missing")).toBeUndefined();
    expect(() => registry.score("missing", 1)).toThrow("Metric not registered: missing");
  });
});

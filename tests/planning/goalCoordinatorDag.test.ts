import { describe, expect, it } from "vitest";

import { waves, type Goal } from '../../src/planning/goalCoordinatorDag.js';

describe("goalCoordinatorDag — waves (topological levels)", () => {
  it("returns empty waves for no goals", () => {
    expect(waves([])).toEqual([]);
  });

  it("single goal with no deps is wave 0", () => {
    const goals: Goal[] = [{ id: "A" }];
    expect(waves(goals)).toEqual([["A"]]);
  });

  it("two independent goals are in same wave", () => {
    const goals: Goal[] = [{ id: "A" }, { id: "B" }];
    const result = waves(goals);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(expect.arrayContaining(["A", "B"]));
  });

  it("simple chain A->B produces two waves", () => {
    const goals: Goal[] = [
      { id: "A" },
      { id: "B", deps: ["A"] }
    ];
    expect(waves(goals)).toEqual([["A"], ["B"]]);
  });

  it("diamond: A->B, A->C, B+C->D produces correct waves", () => {
    const goals: Goal[] = [
      { id: "A" },
      { id: "B", deps: ["A"] },
      { id: "C", deps: ["A"] },
      { id: "D", deps: ["B", "C"] }
    ];
    const result = waves(goals);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(["A"]);
    expect(result[1]).toEqual(expect.arrayContaining(["B", "C"]));
    expect(result[2]).toEqual(["D"]);
  });

  it("throws on direct cycle A->A", () => {
    const goals: Goal[] = [{ id: "A", deps: ["A"] }];
    expect(() => waves(goals)).toThrow(/cycle/i);
  });

  it("throws on longer cycle A->B->C->A", () => {
    const goals: Goal[] = [
      { id: "A", deps: ["B"] },
      { id: "B", deps: ["C"] },
      { id: "C", deps: ["A"] }
    ];
    expect(() => waves(goals)).toThrow(/cycle detected|cycle/i);
  });

  it("ignores unknown deps (missing goal ids treated as external)", () => {
    const goals: Goal[] = [
      { id: "A", deps: ["missing"] }
    ];
    // still wave 0 since external dep assumed satisfied
    expect(waves(goals)).toEqual([["A"]]);
  });
});

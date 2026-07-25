import {
  computeWaves,
  TaskDependencyError,
  type DependencyTask
} from '../../src/planning/taskDependencyWaves.js';

describe("computeWaves", () => {
  it("returns no waves for empty input", () => {
    expect(computeWaves([])).toEqual([]);
  });

  it("schedules a linear chain one task per wave", () => {
    const tasks: DependencyTask[] = [
      { id: "c", dependsOn: ["b"] },
      { id: "a" },
      { id: "b", dependsOn: ["a"] }
    ];

    expect(computeWaves(tasks)).toEqual([["a"], ["b"], ["c"]]);
  });

  it("schedules a diamond with shared base and converging top", () => {
    const tasks: DependencyTask[] = [
      { id: "top", dependsOn: ["left", "right"] },
      { id: "left", dependsOn: ["base"] },
      { id: "right", dependsOn: ["base"] },
      { id: "base" }
    ];

    expect(computeWaves(tasks)).toEqual([["base"], ["left", "right"], ["top"]]);
  });

  it("places independent tasks together in wave 1, sorted", () => {
    const tasks: DependencyTask[] = [{ id: "zeta" }, { id: "alpha" }, { id: "mid" }];

    expect(computeWaves(tasks)).toEqual([["alpha", "mid", "zeta"]]);
  });

  it("treats a missing dependsOn the same as an empty list", () => {
    const waves = computeWaves([{ id: "a" }, { id: "b", dependsOn: [] }]);

    expect(waves).toEqual([["a", "b"]]);
  });

  it("is deterministic regardless of input ordering", () => {
    const forward = computeWaves([
      { id: "b", dependsOn: ["a"] },
      { id: "a" },
      { id: "c", dependsOn: ["a"] }
    ]);
    const reversed = computeWaves([
      { id: "c", dependsOn: ["a"] },
      { id: "a" },
      { id: "b", dependsOn: ["a"] }
    ]);

    expect(forward).toEqual([["a"], ["b", "c"]]);
    expect(reversed).toEqual(forward);
  });

  it("throws a structured cycle error for a two-task cycle", () => {
    const tasks: DependencyTask[] = [
      { id: "a", dependsOn: ["b"] },
      { id: "b", dependsOn: ["a"] }
    ];

    let caught: unknown;
    try {
      computeWaves(tasks);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TaskDependencyError);
    const failure = caught as TaskDependencyError;
    expect(failure.code).toBe("DEPENDENCY_CYCLE");
    expect(failure.cycle).toBeDefined();
    expect(failure.cycle?.[0]).toBe(failure.cycle?.at(-1));
    expect(new Set(failure.cycle)).toEqual(new Set(["a", "b"]));
    expect(failure.message).toContain("cycle");
  });

  it("reports a self-dependency as a cycle", () => {
    let caught: unknown;
    try {
      computeWaves([{ id: "a", dependsOn: ["a"] }]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TaskDependencyError);
    const failure = caught as TaskDependencyError;
    expect(failure.code).toBe("DEPENDENCY_CYCLE");
    expect(failure.cycle).toEqual(["a", "a"]);
  });

  it("detects a cycle reachable from an acyclic prefix", () => {
    const tasks: DependencyTask[] = [
      { id: "root" },
      { id: "x", dependsOn: ["root", "y"] },
      { id: "y", dependsOn: ["x"] }
    ];

    expect(() => computeWaves(tasks)).toThrow(TaskDependencyError);
  });

  it("throws a structured error for duplicate task ids", () => {
    let caught: unknown;
    try {
      computeWaves([{ id: "a" }, { id: "a", dependsOn: [] }]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TaskDependencyError);
    expect((caught as TaskDependencyError).code).toBe("DUPLICATE_TASK_ID");
    expect((caught as TaskDependencyError).message).toContain("a");
  });

  it("throws a structured error for a dependency on an unknown task id", () => {
    let caught: unknown;
    try {
      computeWaves([{ id: "a", dependsOn: ["ghost"] }]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TaskDependencyError);
    const failure = caught as TaskDependencyError;
    expect(failure.code).toBe("UNKNOWN_DEPENDENCY");
    expect(failure.message).toContain("ghost");
  });
});

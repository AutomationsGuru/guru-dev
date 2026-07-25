import { describe, expect, it } from "vitest";

import { fromGoal, type GoalPanelStatus } from '../../src/planning/goalPanelStatus.js';

describe("goalPanelStatus.fromGoal", () => {
  it("formats an active goal: criteriaCount derived, active true", () => {
    const status = fromGoal({
      objective: "Ship the goal panel",
      status: "active",
      acceptanceCriteria: [
        { text: "Panel renders objective" },
        { text: "Panel renders status" }
      ]
    });

    expect(status).toEqual({
      objective: "Ship the goal panel",
      status: "active",
      criteriaCount: 2,
      active: true
    });
  });

  it("formats a paused goal: active false, criteriaCount preserved", () => {
    const status = fromGoal({
      objective: "Hold steady",
      status: "paused",
      acceptanceCriteria: [{ text: "Do not regress" }]
    });

    expect(status).toEqual({
      objective: "Hold steady",
      status: "paused",
      criteriaCount: 1,
      active: false
    });
  });

  it("formats a zero-criteria active goal without treating it as missing", () => {
    const status = fromGoal({
      objective: "Explore",
      status: "active",
      acceptanceCriteria: []
    });

    expect(status.criteriaCount).toBe(0);
    expect(status.active).toBe(true);
  });

  it("formats completed and blocked goals as inactive", () => {
    const base = {
      objective: "Wrap up",
      acceptanceCriteria: [{ text: "Done" }, { text: "Verified" }, { text: "Reviewed" }]
    };

    const completed = fromGoal({ ...base, status: "completed" });
    const blocked = fromGoal({ ...base, status: "blocked" });

    expect(completed).toEqual({
      objective: "Wrap up",
      status: "completed",
      criteriaCount: 3,
      active: false
    });
    expect(blocked).toEqual({
      objective: "Wrap up",
      status: "blocked",
      criteriaCount: 3,
      active: false
    });
  });

  it("returns an operator-facing snapshot shaped for TUI binding", () => {
    const status: GoalPanelStatus = fromGoal({
      objective: "Typecheck the seam",
      status: "active",
      acceptanceCriteria: [{ id: "c1", text: "tsc clean", accepted: true }]
    });

    // Only the four operator-facing fields are exposed.
    expect(Object.keys(status).sort()).toEqual([
      "active",
      "criteriaCount",
      "objective",
      "status"
    ]);
    // Input goal object is not mutated or retained by reference in the snapshot.
    expect(status.objective).toBe("Typecheck the seam");
  });
});

import { createDirectionAlignmentReport } from "../../src/direction/hereThere.js";
import { applySelfBuildProgress, createSelfBuildState, planNextSelfBuildTask } from "../../src/kernel/selfBuildLoop.js";

describe("createDirectionAlignmentReport", () => {
  it("should pass when HERE/THERE and the selected task align to the independent agent harness target", () => {
    const state = applySelfBuildProgress(createSelfBuildState(), [
      "capture-operating-contract",
      "core-result-contracts",
      "supabase-operational-store",
      "self-build-loop",
      "config-loader",
      "tool-registry",
      "repo-context-layer",
      "review-gates",
      "git-pr-automation",
      "maintenance-loop",
      "supabase-runtime-adapter",
      "skill-loader",
      "direction-gate",
      "harness-runtime-nucleus"
    ]);
    const task = planNextSelfBuildTask(state);

    const report = createDirectionAlignmentReport({ here: state.here, there: state.there, ...(task ? { task } : {}) });

    expect(report.verdict).toBe("GREEN");
    expect(report.there).toContain("independent agent harness");
    expect(report.task?.id).toBe("planner-runtime");
    expect(report.checks.every((check) => check.status === "passed")).toBe(true);
  });

  it("should fail when THERE does not define an independent agent harness", () => {
    const report = createDirectionAlignmentReport({
      here: "GuruHarness currently has a tested TypeScript harness substrate with repo and skill primitives.",
      there: "GuruHarness should be an autonomous coding loop that writes code by itself for every task.",
      task: {
        id: "example",
        title: "Example",
        description: "Example task.",
        thereContribution: "Adds a runtime tool to the harness."
      }
    });

    expect(report.verdict).toBe("RED");
    expect(report.checks.find((check) => check.id === "there-target")).toMatchObject({ status: "failed" });
  });

  it("should fail when a task has no explicit independent agent harness contribution", () => {
    const state = createSelfBuildState();
    const report = createDirectionAlignmentReport({
      here: state.here,
      there: state.there,
      task: {
        id: "off-target",
        title: "Off target",
        description: "Do something unrelated.",
        thereContribution: "Changes an unrelated product surface."
      }
    });

    expect(report.verdict).toBe("RED");
    expect(report.checks.find((check) => check.id === "task-there-contribution")).toMatchObject({ status: "failed" });
  });
});

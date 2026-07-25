import { describe, expect, it } from "vitest";

import {
  WorkflowDryRunReportSchema,
  WorkflowStepSchema,
  dryRunWorkflow,
  type WorkflowDryRunReport,
  type WorkflowStep
} from '../../src/workflow/workflowDryRun.js';

describe("WorkflowStepSchema", () => {
  it("accepts a minimal read-only step", () => {
    const result = WorkflowStepSchema.safeParse({
      id: "read-repo",
      toolId: "read_file",
      effect: "read-only",
      description: "Read the affected source file."
    });

    expect(result.success).toBe(true);
  });

  it("accepts a mutating step with input and rationale", () => {
    const result = WorkflowStepSchema.safeParse({
      id: "write-patch",
      toolId: "write_file",
      effect: "mutating",
      description: "Write the patched file.",
      input: { path: "src/example.ts" },
      rationale: "Applies the planned edit."
    });

    expect(result.success).toBe(true);
  });

  it("defaults effect to read-only when omitted", () => {
    const parsed = WorkflowStepSchema.parse({
      id: "probe",
      toolId: "read_file",
      description: "Probe the tree."
    });

    expect(parsed.effect).toBe("read-only");
  });

  it("rejects an unknown effect", () => {
    const result = WorkflowStepSchema.safeParse({
      id: "bad",
      toolId: "read_file",
      effect: "nuclear",
      description: "Bad effect."
    });

    expect(result.success).toBe(false);
  });

  it("rejects an empty id, toolId, or description", () => {
    for (const bad of [
      { id: "", toolId: "read_file", description: "d" },
      { id: "x", toolId: "", description: "d" },
      { id: "x", toolId: "read_file", description: "" }
    ]) {
      expect(WorkflowStepSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("rejects a duplicate step id at the workflow level", () => {
    const steps: WorkflowStep[] = [
      { id: "dup", toolId: "read_file", effect: "read-only", description: "first" },
      { id: "dup", toolId: "read_file", effect: "read-only", description: "second" }
    ];

    expect(() => dryRunWorkflow(steps)).toThrow(/duplicate step id/i);
  });
});

describe("dryRunWorkflow", () => {
  it("returns a planned-actions list with one entry per step, in order", () => {
    const steps: WorkflowStep[] = [
      { id: "a", toolId: "read_file", effect: "read-only", description: "Read A." },
      { id: "b", toolId: "write_file", effect: "mutating", description: "Write B.", input: { path: "b.ts" } }
    ];

    const report = dryRunWorkflow(steps);

    expect(report.actions).toHaveLength(2);
    expect(report.actions[0]!.stepId).toBe("a");
    expect(report.actions[1]!.stepId).toBe("b");
    expect(report.actions.map((action) => action.toolId)).toEqual(["read_file", "write_file"]);
  });

  it("marks every planned action as not executed (wouldExecute reflects effect)", () => {
    const steps: WorkflowStep[] = [
      { id: "a", toolId: "read_file", effect: "read-only", description: "Read A." },
      { id: "b", toolId: "write_file", effect: "mutating", description: "Write B." }
    ];

    const report = dryRunWorkflow(steps);

    expect(report.executed).toBe(false);
    expect(report.actions.every((action) => action.executed === false)).toBe(true);
    // A read-only step would not mutate even if run; a mutating step would.
    expect(report.actions[0]!.wouldExecute).toBe(false);
    expect(report.actions[1]!.wouldExecute).toBe(true);
  });

  it("summarizes effect counts (read-only vs mutating) without running anything", () => {
    const steps: WorkflowStep[] = [
      { id: "a", toolId: "read_file", effect: "read-only", description: "Read A." },
      { id: "b", toolId: "read_file", effect: "read-only", description: "Read B." },
      { id: "c", toolId: "write_file", effect: "mutating", description: "Write C." }
    ];

    const report = dryRunWorkflow(steps);

    expect(report.summary.readOnlyCount).toBe(2);
    expect(report.summary.mutatingCount).toBe(1);
    expect(report.summary.totalSteps).toBe(3);
  });

  it("preserves step input and rationale on the planned action", () => {
    const steps: WorkflowStep[] = [
      {
        id: "a",
        toolId: "write_file",
        effect: "mutating",
        description: "Write A.",
        input: { path: "a.ts", content: "x" },
        rationale: "Applies the edit."
      }
    ];

    const report = dryRunWorkflow(steps);

    expect(report.actions[0]!.input).toEqual({ path: "a.ts", content: "x" });
    expect(report.actions[0]!.rationale).toBe("Applies the edit.");
  });

  it("returns an empty plan for an empty step list", () => {
    const report = dryRunWorkflow([]);

    expect(report.executed).toBe(false);
    expect(report.actions).toEqual([]);
    expect(report.summary).toEqual({ totalSteps: 0, readOnlyCount: 0, mutatingCount: 0 });
  });

  it("never calls an executor — a spy executor injected via metadata is not invoked", () => {
    let calls = 0;
    // The dry-run must not accept an executor at all; simulate an adversarial caller
    // trying to slip one in via step input. The walker must not call any function
    // it finds there.
    const fakeExecutor = (): void => {
      calls += 1;
    };

    const steps: WorkflowStep[] = [
      {
        id: "a",
        toolId: "write_file",
        effect: "mutating",
        description: "Write A.",
        input: { executor: fakeExecutor }
      }
    ];

    const report = dryRunWorkflow(steps);

    expect(calls).toBe(0);
    expect(report.executed).toBe(false);
  });

  it("round-trips through WorkflowDryRunReportSchema with executed:false", () => {
    const report: WorkflowDryRunReport = dryRunWorkflow([
      { id: "a", toolId: "read_file", effect: "read-only", description: "Read A." }
    ]);

    const parsed = WorkflowDryRunReportSchema.safeParse(report);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.executed).toBe(false);
    }
  });
});

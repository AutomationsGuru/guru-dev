import { describe, expect, it } from "vitest";

import {
  dryRun,
  PlannedActionSchema,
  WorkflowDryRunResultSchema,
  WorkflowStepSchema
} from '../../src/workflow/workflowDryRun.js';

// ── helpers ────────────────────────────────────────────────────────────────

/** A valid step fixture used across tests. */
function validStep(overrides?: Partial<{ id: string; title: string; toolId: string; input: unknown }>) {
  return {
    id: overrides?.id ?? "step-1",
    title: overrides?.title ?? "Read a file",
    toolId: overrides?.toolId ?? "read",
    input: overrides?.input ?? { filePath: "/tmp/example.txt" }
  };
}

// ── schema unit tests ──────────────────────────────────────────────────────

describe("WorkflowStepSchema", () => {
  it("accepts a well-formed step", () => {
    expect(WorkflowStepSchema.safeParse(validStep()).success).toBe(true);
  });

  it("rejects a step missing id", () => {
    const result = WorkflowStepSchema.safeParse({ title: "x", toolId: "y", input: {} });
    expect(result.success).toBe(false);
  });

  it("rejects a step with empty id", () => {
    const result = WorkflowStepSchema.safeParse({ id: "  ", title: "x", toolId: "y", input: {} });
    expect(result.success).toBe(false);
  });

  it("rejects a step missing title", () => {
    const result = WorkflowStepSchema.safeParse({ id: "s1", toolId: "y", input: {} });
    expect(result.success).toBe(false);
  });

  it("rejects a step with empty title", () => {
    const result = WorkflowStepSchema.safeParse({ id: "s1", title: "", toolId: "y", input: {} });
    expect(result.success).toBe(false);
  });

  it("rejects a step missing toolId", () => {
    const result = WorkflowStepSchema.safeParse({ id: "s1", title: "x", input: {} });
    expect(result.success).toBe(false);
  });

  it("rejects extra properties", () => {
    const result = WorkflowStepSchema.safeParse({
      id: "s1",
      title: "x",
      toolId: "y",
      input: {},
      extra: true
    });
    expect(result.success).toBe(false);
  });
});

describe("PlannedActionSchema", () => {
  it("accepts a will-run action", () => {
    const result = PlannedActionSchema.safeParse({
      stepId: "s1",
      stepTitle: "Read",
      toolId: "read",
      status: "will-run",
      reason: "valid"
    });
    expect(result.success).toBe(true);
  });

  it("accepts a blocked action", () => {
    const result = PlannedActionSchema.safeParse({
      stepId: "s1",
      stepTitle: "Read",
      toolId: "read",
      status: "blocked",
      reason: "missing field"
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown status", () => {
    const result = PlannedActionSchema.safeParse({
      stepId: "s1",
      stepTitle: "Read",
      toolId: "read",
      status: "unknown-status",
      reason: "x"
    });
    expect(result.success).toBe(false);
  });
});

describe("WorkflowDryRunResultSchema", () => {
  it("accepts a valid result", () => {
    const result = WorkflowDryRunResultSchema.safeParse({
      steps: [validStep()],
      plannedActions: [
        {
          stepId: "step-1",
          stepTitle: "Read a file",
          toolId: "read",
          status: "will-run",
          reason: "step is valid and would execute"
        }
      ],
      summary: "DRY RUN — all 1 step(s) would execute; 0 blocked. Nothing was executed.",
      totalSteps: 1,
      willRunCount: 1,
      blockedCount: 0
    });
    expect(result.success).toBe(true);
  });

  it("rejects when counts don't add up", () => {
    const result = WorkflowDryRunResultSchema.safeParse({
      steps: [validStep()],
      plannedActions: [
        {
          stepId: "step-1",
          stepTitle: "Read a file",
          toolId: "read",
          status: "will-run",
          reason: "step is valid and would execute"
        }
      ],
      summary: "mismatch",
      totalSteps: 1,
      willRunCount: 5,
      blockedCount: 0
    });
    expect(result.success).toBe(false);
  });

  it("rejects when plannedActions length doesn't match totalSteps", () => {
    const result = WorkflowDryRunResultSchema.safeParse({
      steps: [validStep(), validStep({ id: "step-2" })],
      plannedActions: [
        {
          stepId: "step-1",
          stepTitle: "Read a file",
          toolId: "read",
          status: "will-run",
          reason: "step is valid and would execute"
        }
      ],
      summary: "mismatch",
      totalSteps: 2,
      willRunCount: 2,
      blockedCount: 0
    });
    expect(result.success).toBe(false);
  });
});

// ── dryRun integration tests ────────────────────────────────────────────────

describe("dryRun", () => {
  // ── happy path ─────────────────────────────────────────────────────────

  it("returns a full result for a single valid step", () => {
    const steps = [validStep()];
    const result = dryRun(steps);

    expect(result.totalSteps).toBe(1);
    expect(result.willRunCount).toBe(1);
    expect(result.blockedCount).toBe(0);
    expect(result.plannedActions).toHaveLength(1);
    expect(result.steps).toHaveLength(1);

    const action = result.plannedActions[0]!;
    expect(action.stepId).toBe("step-1");
    expect(action.stepTitle).toBe("Read a file");
    expect(action.toolId).toBe("read");
    expect(action.status).toBe("will-run");
    expect(action.reason).toBe("step is valid and would execute");
  });

  it("handles multiple valid steps with unique ids", () => {
    const steps = [
      validStep({ id: "step-1", title: "Read config" }),
      validStep({ id: "step-2", title: "Parse config" }),
      validStep({ id: "step-3", title: "Apply config" })
    ];
    const result = dryRun(steps);

    expect(result.totalSteps).toBe(3);
    expect(result.willRunCount).toBe(3);
    expect(result.blockedCount).toBe(0);
    expect(result.plannedActions).toHaveLength(3);
    expect(result.plannedActions.every((a) => a.status === "will-run")).toBe(true);
    expect(result.summary).toContain("all 3 step(s) would execute");
  });

  it("returns an empty result for zero steps", () => {
    const result = dryRun([]);

    expect(result.totalSteps).toBe(0);
    expect(result.willRunCount).toBe(0);
    expect(result.blockedCount).toBe(0);
    expect(result.plannedActions).toHaveLength(0);
    expect(result.steps).toHaveLength(0);
    expect(result.summary).toContain("all 0 step(s) would execute");
  });

  // ── blocked: validation failures ───────────────────────────────────────

  it("blocks a step with a missing id", () => {
    const steps = [{ title: "No ID", toolId: "read", input: {} }] as unknown as Parameters<
      typeof dryRun
    >[0];
    const result = dryRun(steps);

    expect(result.totalSteps).toBe(1);
    expect(result.willRunCount).toBe(0);
    expect(result.blockedCount).toBe(1);
    expect(result.plannedActions[0]!.status).toBe("blocked");
    expect(result.plannedActions[0]!.reason).toContain("validation failed");
    expect(result.summary).toContain("1 blocked");
  });

  it("blocks a step with an empty title", () => {
    const steps = [{ id: "s1", title: "  ", toolId: "read", input: {} }] as unknown as Parameters<
      typeof dryRun
    >[0];
    const result = dryRun(steps);

    expect(result.plannedActions[0]!.status).toBe("blocked");
  });

  it("blocks a step with an empty toolId", () => {
    const steps = [{ id: "s1", title: "x", toolId: "", input: {} }] as unknown as Parameters<
      typeof dryRun
    >[0];
    const result = dryRun(steps);

    expect(result.plannedActions[0]!.status).toBe("blocked");
  });

  it("blocks a step with extra unknown properties", () => {
    const steps = [
      { id: "s1", title: "x", toolId: "y", input: {}, banned: 1 }
    ] as unknown as Parameters<typeof dryRun>[0];
    const result = dryRun(steps);

    expect(result.plannedActions[0]!.status).toBe("blocked");
    expect(result.plannedActions[0]!.reason).toContain("validation failed");
  });

  // ── blocked: duplicates ────────────────────────────────────────────────

  it("blocks duplicate step ids", () => {
    const steps = [validStep({ id: "dup" }), validStep({ id: "dup", title: "second" })];
    const result = dryRun(steps);

    expect(result.totalSteps).toBe(2);
    expect(result.willRunCount).toBe(1);
    expect(result.blockedCount).toBe(1);

    expect(result.plannedActions[0]!.status).toBe("will-run");
    expect(result.plannedActions[1]!.status).toBe("blocked");
    expect(result.plannedActions[1]!.reason).toContain('duplicate step id "dup"');
  });

  it("keeps the first occurrence and blocks all subsequent duplicates", () => {
    const steps = [
      validStep({ id: "a" }),
      validStep({ id: "b" }),
      validStep({ id: "a", title: "dup" }),
      validStep({ id: "a", title: "dup again" })
    ];
    const result = dryRun(steps);

    expect(result.willRunCount).toBe(2); // a (first), b
    expect(result.blockedCount).toBe(2); // a (2nd), a (3rd)

    const dupActions = result.plannedActions.filter((a) => a.status === "blocked");
    expect(dupActions).toHaveLength(2);
    expect(dupActions.every((a) => a.reason.includes("duplicate"))).toBe(true);
  });

  // ── mixed valid + invalid ──────────────────────────────────────────────

  it("handles a mix of valid and invalid steps", () => {
    const steps = [
      validStep({ id: "ok-1" }),
      { id: "", title: "Bad", toolId: "x", input: {} }, // empty id → blocked
      validStep({ id: "ok-2" })
    ] as unknown as Parameters<typeof dryRun>[0];
    const result = dryRun(steps);

    expect(result.totalSteps).toBe(3);
    expect(result.willRunCount).toBe(2);
    expect(result.blockedCount).toBe(1);
    expect(result.plannedActions).toHaveLength(3);

    // Valid steps appear in the steps array; blocked ones do not.
    expect(result.steps).toHaveLength(2);
    expect(result.steps.map((s) => s.id)).toEqual(["ok-1", "ok-2"]);
  });

  // ── immutability ───────────────────────────────────────────────────────

  it("does not mutate the input steps array", () => {
    const steps = [validStep()];
    const frozen = Object.freeze(steps.map((s) => Object.freeze({ ...s })));

    expect(() => dryRun(frozen)).not.toThrow();
  });

  // ── no executor / side effects ─────────────────────────────────────────

  it("never calls any external tool, executor, or process", () => {
    // This test is structural: dryRun is a pure function with no I/O imports.
    // We verify that the result is deterministic and contains no side-effect
    // indicators (no spawned process info, no file paths written, no network calls).
    const steps = [
      validStep({ id: "a", toolId: "bash", input: { command: "rm -rf /" } }),
      validStep({ id: "b", toolId: "write", input: { filePath: "/etc/passwd" } }),
      validStep({ id: "c", toolId: "webFetch", input: { url: "https://example.com" } })
    ];

    const r1 = dryRun(steps);
    const r2 = dryRun(steps);

    // Deterministic — same input → same output
    expect(r1).toEqual(r2);

    // All steps are marked will-run but nothing was actually executed
    expect(r1.willRunCount).toBe(3);
    expect(r1.blockedCount).toBe(0);

    // The result is a pure data structure — no side effects embedded
    for (const action of r1.plannedActions) {
      expect(action.status).toBe("will-run");
      expect(action.reason).not.toContain("executed");
      expect(action.reason).not.toContain("spawned");
      expect(action.reason).not.toContain("called");
    }

    // The summary explicitly says nothing was executed
    expect(r1.summary).toContain("Nothing was executed");
  });

  it("is a pure function — repeated calls produce identical results", () => {
    const steps = [
      validStep({ id: "x" }),
      validStep({ id: "y" }),
      validStep({ id: "z", input: { nested: { deep: [1, 2, 3] } } })
    ];

    const results = Array.from({ length: 5 }, () => dryRun(steps));
    const first = JSON.stringify(results[0]);

    for (const r of results) {
      expect(JSON.stringify(r)).toBe(first);
    }
  });

  // ── round-trip through schema ──────────────────────────────────────────

  it("produces output that passes WorkflowDryRunResultSchema validation", () => {
    const steps = [validStep({ id: "a" }), validStep({ id: "b" })];
    const result = dryRun(steps);

    const parsed = WorkflowDryRunResultSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  it("produces output that passes schema validation even with blocked steps", () => {
    const steps = [validStep({ id: "a" }), validStep({ id: "a" })]; // duplicate
    const result = dryRun(steps);

    const parsed = WorkflowDryRunResultSchema.safeParse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.blockedCount).toBe(1);
  });
});

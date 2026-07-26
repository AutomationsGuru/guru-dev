import { describe, expect, it } from "vitest";

import {
  PLAN_ARTIFACT_INVALID_CODE,
  PlanArtifactDecisionSchema,
  PlanArtifactSchema,
  PlanArtifactVerdictSchema,
  parsePlanArtifact,
  renderPlanArtifactMarkdown,
  verdictLiftsPlanFloor
} from "../../src/planner/planArtifact.js";

const BASE_ARTIFACT = {
  id: "plan-2026-07-18-001",
  createdAt: "2026-07-18T00:00:00.000Z",
  objective: "Refactor the planner session gate to enforce the dual-axis floor before YOLO."
};

describe("PlanArtifactSchema", () => {
  it("accepts an artifact with empty sections (every section is rendered visible)", () => {
    const result = PlanArtifactSchema.safeParse(BASE_ARTIFACT);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sources_context).toEqual([]);
      expect(result.data.critical_files).toEqual([]);
      expect(result.data.constraints).toEqual([]);
      expect(result.data.approach).toEqual([]);
      expect(result.data.verification).toEqual([]);
      expect(result.data.risks).toEqual([]);
      expect(result.data.handoff_notes).toEqual([]);
    }
  });

  it("accepts a fully-populated artifact with sequential approach steps", () => {
    const result = PlanArtifactSchema.safeParse({
      ...BASE_ARTIFACT,
      sources_context: ["handoffs/build-plans/2026-07-15T1930Z-g1004-read-only-plan-mode-core-plan.md"],
      critical_files: ["src/planner/workApprovalAxes.ts", "src/runtime/session.ts"],
      constraints: ["No new dependencies", "Plan floor binds regardless of approvalPosture"],
      approach: [
        { order: 1, description: "Define dual-axis types." },
        { order: 2, description: "Wire the runtime gate." },
        { order: 3, description: "Add focused tests." }
      ],
      verification: ["npx vitest run tests/planner/planArtifact.test.ts", "npx tsc --noEmit"],
      risks: ["Approve-as-act requires explicit operator action — never implicit."],
      handoff_notes: ["Hand off to code-review after focused tests are GREEN."]
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-sequential approach step order", () => {
    const result = PlanArtifactSchema.safeParse({
      ...BASE_ARTIFACT,
      approach: [
        { order: 2, description: "Out of order." }
      ]
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("one-based position");
  });

  it.each(["../secrets.env", "src\\..\\secrets.env"])("rejects traversal-bearing critical_files: %s", (path) => {
    const result = PlanArtifactSchema.safeParse({
      ...BASE_ARTIFACT,
      critical_files: [path]
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("path traversal");
  });

  it("rejects a NUL-bearing critical_file path", () => {
    const result = PlanArtifactSchema.safeParse({
      ...BASE_ARTIFACT,
      critical_files: ["src/planner/planArtifact.ts\0.bak"]
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("NUL");
  });

  it("rejects an empty objective", () => {
    const result = PlanArtifactSchema.safeParse({
      ...BASE_ARTIFACT,
      objective: "   "
    });
    expect(result.success).toBe(false);
  });

  it("rejects an over-size artifact", () => {
    // Fill arrays with valid-length strings that together push the serialized
    // artifact past the 60_000 character cap. The cap is enforced at the
    // serialized level (superRefine), not per-field, so we keep each entry
    // small but blow up the count.
    const entries = Array.from({ length: 800 }, (_, index) => `entry-${index}-${"x".repeat(80)}`);
    const result = PlanArtifactSchema.safeParse({
      ...BASE_ARTIFACT,
      handoff_notes: entries
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("60000");
  });
});

describe("parsePlanArtifact", () => {
  it("returns ok=true for a valid artifact", () => {
    const result = parsePlanArtifact(BASE_ARTIFACT);
    expect(result.ok).toBe(true);
  });

  it("returns ok=false with a stable error code constant", () => {
    const result = parsePlanArtifact({ ...BASE_ARTIFACT, objective: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error).toBe("string");
      expect(result.error.length).toBeGreaterThan(0);
    }
    expect(PLAN_ARTIFACT_INVALID_CODE).toBe("PLAN_ARTIFACT_INVALID");
  });
});

describe("PlanArtifactDecision", () => {
  it("accepts the three verdicts", () => {
    expect(PlanArtifactVerdictSchema.parse("accepted")).toBe("accepted");
    expect(PlanArtifactVerdictSchema.parse("revise")).toBe("revise");
    expect(PlanArtifactVerdictSchema.parse("rejected")).toBe("rejected");
  });

  it("parses a full decision", () => {
    const parsed = PlanArtifactDecisionSchema.parse({
      artifactId: "plan-2026-07-18-001",
      verdict: "accepted",
      note: "Looks good.",
      decidedAt: "2026-07-18T00:05:00.000Z"
    });
    expect(parsed.verdict).toBe("accepted");
  });
});

describe("verdictLiftsPlanFloor", () => {
  it("only 'accepted' lifts the floor", () => {
    expect(verdictLiftsPlanFloor("accepted")).toBe(true);
    expect(verdictLiftsPlanFloor("revise")).toBe(false);
    expect(verdictLiftsPlanFloor("rejected")).toBe(false);
  });
});

describe("renderPlanArtifactMarkdown", () => {
  it("renders empty sections as visible '_(none)_' placeholders", () => {
    const md = renderPlanArtifactMarkdown({
      ...BASE_ARTIFACT,
      sources_context: [],
      critical_files: [],
      constraints: [],
      approach: [],
      verification: [],
      risks: [],
      handoff_notes: []
    });
    expect(md).toContain("## Sources / context");
    expect(md).toContain("_(none)_");
    expect(md).toContain("## Critical files");
    expect(md).toContain("## Constraints");
    expect(md).toContain("## Verification");
    expect(md).toContain("## Risks");
    expect(md).toContain("## Handoff notes");
  });

  it("renders sequential approach steps as an ordered list", () => {
    const parsed = PlanArtifactSchema.parse({
      ...BASE_ARTIFACT,
      approach: [
        { order: 1, description: "First step." },
        { order: 2, description: "Second step." }
      ]
    });
    const md = renderPlanArtifactMarkdown(parsed);
    expect(md).toContain("1. First step.");
    expect(md).toContain("2. Second step.");
  });
});

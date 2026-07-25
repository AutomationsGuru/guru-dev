import {
  createEmptyPlanArtifact,
  parsePlanArtifact,
  PLAN_ARTIFACT_SECTIONS,
  PlanArtifactSchema,
  serializePlanArtifact
} from '../../src/planner/planArtifact.js';

const VALID_ARTIFACT = {
  objective: "Add a bounded retry to the session resume path.",
  sources: ["handoffs/build-plans/example.md", "src/runtime/session.ts"],
  critical_files: ["src/runtime/session.ts"],
  constraints: ["Do not change package.json."],
  approach: ["Inspect the resume path.", "Add the retry.", "Test it."],
  verification: ["Run tests/runtime/session.test.ts."],
  risks: ["Resume could double-record events."],
  handoff_notes: ["Next owner is code-review."]
};

describe("PLAN_ARTIFACT_SECTIONS", () => {
  it("names the eight canonical sections in fixed order and is frozen", () => {
    expect(PLAN_ARTIFACT_SECTIONS).toEqual([
      "objective",
      "sources",
      "critical_files",
      "constraints",
      "approach",
      "verification",
      "risks",
      "handoff_notes"
    ]);
    expect(Object.isFrozen(PLAN_ARTIFACT_SECTIONS)).toBe(true);
  });
});

describe("PlanArtifactSchema", () => {
  it("accepts a fully populated artifact", () => {
    const artifact = PlanArtifactSchema.parse(VALID_ARTIFACT);

    expect(artifact.objective).toBe(VALID_ARTIFACT.objective);
    expect(artifact.approach).toHaveLength(3);
  });

  it("requires a non-empty objective", () => {
    expect(PlanArtifactSchema.safeParse({ ...VALID_ARTIFACT, objective: "" }).success).toBe(false);
    expect(PlanArtifactSchema.safeParse({ ...VALID_ARTIFACT, objective: "   " }).success).toBe(false);
  });

  it("keeps empty sections visible instead of omitting them", () => {
    const artifact = PlanArtifactSchema.parse({
      ...VALID_ARTIFACT,
      sources: [],
      constraints: [],
      risks: [],
      handoff_notes: []
    });

    expect(artifact.sources).toEqual([]);
    expect(artifact.constraints).toEqual([]);
    expect(artifact.risks).toEqual([]);
    expect(artifact.handoff_notes).toEqual([]);
    expect(Object.keys(artifact).sort()).toEqual([...PLAN_ARTIFACT_SECTIONS].sort());
  });

  it("rejects artifacts missing a required section key", () => {
    const { risks: _risks, ...missingRisks } = VALID_ARTIFACT;

    expect(PlanArtifactSchema.safeParse(missingRisks).success).toBe(false);
  });

  it("rejects extra keys (strict shape)", () => {
    expect(PlanArtifactSchema.safeParse({ ...VALID_ARTIFACT, extra: "nope" }).success).toBe(false);
  });

  it("rejects blank entries inside list sections", () => {
    expect(PlanArtifactSchema.safeParse({ ...VALID_ARTIFACT, approach: ["ok", "  "] }).success).toBe(false);
  });

  it("rejects path traversal in critical_files", () => {
    const result = PlanArtifactSchema.safeParse({ ...VALID_ARTIFACT, critical_files: ["../secrets.env"] });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("path traversal");
  });

  it("rejects NUL characters in critical_files", () => {
    expect(PlanArtifactSchema.safeParse({ ...VALID_ARTIFACT, critical_files: ["src/a.ts\0x"] }).success).toBe(false);
  });

  it("bounds the aggregate serialized size", () => {
    const bloated = {
      ...VALID_ARTIFACT,
      approach: Array.from({ length: 40 }, (_, index) => `${index}-${"x".repeat(995)}`)
    };
    const result = PlanArtifactSchema.safeParse(bloated);

    expect(result.success).toBe(false);
    expect(result.error?.issues.at(-1)?.message).toContain("serialized size");
  });
});

describe("createEmptyPlanArtifact", () => {
  it("returns all eight sections visible with only the objective filled", () => {
    const artifact = createEmptyPlanArtifact("Survey the planner surface.");

    expect(artifact.objective).toBe("Survey the planner surface.");
    for (const section of PLAN_ARTIFACT_SECTIONS) {
      expect(artifact).toHaveProperty(section);
    }
    expect(artifact.sources).toEqual([]);
    expect(artifact.approach).toEqual([]);
    expect(PlanArtifactSchema.safeParse(artifact).success).toBe(true);
  });

  it("trims the objective and rejects a blank one", () => {
    expect(createEmptyPlanArtifact("  padded  ").objective).toBe("padded");
    expect(() => createEmptyPlanArtifact("   ")).toThrow();
  });
});

describe("parsePlanArtifact", () => {
  it("returns the parsed artifact on success", () => {
    const result = parsePlanArtifact(VALID_ARTIFACT);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact.objective).toBe(VALID_ARTIFACT.objective);
    }
  });

  it("returns a legible error naming the failing section", () => {
    const result = parsePlanArtifact({ ...VALID_ARTIFACT, objective: "" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("objective");
    }
  });
});

describe("serializePlanArtifact", () => {
  it("renders every section heading even when the section is empty", () => {
    const markdown = serializePlanArtifact(createEmptyPlanArtifact("Do the thing."));

    for (const section of PLAN_ARTIFACT_SECTIONS) {
      expect(markdown).toContain(section);
    }
    expect(markdown).toContain("Do the thing.");
    // Empty sections remain visible with an explicit placeholder, never omitted.
    expect(markdown).toContain("_(none)_");
  });

  it("renders list sections as bullet items", () => {
    const markdown = serializePlanArtifact(PlanArtifactSchema.parse(VALID_ARTIFACT));

    expect(markdown).toContain("- Inspect the resume path.");
    expect(markdown).toContain("- Run tests/runtime/session.test.ts.");
  });
});

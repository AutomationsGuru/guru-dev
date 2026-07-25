import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildStepContextPack,
  DEFAULT_ALWAYS_ON_PATTERNS,
  resolveAlwaysOnPaths,
  StepContextPackSchema,
  StepContextPlanSchema,
  StepContextStepSchema
} from "../../src/planning/stepContextPack.js";

describe("StepContextStepSchema", () => {
  it("should validate a step with id, relevantPaths, and optional notes", () => {
    const step = StepContextStepSchema.parse({
      id: "scaffold",
      relevantPaths: ["src/cli.ts", "src/index.ts"],
      notes: "Wire the CLI entrypoint."
    });

    expect(step.id).toBe("scaffold");
    expect(step.relevantPaths).toEqual(["src/cli.ts", "src/index.ts"]);
    expect(step.notes).toBe("Wire the CLI entrypoint.");
  });

  it("should default relevantPaths to empty and allow omitted notes", () => {
    const step = StepContextStepSchema.parse({ id: "noop" });

    expect(step.relevantPaths).toEqual([]);
    expect(step.notes).toBeUndefined();
  });

  it("should reject absolute and parent-escaping paths", () => {
    expect(StepContextStepSchema.safeParse({ id: "x", relevantPaths: ["/etc/passwd"] }).success).toBe(false);
    expect(StepContextStepSchema.safeParse({ id: "x", relevantPaths: ["../outside.ts"] }).success).toBe(false);
    expect(StepContextStepSchema.safeParse({ id: "x", relevantPaths: ["src/../../secret.ts"] }).success).toBe(false);
  });

  it("should reject unknown keys and empty ids", () => {
    expect(StepContextStepSchema.safeParse({ id: "", relevantPaths: [] }).success).toBe(false);
    expect(StepContextStepSchema.safeParse({ id: "x", extra: true }).success).toBe(false);
  });
});

describe("StepContextPlanSchema", () => {
  it("should require at least one step", () => {
    expect(StepContextPlanSchema.safeParse({ steps: [] }).success).toBe(false);
    expect(
      StepContextPlanSchema.safeParse({ steps: [{ id: "one", relevantPaths: [] }] }).success
    ).toBe(true);
  });
});

describe("buildStepContextPack", () => {
  const plan = StepContextPlanSchema.parse({
    steps: [
      { id: "scaffold", relevantPaths: ["src/cli.ts", "src/index.ts"], notes: "Wire entry." },
      { id: "planner", relevantPaths: ["src/planner/runtime.ts", "src/planner/schemas.ts"] },
      { id: "memory", relevantPaths: ["src/memory/scopes.ts"] }
    ]
  });

  const alwaysOnPaths = ["AGENTS.md", "src/mandates/evaluate.ts"];

  it("should inject only the active step's files plus always-on context", () => {
    const pack = buildStepContextPack({ plan, stepId: "planner", alwaysOnPaths });

    expect(pack.stepId).toBe("planner");
    expect(pack.stepFiles).toEqual(["src/planner/runtime.ts", "src/planner/schemas.ts"]);
    expect(pack.alwaysOnFiles).toEqual(alwaysOnPaths);
  });

  it("should change the pack when the step switches", () => {
    const scaffoldPack = buildStepContextPack({ plan, stepId: "scaffold", alwaysOnPaths });
    const memoryPack = buildStepContextPack({ plan, stepId: "memory", alwaysOnPaths });

    expect(scaffoldPack.stepFiles).toEqual(["src/cli.ts", "src/index.ts"]);
    expect(memoryPack.stepFiles).toEqual(["src/memory/scopes.ts"]);
    expect(scaffoldPack.stepFiles).not.toEqual(memoryPack.stepFiles);

    // Neither pack leaks the other step's declared files.
    expect(scaffoldPack.stepFiles).not.toContain("src/memory/scopes.ts");
    expect(memoryPack.stepFiles).not.toContain("src/cli.ts");
    expect(scaffoldPack.stepFiles).not.toContain("src/planner/runtime.ts");
    expect(memoryPack.stepFiles).not.toContain("src/planner/runtime.ts");
  });

  it("should keep always-on files present in every pack regardless of step", () => {
    for (const step of plan.steps) {
      const pack = buildStepContextPack({ plan, stepId: step.id, alwaysOnPaths });

      expect(pack.alwaysOnFiles).toEqual(alwaysOnPaths);
      for (const required of alwaysOnPaths) {
        expect(pack.alwaysOnFiles).toContain(required);
      }
    }
  });

  it("should carry the active step's notes into the pack", () => {
    const pack = buildStepContextPack({ plan, stepId: "scaffold", alwaysOnPaths });

    expect(pack.notes).toBe("Wire entry.");
  });

  it("should fail closed on an unknown step id", () => {
    expect(() => buildStepContextPack({ plan, stepId: "does-not-exist", alwaysOnPaths })).toThrow(
      /unknown step id/u
    );
  });

  it("should produce packs that satisfy StepContextPackSchema", () => {
    const pack = buildStepContextPack({ plan, stepId: "planner", alwaysOnPaths });

    expect(StepContextPackSchema.safeParse(pack).success).toBe(true);
  });

  it("should deduplicate always-on paths while preserving order", () => {
    const pack = buildStepContextPack({
      plan,
      stepId: "scaffold",
      alwaysOnPaths: ["AGENTS.md", "AGENTS.md", "src/mandates/evaluate.ts"]
    });

    expect(pack.alwaysOnFiles).toEqual(["AGENTS.md", "src/mandates/evaluate.ts"]);
  });
});

describe("resolveAlwaysOnPaths", () => {
  it("should resolve existing AGENTS chain and mandate files under a root", () => {
    const root = mkdtempSync(join(tmpdir(), "step-ctx-"));
    try {
      writeFileSync(join(root, "AGENTS.md"), "# root contract\n");
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "AGENTS.md"), "# src contract\n");
      mkdirSync(join(root, "src", "mandates"), { recursive: true });
      writeFileSync(join(root, "src", "mandates", "evaluate.ts"), "// mandates\n");
      // A path matching no file must be dropped, not invented.
      const resolved = resolveAlwaysOnPaths({ rootPath: root });

      expect(resolved).toContain("AGENTS.md");
      expect(resolved).toContain("src/AGENTS.md");
      expect(resolved).toContain("src/mandates/evaluate.ts");
      // Non-existent candidates are absent.
      expect(resolved.every((p) => !p.includes("does-not-exist"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("should expose default always-on patterns covering AGENTS and mandates", () => {
    expect(DEFAULT_ALWAYS_ON_PATTERNS.some((p) => p.includes("AGENTS.md"))).toBe(true);
    expect(DEFAULT_ALWAYS_ON_PATTERNS.some((p) => p.includes("mandates"))).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import {
  invokeBuiltinSkill,
  listBuiltins,
  registerBuiltinSkills
} from '../../src/skills/registerBuiltinSkills.js';

describe("built-in skills", () => {
  it("lists the shipped built-ins without requiring registration order", () => {
    expect(listBuiltins().map((skill) => skill.id)).toEqual(["batch", "loop", "review"]);
  });

  it("registers review, loop, and batch as explicit slash-invoked skills", () => {
    registerBuiltinSkills();

    const builtins = listBuiltins();

    expect(builtins.map((skill) => skill.id)).toEqual(["batch", "loop", "review"]);
    expect(builtins.map((skill) => skill.slashCommand)).toEqual(["/batch", "/loop", "/review"]);
    expect(builtins.every((skill) => skill.disableModelInvocation)).toBe(true);
    expect(builtins.every((skill) => typeof skill.inputSchema.safeParse === "function")).toBe(true);
  });

  it("invokes review as a structured prompt and plan without executing git actions", () => {
    const invocation = invokeBuiltinSkill("review", {
      target: "the pending working-tree changes",
      focus: ["correctness", "tests"]
    });

    expect(invocation).toMatchObject({
      kind: "prompt-plan",
      skillId: "review",
      slashCommand: "/review",
      disableModelInvocation: true,
      execution: {
        autoExecute: false,
        gitActions: []
      },
      plan: {
        objective: expect.stringContaining("pending working-tree changes"),
        steps: expect.any(Array)
      }
    });
    expect(invocation.prompt).toContain("correctness, tests");
    expect(invocation.plan.steps.length).toBeGreaterThan(0);
  });

  it("builds bounded loop and batch plans instead of running them", () => {
    const loop = invokeBuiltinSkill("loop", {
      task: "Fix the focused test failure",
      maxIterations: 4,
      stopCondition: "The focused test passes"
    });
    const batch = invokeBuiltinSkill("batch", {
      tasks: ["Typecheck", "Run focused tests"],
      maxConcurrency: 2
    });

    expect(loop).toMatchObject({
      skillId: "loop",
      execution: { autoExecute: false, gitActions: [] },
      plan: { maxIterations: 4, stopCondition: "The focused test passes" }
    });
    expect(batch).toMatchObject({
      skillId: "batch",
      execution: { autoExecute: false, gitActions: [] },
      plan: { tasks: ["Typecheck", "Run focused tests"], maxConcurrency: 2 }
    });
  });

  it("rejects invalid input through each built-in schema", () => {
    expect(() => invokeBuiltinSkill("loop", { task: "", maxIterations: 0 })).toThrow();
    expect(() => invokeBuiltinSkill("batch", { tasks: [] })).toThrow();
  });

  it("accepts a slash command identifier", () => {
    expect(invokeBuiltinSkill("/review", {}).slashCommand).toBe("/review");
  });

  it("rejects unknown built-in skill ids", () => {
    expect(() => invokeBuiltinSkill("unknown", {})).toThrow("Built-in skill not found: unknown");
  });
});

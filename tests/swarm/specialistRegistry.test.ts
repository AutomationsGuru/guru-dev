import { beforeEach, describe, expect, it } from "vitest";

import {
  clampSpecialistTools,
  createSpecialistRegistry,
  getSharedSpecialistRegistry,
  resetSharedSpecialistRegistryForTests
} from '../../src/swarm/specialistRegistry.js';

describe("specialist registry — builtins and resolution", () => {
  beforeEach(() => {
    resetSharedSpecialistRegistryForTests();
  });

  it("registers library-research and code-analysis by default in the shared registry", () => {
    const registry = getSharedSpecialistRegistry();
    const list = registry.list();

    expect(list).toHaveLength(2);
    expect(list.map((s) => s.name)).toContain("library-research");
    expect(list.map((s) => s.name)).toContain("code-analysis");

    const research = registry.resolve("library-research");
    expect(research).toBeDefined();
    expect(research!.allowedTools).toEqual(["read", "grep", "glob", "ls"]);
    expect(research!.systemPrompt.length).toBeGreaterThan(0);

    const analysis = registry.resolve("code-analysis");
    expect(analysis).toBeDefined();
    expect(analysis!.allowedTools).toEqual(["read", "grep", "glob", "ls", "read_diagnostics"]);
    expect(analysis!.systemPrompt.length).toBeGreaterThan(0);
  });

  it("resolves and gets unknown specialists as undefined", () => {
    const registry = getSharedSpecialistRegistry();
    expect(registry.resolve("unknown-agent")).toBeUndefined();
    expect(registry.get("unknown-agent")).toBeUndefined();
  });
});

describe("specialist registry — custom registration and validation", () => {
  beforeEach(() => {
    resetSharedSpecialistRegistryForTests();
  });

  it("registers a valid custom specialist and resolves it", () => {
    const registry = getSharedSpecialistRegistry();

    registry.register({
      name: "custom-specialist",
      systemPrompt: "You are a custom specialist.",
      allowedTools: ["read", "todo_list"]
    });

    const custom = registry.resolve("custom-specialist");
    expect(custom).toBeDefined();
    expect(custom!.name).toBe("custom-specialist");
    expect(custom!.allowedTools).toEqual(["read", "todo_list"]);
    expect(custom!.systemPrompt).toBe("You are a custom specialist.");
  });

  it("rejects names that are not kebab-case", () => {
    const registry = createSpecialistRegistry([]);

    expect(() =>
      registry.register({
        name: "Invalid_Name",
        systemPrompt: "system prompt",
        allowedTools: ["read"]
      })
    ).toThrow(/kebab-case/u);

    expect(() =>
      registry.register({
        name: "invalid name",
        systemPrompt: "system prompt",
        allowedTools: ["read"]
      })
    ).toThrow(/kebab-case/u);
  });

  it("rejects duplicate registration of the same name", () => {
    const registry = createSpecialistRegistry([]);
    registry.register({
      name: "dup-specialist",
      systemPrompt: "First description",
      allowedTools: ["read"]
    });

    expect(() =>
      registry.register({
        name: "dup-specialist",
        systemPrompt: "Second description",
        allowedTools: ["ls"]
      })
    ).toThrow(/Specialist already registered/u);
  });

  it("rejects empty system prompts and empty allowedTools lists", () => {
    const registry = createSpecialistRegistry([]);

    expect(() =>
      registry.register({
        name: "bad-specialist",
        systemPrompt: "",
        allowedTools: ["read"]
      })
    ).toThrow();

    expect(() =>
      registry.register({
        name: "bad-specialist",
        systemPrompt: "prompt",
        allowedTools: []
      })
    ).toThrow();
  });
});

describe("clampSpecialistTools — offer-bounded intersection", () => {
  it("clamps a read-only offered set down to the specialist's allowed subset", () => {
    const specialistAllowedTools = ["read", "grep", "write_file"];

    // Read-only mode: write_file is not offered by the swarm worker runner.
    const offeredReadOnlyTools = [{ id: "read" }, { id: "grep" }, { id: "ls" }];
    expect(clampSpecialistTools(specialistAllowedTools, offeredReadOnlyTools)).toEqual([
      "read",
      "grep"
    ]);

    // Mutating mode: write_file is offered; order follows the offered set.
    const offeredMutatingTools = [
      { id: "read" },
      { id: "grep" },
      { id: "write_file" },
      { id: "ls" }
    ];
    expect(clampSpecialistTools(specialistAllowedTools, offeredMutatingTools)).toEqual([
      "read",
      "grep",
      "write_file"
    ]);
  });

  it("returns [] when the intersection is empty", () => {
    const specialistAllowedTools = ["write_file"];
    const offeredReadOnlyTools = [{ id: "read" }, { id: "ls" }];

    expect(clampSpecialistTools(specialistAllowedTools, offeredReadOnlyTools)).toEqual([]);
  });
});

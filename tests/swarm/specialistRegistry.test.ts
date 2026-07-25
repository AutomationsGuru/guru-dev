import { describe, expect, it, beforeEach } from "vitest";

import {
  createSpecialistRegistry,
  getSharedSpecialistRegistry,
  resetSharedSpecialistRegistryForTests,
  clampSpecialistTools,
  BUILTIN_SPECIALISTS
} from '../../src/swarm/specialistRegistry.js';

describe("specialist schema and registry", () => {
  beforeEach(() => {
    resetSharedSpecialistRegistryForTests();
  });

  describe("builtin specialists", () => {
    it("should register library-research and code-analysis by default in the shared registry", () => {
      const registry = getSharedSpecialistRegistry();
      const list = registry.list();

      expect(list.length).toBe(2);
      expect(list.map((s) => s.name)).toContain("library-research");
      expect(list.map((s) => s.name)).toContain("code-analysis");

      const research = registry.resolve("library-research");
      expect(research).toBeDefined();
      expect(research!.allowedTools).toEqual(["read", "grep", "glob", "ls"]);
      expect(research!.systemPrompt).toContain("library research");

      const analysis = registry.resolve("code-analysis");
      expect(analysis).toBeDefined();
      expect(analysis!.allowedTools).toEqual(["read", "grep", "glob", "ls", "read_diagnostics"]);
      expect(analysis!.systemPrompt).toContain("code analysis");
    });

    it("should handle unknown specialists gracefully", () => {
      const registry = getSharedSpecialistRegistry();
      expect(registry.resolve("unknown-agent")).toBeUndefined();
      expect(registry.get("unknown-agent")).toBeUndefined();
    });
  });

  describe("custom specialist registration", () => {
    it("should allow a project to register extra specialists without expanding hard limits", () => {
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

    it("should reject invalid specialist names (must be kebab-case)", () => {
      const registry = createSpecialistRegistry([]);

      expect(() => {
        registry.register({
          name: "Invalid_Name",
          systemPrompt: "system prompt",
          allowedTools: ["read"]
        });
      }).toThrow(/kebab-case/u);

      expect(() => {
        registry.register({
          name: "invalid name",
          systemPrompt: "system prompt",
          allowedTools: ["read"]
        });
      }).toThrow(/kebab-case/u);
    });

    it("should reject registration of duplicate specialist names", () => {
      const registry = createSpecialistRegistry([]);
      registry.register({
        name: "dup-specialist",
        systemPrompt: "First description",
        allowedTools: ["read"]
      });

      expect(() => {
        registry.register({
          name: "dup-specialist",
          systemPrompt: "Second description",
          allowedTools: ["ls"]
        });
      }).toThrow(/Specialist already registered/);
    });

    it("should reject empty system prompts or empty tools list", () => {
      const registry = createSpecialistRegistry([]);

      expect(() => {
        registry.register({
          name: "bad-specialist",
          systemPrompt: "",
          allowedTools: ["read"]
        });
      }).toThrow();

      expect(() => {
        registry.register({
          name: "bad-specialist",
          systemPrompt: "prompt",
          allowedTools: []
        });
      }).toThrow();
    });
  });

  describe("tool subset clamp under F6 scope rules", () => {
    it("should clamp allowed tools based on the offered tools set", () => {
      const specialistAllowedTools = ["read", "grep", "write_file"];

      // Mimic read-only mode where "write_file" is not offered by the swarm worker runner
      const offeredReadOnlyTools = [
        { id: "read" },
        { id: "grep" },
        { id: "ls" }
      ];

      const clampedReadOnly = clampSpecialistTools(specialistAllowedTools, offeredReadOnlyTools);
      expect(clampedReadOnly).toEqual(["read", "grep"]);

      // Mimic all (mutating) mode where "write_file" is offered
      const offeredMutatingTools = [
        { id: "read" },
        { id: "grep" },
        { id: "write_file" },
        { id: "ls" }
      ];

      const clampedMutating = clampSpecialistTools(specialistAllowedTools, offeredMutatingTools);
      expect(clampedMutating).toEqual(["read", "grep", "write_file"]);
    });

    it("should handle empty intersections", () => {
      const specialistAllowedTools = ["write_file"];
      const offeredReadOnlyTools = [
        { id: "read" },
        { id: "ls" }
      ];

      const clamped = clampSpecialistTools(specialistAllowedTools, offeredReadOnlyTools);
      expect(clamped).toEqual([]);
    });
  });
});

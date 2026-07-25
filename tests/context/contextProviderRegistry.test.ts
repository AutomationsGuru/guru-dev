import { describe, expect, it } from "vitest";

import {
  createContextProviderRegistry,
  type ContextProvider,
  type ContextSnippet
} from '../../src/context/contextProviderRegistry.js';

/**
 * IDEA-F255-CTX-PROV-REG-01 — context provider registry.
 *
 * A context provider registers under a stable name and contributes context
 * snippets before a model call. The registry preserves registration order, so
 * multiple providers can layer their snippets deterministically (system-level
 * context first, role/skill context next, task context last, etc.). `collect`
 * runs every registered provider and concatenates results in registration
 * order. A provider that throws does not poison the whole collection — its
 * snippet is dropped and surfaced as a collection error so the caller can
 * decide whether to proceed.
 */
describe("contextProviderRegistry", () => {
  function makeSnippet(name: string, body: string): ContextSnippet {
    return { name, body };
  }

  describe("register / list", () => {
    it("registers a named provider and exposes it via list", () => {
      const registry = createContextProviderRegistry();
      const provider: ContextProvider = { name: "repo", collect: async () => [makeSnippet("repo", "cwd=/x")] };

      registry.register(provider);

      expect(registry.list().map((p) => p.name)).toEqual(["repo"]);
    });

    it("preserves registration order across multiple providers", () => {
      const registry = createContextProviderRegistry();
      registry.register({ name: "system", collect: async () => [makeSnippet("system", "s")] });
      registry.register({ name: "role", collect: async () => [makeSnippet("role", "r")] });
      registry.register({ name: "task", collect: async () => [makeSnippet("task", "t")] });

      expect(registry.list().map((p) => p.name)).toEqual(["system", "role", "task"]);
    });

    it("throws on duplicate registration of an existing name", () => {
      const registry = createContextProviderRegistry();
      registry.register({ name: "repo", collect: async () => [] });

      expect(() =>
        registry.register({ name: "repo", collect: async () => [] })
      ).toThrow(/already registered/i);
    });

    it("find returns the provider by name", () => {
      const registry = createContextProviderRegistry();
      const provider: ContextProvider = { name: "repo", collect: async () => [] };
      registry.register(provider);

      expect(registry.find("repo")).toBe(provider);
      expect(registry.find("missing")).toBeUndefined();
    });
  });

  describe("collect", () => {
    it("collects snippets from multiple providers in registration order", async () => {
      const registry = createContextProviderRegistry();
      registry.register({
        name: "system",
        collect: async () => [makeSnippet("system", "S1"), makeSnippet("system", "S2")]
      });
      registry.register({
        name: "role",
        collect: async () => [makeSnippet("role", "R1")]
      });
      registry.register({
        name: "task",
        collect: async () => [makeSnippet("task", "T1")]
      });

      const result = await registry.collect();

      expect(result.snippets.map((s) => s.body)).toEqual(["S1", "S2", "R1", "T1"]);
      expect(result.errors).toEqual([]);
    });

    it("handles providers that return zero snippets", async () => {
      const registry = createContextProviderRegistry();
      registry.register({ name: "empty", collect: async () => [] });
      registry.register({ name: "full", collect: async () => [makeSnippet("full", "F")] });

      const result = await registry.collect();

      expect(result.snippets.map((s) => s.body)).toEqual(["F"]);
      expect(result.errors).toEqual([]);
    });

    it("returns empty result when no providers are registered", async () => {
      const registry = createContextProviderRegistry();

      const result = await registry.collect();

      expect(result.snippets).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it("drops a failing provider without poisoning the others and reports the error", async () => {
      const registry = createContextProviderRegistry();
      registry.register({ name: "ok-before", collect: async () => [makeSnippet("a", "A")] });
      registry.register({
        name: "boom",
        collect: async () => {
          throw new Error("provider exploded");
        }
      });
      registry.register({ name: "ok-after", collect: async () => [makeSnippet("c", "C")] });

      const result = await registry.collect();

      expect(result.snippets.map((s) => s.body)).toEqual(["A", "C"]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.providerName).toBe("boom");
      expect(result.errors[0]?.message).toMatch(/provider exploded/);
    });

    it("passes the collection context to each provider", async () => {
      const registry = createContextProviderRegistry();
      const seen: string[] = [];
      registry.register({
        name: "repo",
        collect: async (ctx) => {
          seen.push(ctx.cwd ?? "<no-cwd>");
          return [makeSnippet("repo", `cwd=${ctx.cwd}`)];
        }
      });

      const result = await registry.collect({ cwd: "/work" });

      expect(result.snippets.map((s) => s.body)).toEqual(["cwd=/work"]);
      expect(seen).toEqual(["/work"]);
    });
  });
});

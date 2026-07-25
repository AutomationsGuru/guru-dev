import { z } from "zod";

import { MANDATE_READ_ONLY_TOOLS } from '../../src/mandates/evaluate.js';
import type { ToolDefinition } from '../../src/tools/registry.js';
import { createHarnessProfileRegistry, resolveProfileSurface } from '../../src/harness/harnessProfileRegistry.js';
import { minimalProfile } from '../../src/harness/profiles/minimal.js';

function makeTool(id: string, title = `Tool ${id}`): ToolDefinition {
  return {
    id,
    title,
    description: `Description of ${id}`,
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    execute: () => ({})
  };
}

const HARD_LIMIT_SAMPLE = ["read", "grep", "ls"] as const;

function makeBaseTools(): ToolDefinition[] {
  return [...HARD_LIMIT_SAMPLE.map((id) => makeTool(id)), makeTool("bash"), makeTool("write")];
}

describe("harness profile registry", () => {
  it("registers native, minimal, and shaped stub profiles", () => {
    const registry = createHarnessProfileRegistry();
    const ids = registry.list().map((profile) => profile.id);

    expect(ids).toContain("native");
    expect(ids).toContain("minimal");
    expect(ids).toContain("claude-shaped");
    expect(ids).toContain("kimi-shaped");
  });

  it("throws a clear error for an unknown profile id", () => {
    const registry = createHarnessProfileRegistry();

    expect(() => registry.resolveProfile("nope")).toThrow(/Unknown harness profile: nope/);
  });

  it("switching profile changes prompt parts, tool labels, and response mode", () => {
    const registry = createHarnessProfileRegistry();
    const tools = makeBaseTools();

    const native = registry.resolveProfile("native");
    const minimal = registry.resolveProfile("minimal");
    const nativeSurface = resolveProfileSurface(native, tools);
    const minimalSurface = resolveProfileSurface(minimal, tools);

    expect(native.responseMode).toBe("tools");
    expect(minimal.responseMode).toBe("linear-parse");
    expect(minimal.systemPromptParts).not.toEqual(native.systemPromptParts);

    // Label change is visible on a non-hard-limit tool (hard-limit tools keep
    // canonical labels by design so they cannot be renamed away).
    const nativeBash = nativeSurface.find((entry) => entry.toolId === "bash");
    const minimalBash = minimalSurface.find((entry) => entry.toolId === "bash");
    expect(nativeBash?.label).toBe("Tool bash");
    expect(minimalBash?.label).toBe("shell");

    // Hard-limit tools keep their canonical presentation under any profile.
    const minimalRead = minimalSurface.find((entry) => entry.toolId === "read");
    expect(minimalRead?.label).toBe("Tool read");
  });

  it("keeps every hard-limit tool present even when a profile tries to exclude it", () => {
    const registry = createHarnessProfileRegistry();
    const tools = makeBaseTools();

    // minimal narrows its surface to a small include list; hard-limit tools in
    // the input list must still survive resolution.
    const minimal = registry.resolveProfile("minimal");
    const surface = resolveProfileSurface(minimal, tools);
    const surfaceIds = surface.map((entry) => entry.toolId);

    for (const id of HARD_LIMIT_SAMPLE) {
      expect(surfaceIds).toContain(id);
    }

    // And the resolution marks them hard-limit (deny-auto floor, non-bypassable).
    for (const id of HARD_LIMIT_SAMPLE) {
      const entry = surface.find((candidate) => candidate.toolId === id);
      expect(entry?.hardLimit).toBe(true);
    }
  });

  it("keeps a hard-limit tool intact when a profile tries to hide or rename it away", () => {
    const registry = createHarnessProfileRegistry();
    const tools = makeBaseTools();

    const sabotaged = {
      ...minimalProfile,
      id: "sabotaged",
      hardLimitToolIds: [...minimalProfile.hardLimitToolIds],
      toolSurface: {
        overrides: { read: { label: "", hidden: true } }
      }
    };
    registry.register(sabotaged);

    const surface = resolveProfileSurface(registry.resolveProfile("sabotaged"), tools);
    const readEntry = surface.find((entry) => entry.toolId === "read");

    expect(readEntry).toBeDefined();
    expect(readEntry?.hidden).toBe(false);
    expect(readEntry?.label).toBe("Tool read");
    expect(readEntry?.hardLimit).toBe(true);
  });

  it("rejects a profile whose hardLimitToolIds omits the mandate baseline", () => {
    const registry = createHarnessProfileRegistry();

    expect(() =>
      registry.register({
        id: "lawless",
        description: "drops the floor",
        systemPromptParts: ["x"],
        toolSurface: {},
        responseMode: "tools",
        hardLimitToolIds: ["read"]
      })
    ).toThrow(/hard-limit/i);
  });

  it("marks exactly the mandate read-only ids as hard-limit on the resolved surface", () => {
    const registry = createHarnessProfileRegistry();
    const tools = makeBaseTools();

    const surface = resolveProfileSurface(registry.resolveProfile("native"), tools);
    const hardLimitIds = surface.filter((entry) => entry.hardLimit).map((entry) => entry.toolId);

    for (const id of hardLimitIds) {
      expect(MANDATE_READ_ONLY_TOOLS.has(id)).toBe(true);
    }
    expect(hardLimitIds).toEqual(expect.arrayContaining([...HARD_LIMIT_SAMPLE]));
    expect(hardLimitIds).not.toContain("bash");
    expect(hardLimitIds).not.toContain("write");
  });
});

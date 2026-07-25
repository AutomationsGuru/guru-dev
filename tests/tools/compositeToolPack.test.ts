import { describe, expect, it } from "vitest";

import { z } from "zod";

import {
  createCompositeToolPacks,
  loadPack
} from '../../src/tools/compositeToolPack.js';
import { createToolRegistry, type ToolDefinition } from '../../src/tools/registry.js';

describe("composite tool pack — manifest-only grouping", () => {
  it("loadPack enables all members of a known pack against the frozen registry", () => {
    const registry = createToolRegistry([echoTool("a.echo"), echoTool("a.read"), echoTool("a.write")]);
    const packs = createCompositeToolPacks([
      { name: "core", memberToolIds: ["a.echo", "a.read", "a.write"] }
    ]);

    const loaded = loadPack(registry, packs, "core");

    expect(loaded.name).toBe("core");
    expect(loaded.members.map((m) => m.id)).toEqual(["a.echo", "a.read", "a.write"]);
    // Every resolved member is a real, already-registered tool definition — no synthesis.
    for (const member of loaded.members) {
      expect(registry.get(member.id)).toBe(member.tool);
    }
  });

  it("loadPack resolves members in stable, deduplicated, registry-sorted order", () => {
    const registry = createToolRegistry([echoTool("z.last"), echoTool("a.first"), echoTool("m.mid")]);
    const packs = createCompositeToolPacks([
      { name: "unordered", memberToolIds: ["z.last", "a.first", "m.mid", "a.first"] }
    ]);

    const loaded = loadPack(registry, packs, "unordered");

    expect(loaded.members.map((m) => m.id)).toEqual(["a.first", "m.mid", "z.last"]);
  });

  it("loadPack throws on an unknown pack name (fail closed)", () => {
    const registry = createToolRegistry([echoTool("a.echo")]);
    const packs = createCompositeToolPacks([{ name: "core", memberToolIds: ["a.echo"] }]);

    expect(() => loadPack(registry, packs, "does-not-exist")).toThrow(/unknown composite tool pack/i);
    expect(() => loadPack(registry, packs, "does-not-exist")).toThrow(/does-not-exist/);
  });

  it("loadPack throws when a member id is not registered in the frozen registry (fail closed)", () => {
    const registry = createToolRegistry([echoTool("a.echo")]);
    const packs = createCompositeToolPacks([
      { name: "core", memberToolIds: ["a.echo", "a.missing"] }
    ]);

    expect(() => loadPack(registry, packs, "core")).toThrow(/not registered/i);
    expect(() => loadPack(registry, packs, "core")).toThrow(/a.missing/);
  });

  it("loadPack throws when a member id is forbidden by the caller-supplied deny set (fail closed)", () => {
    const registry = createToolRegistry([echoTool("a.echo"), echoTool("a.shell")]);
    const packs = createCompositeToolPacks([
      { name: "core", memberToolIds: ["a.echo", "a.shell"] }
    ]);

    expect(() =>
      loadPack(registry, packs, "core", { forbiddenToolIds: new Set(["a.shell"]) })
    ).toThrow(/forbidden/i);
    expect(() =>
      loadPack(registry, packs, "core", { forbiddenToolIds: new Set(["a.shell"]) })
    ).toThrow(/a.shell/);
  });

  it("loadPack never executes a tool or grants authority — it returns definitions only", () => {
    const calls: string[] = [];
    const registry = createToolRegistry([
      {
        ...echoTool("a.echo"),
        execute() {
          calls.push("executed");
          return { message: "should not run" };
        }
      }
    ]);
    const packs = createCompositeToolPacks([{ name: "core", memberToolIds: ["a.echo"] }]);

    const loaded = loadPack(registry, packs, "core");

    expect(calls).toEqual([]);
    expect(typeof loaded.members[0]?.tool.execute).toBe("function");
  });

  it("createCompositeToolPacks rejects a pack definition with an empty member list", () => {
    expect(() => createCompositeToolPacks([{ name: "empty", memberToolIds: [] }])).toThrow(/empty/i);
  });

  it("createCompositeToolPacks rejects duplicate pack names", () => {
    expect(() =>
      createCompositeToolPacks([
        { name: "core", memberToolIds: ["a.echo"] },
        { name: "core", memberToolIds: ["a.read"] }
      ])
    ).toThrow(/already defined/i);
  });

  it("createCompositeToolPacks rejects an invalid pack name", () => {
    expect(() => createCompositeToolPacks([{ name: "", memberToolIds: ["a.echo"] }])).toThrow(/name/i);
  });
});

function echoTool(id: string): ToolDefinition {
  return {
    id,
    title: "Echo",
    description: "Return the provided message.",
    inputSchema: z.object({ message: z.string() }),
    outputSchema: z.object({ message: z.string() }),
    execute(input) {
      return input;
    }
  };
}

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createMcpIntegrationSlot } from '../../src/mcp/mcpIntegrationSlot.js';
import type { ToolDefinition } from '../../src/tools/registry.js';

/** Minimal fake ToolDefinition — no MCP server, just a registry-shaped stub. */
function fakeTool(id: string): ToolDefinition {
  return {
    id,
    title: `Fake ${id}`,
    description: `Stub tool ${id} for slot tests.`,
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ ok: z.boolean() }).strict(),
    execute: () => ({ ok: true })
  };
}

function fakeTools(serverId: string, names: readonly string[]): readonly ToolDefinition[] {
  return names.map((name) => fakeTool(`mcp.${serverId}.${name}`));
}

describe("MCP integration slot — explicit-gated catalog for attached tool sets", () => {
  it("registers a set and lists it in the catalog", () => {
    const slot = createMcpIntegrationSlot();
    slot.registerToolSet({ serverId: "fake", tools: fakeTools("fake", ["echo", "ping"]) });

    const catalog = slot.listToolSets();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toEqual({
      serverId: "fake",
      enabled: true,
      toolIds: ["mcp.fake.echo", "mcp.fake.ping"]
    });
  });

  it("flattens enabled tools for the session tool catalog", () => {
    const slot = createMcpIntegrationSlot();
    const alpha = fakeTools("alpha", ["one"]);
    const beta = fakeTools("beta", ["two", "three"]);
    slot.registerToolSet({ serverId: "alpha", tools: alpha });
    slot.registerToolSet({ serverId: "beta", tools: beta });

    expect(slot.listEnabledTools().map((tool) => tool.id)).toEqual([
      "mcp.alpha.one",
      "mcp.beta.two",
      "mcp.beta.three"
    ]);
    // The flattened view carries the actual definitions, not just ids.
    expect(slot.listEnabledTools()[0]).toBe(alpha[0]);
  });

  it("disable removes a set's tools from the enabled view but keeps it in the catalog", () => {
    const slot = createMcpIntegrationSlot();
    slot.registerToolSet({ serverId: "alpha", tools: fakeTools("alpha", ["one"]) });
    slot.registerToolSet({ serverId: "beta", tools: fakeTools("beta", ["two"]) });

    slot.disable("alpha");

    expect(slot.listEnabledTools().map((tool) => tool.id)).toEqual(["mcp.beta.two"]);
    const catalog = slot.listToolSets();
    expect(catalog).toHaveLength(2);
    expect(catalog.find((entry) => entry.serverId === "alpha")).toEqual({
      serverId: "alpha",
      enabled: false,
      toolIds: ["mcp.alpha.one"]
    });
  });

  it("re-enable restores a disabled set's tools", () => {
    const slot = createMcpIntegrationSlot();
    slot.registerToolSet({ serverId: "alpha", tools: fakeTools("alpha", ["one"]) });

    slot.disable("alpha");
    expect(slot.listEnabledTools()).toHaveLength(0);

    slot.enable("alpha");
    expect(slot.listEnabledTools().map((tool) => tool.id)).toEqual(["mcp.alpha.one"]);
    expect(slot.listToolSets()[0]?.enabled).toBe(true);
  });

  it("honors an explicit initial enabled state at registration", () => {
    const slot = createMcpIntegrationSlot();
    slot.registerToolSet({ serverId: "alpha", tools: fakeTools("alpha", ["one"]), enabled: false });

    expect(slot.listEnabledTools()).toHaveLength(0);
    expect(slot.listToolSets()[0]?.enabled).toBe(false);

    slot.enable("alpha");
    expect(slot.listEnabledTools().map((tool) => tool.id)).toEqual(["mcp.alpha.one"]);
  });

  it("throws on duplicate serverId registration (registry semantics)", () => {
    const slot = createMcpIntegrationSlot();
    slot.registerToolSet({ serverId: "alpha", tools: fakeTools("alpha", ["one"]) });

    expect(() => slot.registerToolSet({ serverId: "alpha", tools: fakeTools("alpha", ["two"]) })).toThrow(/alpha/);
  });

  it("throws a clear error when enabling an unknown serverId", () => {
    const slot = createMcpIntegrationSlot();
    expect(() => slot.enable("ghost")).toThrow(/ghost/);
  });

  it("throws a clear error when disabling an unknown serverId", () => {
    const slot = createMcpIntegrationSlot();
    expect(() => slot.disable("ghost")).toThrow(/ghost/);
  });

  it("rejects invalid registration input at the zod boundary", () => {
    const slot = createMcpIntegrationSlot();
    expect(() =>
      slot.registerToolSet({ serverId: "NOT A SLUG!", tools: fakeTools("alpha", ["one"]) })
    ).toThrow();
  });

  it("an empty slot lists nothing", () => {
    const slot = createMcpIntegrationSlot();
    expect(slot.listToolSets()).toEqual([]);
    expect(slot.listEnabledTools()).toEqual([]);
  });

  it("catalog views are read-only snapshots, not live interior state", () => {
    const slot = createMcpIntegrationSlot();
    slot.registerToolSet({ serverId: "alpha", tools: fakeTools("alpha", ["one"]) });

    const catalog = slot.listToolSets();
    const enabled = slot.listEnabledTools();
    slot.disable("alpha");

    // Snapshots taken before the mutation are unaffected.
    expect(catalog[0]?.enabled).toBe(true);
    expect(enabled).toHaveLength(1);
  });
});

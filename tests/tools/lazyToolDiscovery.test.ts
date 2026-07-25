import { z } from "zod";

import { createToolRegistry, type ToolDefinition } from '../../src/tools/registry.js';
import {
  createLazyToolDiscoveryState,
  disablePack,
  discoverPacks,
  enablePack,
  getEnabledPackIds,
  isCoreTool,
  listVisibleTools
} from '../../src/tools/lazyToolDiscovery.js';
import { CORE_TOOL_IDS } from '../../src/tools/lazyToolDiscoverySchema.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

function stubTool(id: string): ToolDefinition {
  return {
    id,
    title: `Stub ${id}`,
    description: `Stub tool: ${id}`,
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    execute() {
      return {};
    }
  };
}

/** Build a registry with mock tools representing the core + every pack pattern. */
function buildMockRegistry(): { registry: ReturnType<typeof createToolRegistry>; tools: readonly ToolDefinition[] } {
  const tools: ToolDefinition[] = [
    // Core
    ...["read", "write", "edit", "bash", "grep", "glob", "ls", "ask_question"].map(stubTool),
    // Packs
    stubTool("todo_write"),
    stubTool("todo_list"),
    stubTool("web_search"),
    stubTool("web_fetch"),
    stubTool("skills.catalog.list"),
    stubTool("skill.document.load"),
    stubTool("mcp_bridge_status"),
    stubTool("search_tool"),
    stubTool("use_tool"),
    stubTool("mcp.github.issues"),
    stubTool("mcp.filesystem.read"),
    stubTool("memory_remember"),
    stubTool("memory_search"),
    stubTool("honcho_memory_status"),
    stubTool("github.pr.status"),
    stubTool("provider_cli_status"),
    stubTool("pyautogui_status"),
    stubTool("operational.project.get"),
    stubTool("shell.command.run"),
    stubTool("fs.edit.apply"),
    stubTool("maintenance.audit.run"),
    stubTool("review.gates.run"),
    stubTool("repo.context.resolve"),
    stubTool("spawn_agent"),
    stubTool("monitor"),
    stubTool("schedule"),
    stubTool("manage_task"),
    stubTool("lsp"),
    stubTool("read_diagnostics")
  ];

  return { registry: createToolRegistry(tools), tools };
}

// ── Core tools ───────────────────────────────────────────────────────────────

describe("core tool IDs", () => {
  it("includes the minimum safe set", () => {
    expect(CORE_TOOL_IDS.has("read")).toBe(true);
    expect(CORE_TOOL_IDS.has("write")).toBe(true);
    expect(CORE_TOOL_IDS.has("edit")).toBe(true);
    expect(CORE_TOOL_IDS.has("bash")).toBe(true);
    expect(CORE_TOOL_IDS.has("grep")).toBe(true);
    expect(CORE_TOOL_IDS.has("glob")).toBe(true);
    expect(CORE_TOOL_IDS.has("ls")).toBe(true);
    expect(CORE_TOOL_IDS.has("ask_question")).toBe(true);
  });

  it("is small — only 8 tools", () => {
    expect(CORE_TOOL_IDS.size).toBe(8);
  });

  it("marks every core id via isCoreTool", () => {
    for (const id of CORE_TOOL_IDS) {
      expect(isCoreTool(id)).toBe(true);
    }
  });

  it("excludes non-core tools", () => {
    expect(isCoreTool("web_search")).toBe(false);
    expect(isCoreTool("todo_write")).toBe(false);
    expect(isCoreTool("spawn_agent")).toBe(false);
    expect(isCoreTool("mcp.foo.bar")).toBe(false);
  });
});

// ── State ────────────────────────────────────────────────────────────────────

describe("createLazyToolDiscoveryState", () => {
  it("starts with no packs enabled", () => {
    const state = createLazyToolDiscoveryState();
    expect(state.enabledPacks).toEqual([]);
  });
});

// ── Visibility ───────────────────────────────────────────────────────────────

describe("listVisibleTools", () => {
  it("returns only core tools when no packs are enabled", () => {
    const { tools } = buildMockRegistry();
    const state = createLazyToolDiscoveryState();

    const visible = listVisibleTools(tools, state);
    const ids = visible.map((t) => t.id);

    // Must include every core tool
    for (const coreId of CORE_TOOL_IDS) {
      expect(ids).toContain(coreId);
    }
    // Must NOT include any pack-only tool
    expect(ids).not.toContain("web_search");
    expect(ids).not.toContain("todo_write");
    expect(ids).not.toContain("spawn_agent");
    expect(ids).not.toContain("mcp.github.issues");

    // Core-only: exactly 8 tools
    expect(visible).toHaveLength(8);
  });

  it("returns core + pack tools when a pack is enabled", () => {
    const { tools } = buildMockRegistry();
    let state = createLazyToolDiscoveryState();
    state = enablePack(state, "todo");

    const visible = listVisibleTools(tools, state);
    const ids = visible.map((t) => t.id);

    // Core still present
    expect(ids).toContain("read");
    expect(ids).toContain("ask_question");

    // Pack tools now visible
    expect(ids).toContain("todo_write");
    expect(ids).toContain("todo_list");

    // Other packs still hidden
    expect(ids).not.toContain("web_search");
  });

  it("expands further when a second pack is enabled", () => {
    const { tools } = buildMockRegistry();
    let state = createLazyToolDiscoveryState();
    state = enablePack(state, "todo");
    state = enablePack(state, "web");

    const visible = listVisibleTools(tools, state);
    const ids = visible.map((t) => t.id);

    expect(ids).toContain("todo_write");
    expect(ids).toContain("web_search");
    expect(ids).toContain("web_fetch");
    // Still hidden
    expect(ids).not.toContain("spawn_agent");
  });

  it("result is sorted by tool id", () => {
    const { tools } = buildMockRegistry();
    let state = createLazyToolDiscoveryState();
    state = enablePack(state, "web");
    state = enablePack(state, "todo");

    const visible = listVisibleTools(tools, state);
    const ids = visible.map((t) => t.id);

    expect(ids).toEqual([...ids].sort());
  });

  it("prefix patterns (mcp.*) match bridged MCP tools", () => {
    const { tools } = buildMockRegistry();
    let state = createLazyToolDiscoveryState();
    state = enablePack(state, "mcp");

    const visible = listVisibleTools(tools, state);
    const ids = visible.map((t) => t.id);

    // Explicit MCP tools
    expect(ids).toContain("mcp_bridge_status");
    expect(ids).toContain("search_tool");
    expect(ids).toContain("use_tool");
    // Bridged MCP tools matched by prefix
    expect(ids).toContain("mcp.github.issues");
    expect(ids).toContain("mcp.filesystem.read");
  });

  it("disabling a pack removes its tools from visibility", () => {
    const { tools } = buildMockRegistry();
    let state = createLazyToolDiscoveryState();
    state = enablePack(state, "todo");
    state = enablePack(state, "web");
    state = disablePack(state, "web");

    const visible = listVisibleTools(tools, state);
    const ids = visible.map((t) => t.id);

    expect(ids).toContain("todo_write");
    expect(ids).not.toContain("web_search");
    // Core still present when pack tools change
    expect(ids).toContain("read");
  });

  it("disable is idempotent", () => {
    const { tools } = buildMockRegistry();
    let state = createLazyToolDiscoveryState();
    state = enablePack(state, "todo");
    state = disablePack(state, "web"); // not enabled — no-op

    const visible = listVisibleTools(tools, state);
    const ids = visible.map((t) => t.id);
    expect(ids).toContain("todo_write");
  });

  it("enabling an unknown pack throws", () => {
    const state = createLazyToolDiscoveryState();
    expect(() => enablePack(state, "nonexistent")).toThrow("Unknown tool pack: nonexistent");
  });
});

// ── Pack discovery ───────────────────────────────────────────────────────────

describe("discoverPacks", () => {
  it("returns every default pack", () => {
    const packs = discoverPacks();
    expect(packs.length).toBeGreaterThanOrEqual(10);
    // Spot-check a few expected packs
    const ids = packs.map((p) => p.id);
    expect(ids).toContain("todo");
    expect(ids).toContain("web");
    expect(ids).toContain("mcp");
    expect(ids).toContain("memory");
    expect(ids).toContain("github");
    expect(ids).toContain("swarm");
  });

  it("every pack has the required fields", () => {
    for (const pack of discoverPacks()) {
      expect(pack.id).toBeTruthy();
      expect(pack.title).toBeTruthy();
      expect(pack.description).toBeTruthy();
      expect(pack.toolIdPatterns.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("pack ids are unique", () => {
    const ids = discoverPacks().map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ── enabled pack tracking ────────────────────────────────────────────────────

describe("enablePack / getEnabledPackIds", () => {
  it("enablePack adds and returns sorted ids", () => {
    let state = createLazyToolDiscoveryState();
    state = enablePack(state, "web");
    state = enablePack(state, "todo");

    expect(getEnabledPackIds(state)).toEqual(["todo", "web"]);
  });

  it("enablePack is idempotent", () => {
    let state = createLazyToolDiscoveryState();
    state = enablePack(state, "web");
    const same = enablePack(state, "web");
    expect(same).toBe(state); // same object reference
    expect(getEnabledPackIds(same)).toEqual(["web"]);
  });
});

// ── Edge: empty tool list, unknown tools ─────────────────────────────────────

describe("listVisibleTools edge cases", () => {
  it("handles an empty tool list", () => {
    const state = createLazyToolDiscoveryState();
    const visible = listVisibleTools([], state);
    expect(visible).toEqual([]);
  });

  it("ignores tools that match no pack and are not core", () => {
    const unknownTool = stubTool("completely.unknown.tool");
    const tools: ToolDefinition[] = [...["read", "write"].map(stubTool), unknownTool];
    const state = createLazyToolDiscoveryState();

    const visible = listVisibleTools(tools, state);
    const ids = visible.map((t) => t.id);
    expect(ids).toContain("read");
    expect(ids).toContain("write");
    expect(ids).not.toContain("completely.unknown.tool");
  });
});

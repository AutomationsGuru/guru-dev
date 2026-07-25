import { describe, expect, it } from "vitest";

import type { McpInventoryEntry } from '../../src/mcp/mcpInventorySnapshot.js';
import { toInventory } from '../../src/mcp/mcpInventorySnapshot.js';
import type { McpServerConfig, McpServerStatus } from '../../src/mcp/schemas.js';

/** Strict-safe single-entry accessor: assert presence, then narrow away undefined. */
function first(entries: readonly McpInventoryEntry[]): McpInventoryEntry {
  expect(entries).toHaveLength(1);
  const entry = entries[0];
  if (!entry) throw new Error("expected exactly one inventory entry");
  return entry;
}

function config(partial: Partial<McpServerConfig> & Pick<McpServerConfig, "id">): McpServerConfig {
  return {
    enabled: true,
    transport: "stdio",
    command: "mcp-echo",
    args: [],
    url: undefined,
    requiredEnvNames: [],
    category: "test",
    timeoutMs: 30000,
    ...partial
  } as McpServerConfig;
}

function status(partial: Partial<McpServerStatus> & Pick<McpServerStatus, "serverId" | "status">): McpServerStatus {
  return {
    transport: "stdio",
    missingEnvNames: [],
    summary: `${partial.serverId} status.`,
    ...partial
  } as McpServerStatus;
}

describe("toInventory — MCP readiness snapshot", () => {
  it("marks a configured server with a ready live status as connected", () => {
    const entry = first(
      toInventory(
        [config({ id: "echo" })],
        [status({ serverId: "echo", status: "ready", toolCount: 4 })]
      ).entries
    );

    expect(entry).toMatchObject({ serverId: "echo", connection: "connected", status: "ready" });
    expect(entry.toolCount).toBe(4);
    expect(entry.missing).toBe(false);
  });

  it("flags a configured server with no live status as missing", () => {
    const entry = first(toInventory([config({ id: "ghost" })], []).entries);

    expect(entry).toMatchObject({ serverId: "ghost", connection: "missing", status: "missing" });
    expect(entry.missing).toBe(true);
    expect(entry.summary).toMatch(/no live status/i);
  });

  it("flags a configured server whose live status is not ready as missing, preserving why", () => {
    const entry = first(
      toInventory(
        [config({ id: "keyless", requiredEnvNames: ["GURUHARNESS_TEST_KEY"] })],
        [
          status({
            serverId: "keyless",
            status: "missing-env",
            missingEnvNames: ["GURUHARNESS_TEST_KEY"]
          })
        ]
      ).entries
    );

    expect(entry).toMatchObject({ serverId: "keyless", connection: "missing", status: "missing-env" });
    expect(entry.missing).toBe(true);
    expect(entry.missingEnvNames).toEqual(["GURUHARNESS_TEST_KEY"]);
  });

  it("ignores live statuses for servers that are not configured", () => {
    const inventory = toInventory(
      [config({ id: "echo" })],
      [status({ serverId: "stray", status: "ready" })]
    );

    expect(inventory.entries.map((entry) => entry.serverId)).toEqual(["echo"]);
  });

  it("preserves config order and keeps one entry per configured server", () => {
    const inventory = toInventory(
      [config({ id: "zeta" }), config({ id: "alpha" })],
      [status({ serverId: "alpha", status: "ready" })]
    );

    expect(inventory.entries.map((entry) => entry.serverId)).toEqual(["zeta", "alpha"]);
    expect(inventory.entries.map((entry) => entry.connection)).toEqual(["missing", "connected"]);
  });

  it("summarizes connected vs missing counts", () => {
    const summary = toInventory(
      [config({ id: "a" }), config({ id: "b" }), config({ id: "c" })],
      [status({ serverId: "a", status: "ready" })]
    ).summary;

    expect(summary).toMatchObject({ total: 3, connected: 1, missing: 2 });
  });
});

import type { McpReadinessStatus, McpServerConfig, McpServerStatus } from "./schemas.js";

/**
 * MCP inventory snapshot — a readiness projection over configured MCP servers.
 *
 * Merges the operator's configured `McpServerConfig` list with the live
 * `McpServerStatus` board produced by attachConfiguredMcpServers, and classifies
 * each configured server as connected (a real tool-bearing client is live) or
 * missing (configured but not usable right now), keeping the honest reason WHY.
 *
 * This is a pure read surface — it owns no state, mutates nothing, and makes no
 * network/process calls. It is the basis for the /ready and /tools operator
 * surfaces ("what MCP capability do I actually have, and what am I missing").
 *
 * Semantics:
 * - connected  = the server has a live status of `ready` (a client was attached).
 * - missing    = the server is configured but not connected: either it has no
 *                live status at all, or its live status is anything other than
 *                `ready` (disabled / missing-env / missing-command / offline /
 *                error / not-implemented). Missing never throws — it surfaces
 *                the readiness status so the never-stuck resolver can pick a
 *                BUILD / ATTACH / LEARN move.
 */

export type McpInventoryConnection = "connected" | "missing";

/**
 * `missing` is a synthetic readiness value used when a configured server has no
 * live status at all. It is intentionally NOT a member of McpReadinessStatus —
 * the live board only ever reports states a real attach attempt reached; a
 * configured-but-never-attempted server is a different, inventory-only fact.
 */
export type McpInventoryReadiness = McpReadinessStatus | "missing";

export interface McpInventoryEntry {
  readonly serverId: string;
  /** Configured transport (stdio/http/sse), regardless of connection state. */
  readonly transport: McpServerConfig["transport"];
  /** connected = live and ready; missing = configured but not usable now. */
  readonly connection: McpInventoryConnection;
  /** Convenience flag — true iff connection === "missing". */
  readonly missing: boolean;
  /** Honest readiness reason. "missing" when no live status exists. */
  readonly status: McpInventoryReadiness;
  readonly missingEnvNames: readonly string[];
  /** Tool count if a ready client was attached; absent otherwise. */
  readonly toolCount?: number;
  readonly summary: string;
}

export interface McpInventorySummary {
  readonly total: number;
  readonly connected: number;
  readonly missing: number;
}

export interface McpInventory {
  readonly entries: readonly McpInventoryEntry[];
  readonly summary: McpInventorySummary;
}

/**
 * Build an MCP inventory snapshot from configs + the live status board.
 *
 * @param configs   configured MCP servers (drives order and the entry set).
 * @param liveStatus live attach statuses (e.g. getMcpAttachmentStatuses()).
 *                   Statuses for servers not in `configs` are ignored.
 */
export function toInventory(
  configs: readonly McpServerConfig[],
  liveStatus: readonly McpServerStatus[]
): McpInventory {
  const liveByServerId = new Map<string, McpServerStatus>();
  for (const status of liveStatus) {
    liveByServerId.set(status.serverId, status);
  }

  const entries: McpInventoryEntry[] = configs.map((config) => {
    const live = liveByServerId.get(config.id);

    if (live && live.status === "ready") {
      return {
        serverId: config.id,
        transport: config.transport,
        connection: "connected",
        missing: false,
        status: live.status,
        missingEnvNames: [...(live.missingEnvNames ?? [])],
        ...(live.toolCount === undefined ? {} : { toolCount: live.toolCount }),
        summary: live.summary
      };
    }

    if (live) {
      return {
        serverId: config.id,
        transport: config.transport,
        connection: "missing",
        missing: true,
        status: live.status,
        missingEnvNames: [...(live.missingEnvNames ?? [])],
        ...(live.toolCount === undefined ? {} : { toolCount: live.toolCount }),
        summary: live.summary
      };
    }

    return {
      serverId: config.id,
      transport: config.transport,
      connection: "missing",
      missing: true,
      status: "missing",
      missingEnvNames: [],
      summary: `${config.id} is configured but has no live status (not attached).`
    };
  });

  const connected = entries.filter((entry) => entry.connection === "connected").length;
  const missing = entries.length - connected;

  return {
    entries,
    summary: { total: entries.length, connected, missing }
  };
}

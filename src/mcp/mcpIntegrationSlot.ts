import type { ToolDefinition } from "../tools/registry.js";

/**
 * MCP integration slot — register / enable-disable / list for the MCP tool
 * bridge surface (P2 IDEA-F262-MCP-SLOT-01). One independent data structure
 * sits *above* `attachConfiguredMcpServers` / `discoverMcpTools`: the bridge
 * hands the slot per-server `ToolDefinition[]`, and the slot decides what the
 * session tool catalog actually sees.
 *
 * Why a separate layer:
 *  - `attach.ts` is boot-time transport wiring (connect, handshake, discover).
 *  - `toolBridge.ts` is one-shot tool registry wrapping.
 *  - This slot is the *operator-facing* enable/disable surface — the thing a
 *    runtime session catalog reads from when it assembles its tools. It is
 *    intentionally pure: no I/O, no transport, no env, no async. That makes it
 *    trivial to test, replay, serialize, and reason about.
 *
 * Frozen extension seam: this module never imports the transport, the
 * registry, or any read-shaped surface. It accepts `ToolDefinition` and
 * exposes `ToolDefinition` — nothing else leaves the slot.
 *
 * Identity invariant (review-guarded): tool ids entering the slot must be
 * shaped `mcp.<serverId>.<tool>`. A tool id that doesn't match its server is
 * rejected — the slot will not silently let a "spoofed" id leak into the
 * session catalog under another server's name.
 */

export interface McpSlotServerEntry {
  readonly serverId: string;
  readonly enabled: boolean;
  /** All known tools for this server (enabled or not) — frozen. */
  readonly tools: readonly ToolDefinition[];
}

export interface McpIntegrationSlot {
  /**
   * Register (or merge) a server's tools.
   *
   * Behavior:
   *  - First call for a server: creates the entry, enables it by default.
   *  - Subsequent calls: dedupes tool ids against the existing tool set,
   *    adds new ones, and PRESERVES the prior enabled/disabled state. A
   *    user who disabled a server stays disabled across re-registration.
   *
   * Validation:
   *  - `serverId` must be a non-blank trimmed string.
   *  - Every tool id must be shaped `mcp.<serverId>.<tool>` — same server.
   *  - Tool ids within one payload must be unique.
   */
  register(serverId: string, tools: readonly ToolDefinition[]): void;

  /**
   * Enable a server. Returns `true` if the state changed, `false` if the
   * server was already enabled, unknown (not registered), or already enabled.
   */
  enable(serverId: string): boolean;

  /**
   * Disable a server. Returns `true` if the state changed, `false` if it was
   * already disabled or unknown.
   */
  disable(serverId: string): boolean;

  /** Whether the server is currently registered AND enabled. */
  isEnabled(serverId: string): boolean;

  /**
   * Sorted (by tool id) frozen snapshot of every tool from every currently
   * enabled server. Re-fetched on every call; the result is structurally
   * frozen to keep callers honest.
   */
  listEnabledTools(): readonly ToolDefinition[];

  /**
   * Insertion-ordered frozen snapshot of every registered server entry,
   * including the tools known for it and its current enabled flag.
   */
  listServers(): readonly McpSlotServerEntry[];

  /**
   * Frozen snapshot of one server's entry, or `undefined` if the server is
   * not registered.
   */
  getServerEntry(serverId: string): McpSlotServerEntry | undefined;

  /**
   * Unregister a server entirely. Returns `true` if the server was present,
   * `false` if it was already absent. A disabled-after-remove server is gone;
   * a subsequent `enable` for the same id is a documented no-op (a clean
   * 'ghost' rather than resurrection).
   */
  remove(serverId: string): boolean;
}

interface InternalServerEntry {
  serverId: string;
  enabled: boolean;
  /** Insertion order of `mcpToolId` keys; preserved for stable re-registration. */
  toolOrder: string[];
  /** Map is more robust to dedupe than a single array. */
  tools: Map<string, ToolDefinition>;
}

function freezeToolsArray(arr: readonly ToolDefinition[]): readonly ToolDefinition[] {
  // The tools themselves may be mutable in principle; we just want to block
  // external splices/pushes. Object.freeze on the array is enough.
  Object.freeze(arr);
  return arr;
}

function toFrozenEntry(entry: InternalServerEntry): McpSlotServerEntry {
  const tools = Object.freeze(entry.toolOrder.map((id) => entry.tools.get(id)!));
  const frozen: McpSlotServerEntry = { serverId: entry.serverId, enabled: entry.enabled, tools };
  Object.freeze(frozen);
  return frozen;
}

function assertValidServerId(serverId: string): void {
  if (typeof serverId !== "string" || serverId.trim().length === 0) {
    throw new Error(`mcpIntegrationSlot: serverId must be a non-blank string (received ${JSON.stringify(serverId)}).`);
  }
}

function assertToolsMatchServer(serverId: string, tools: readonly ToolDefinition[]): void {
  const prefix = `mcp.${serverId}.`;
  for (const tool of tools) {
    if (typeof tool.id !== "string" || !tool.id.startsWith(prefix)) {
      throw new Error(
        `mcpIntegrationSlot: tool id '${tool.id}' does not match registered server '${serverId}' (expected 'mcp.${serverId}.<tool>').`
      );
    }
  }
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.id)) {
      throw new Error(`mcpIntegrationSlot: duplicate tool id '${tool.id}' in a single register payload.`);
    }
    seen.add(tool.id);
  }
}

export function createMcpIntegrationSlot(): McpIntegrationSlot {
  /** Insertion-ordered list of internal entries. */
  const entries: InternalServerEntry[] = [];
  /** Lookup helper; rebuilt state is cheap. */
  const indexById = new Map<string, InternalServerEntry>();

  function findOrCreateEntry(serverId: string): InternalServerEntry {
    const existing = indexById.get(serverId);
    if (existing) return existing;
    const created: InternalServerEntry = {
      serverId,
      enabled: true,
      toolOrder: [],
      tools: new Map()
    };
    entries.push(created);
    indexById.set(serverId, created);
    return created;
  }

  function setEnabled(entry: InternalServerEntry, next: boolean): boolean {
    if (entry.enabled === next) return false;
    entry.enabled = next;
    return true;
  }

  return {
    register(serverId, tools) {
      assertValidServerId(serverId);
      assertToolsMatchServer(serverId, tools);
      const entry = findOrCreateEntry(serverId);
      for (const tool of tools) {
        if (!entry.tools.has(tool.id)) {
          entry.tools.set(tool.id, tool);
          entry.toolOrder.push(tool.id);
        }
      }
    },

    enable(serverId) {
      const entry = indexById.get(serverId);
      if (!entry) return false;
      return setEnabled(entry, true);
    },

    disable(serverId) {
      const entry = indexById.get(serverId);
      if (!entry) return false;
      return setEnabled(entry, false);
    },

    isEnabled(serverId) {
      const entry = indexById.get(serverId);
      return entry?.enabled === true;
    },

    listEnabledTools() {
      const collected: ToolDefinition[] = [];
      for (const entry of entries) {
        if (!entry.enabled) continue;
        for (const tool of entry.tools.values()) {
          collected.push(tool);
        }
      }
      collected.sort((a, b) => a.id.localeCompare(b.id));
      return freezeToolsArray(collected);
    },

    listServers() {
      return Object.freeze(entries.map((e) => toFrozenEntry(e)));
    },

    getServerEntry(serverId) {
      const entry = indexById.get(serverId);
      if (!entry) return undefined;
      return toFrozenEntry(entry);
    },

    remove(serverId) {
      const entry = indexById.get(serverId);
      if (!entry) return false;
      const idx = entries.indexOf(entry);
      if (idx >= 0) entries.splice(idx, 1);
      indexById.delete(serverId);
      return true;
    }
  };
}

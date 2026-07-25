import { z } from "zod";

import type { ToolDefinition } from "../tools/registry.js";
import { McpServerIdSchema, type McpServerId } from "./schemas.js";

/**
 * MCP integration slot — the explicit-gating layer between ATTACH and the
 * session tool catalog. attachConfiguredMcpServers hands over a flat pile of
 * bridged ToolDefinitions; this slot re-groups them by serverId so the
 * operator (or policy) can enable/disable an attached server's whole tool set
 * as ONE decision, per GuruHarness's explicit-gating constitution: an
 * attached capability is inert until its set is enabled, and disabling never
 * destroys the registration — the set stays visible in the catalog, honestly
 * marked disabled, so the operator can see WHY a tool is out and re-enable it.
 *
 * The slot is pure and process-local: no network I/O, no child processes, no
 * new dependencies. It operates on already-bridged ToolDefinition[] (output
 * of discoverMcpTools), so wiring it into createSessionTooling is a future
 * owner's one-line change — register each set here, then feed
 * listEnabledTools() into the registry instead of the raw attachment pile.
 *
 * Duplicate serverIds throw, mirroring ToolRegistry semantics: a second
 * registration for the same server would silently shadow the first set's
 * gating state, so it is rejected loudly instead.
 */

const ToolDefinitionShapeSchema = z
  .object({
    id: z.string().trim().min(1),
    title: z.string(),
    description: z.string(),
    inputSchema: z.instanceof(z.ZodType),
    outputSchema: z.instanceof(z.ZodType),
    // z.custom, not z.function(): zod wraps z.function() values on parse,
    // which would break ToolDefinition identity for registry consumers.
    execute: z.custom<ToolDefinition["execute"]>((value) => typeof value === "function", "Expected a tool execute function.")
  })
  .loose();

export const McpToolSetRegistrationSchema = z
  .object({
    serverId: McpServerIdSchema,
    /** Already-bridged tools for this server (from discoverMcpTools). Readonly arrays accepted; stored as-is. */
    tools: z.array(ToolDefinitionShapeSchema).readonly(),
    /**
     * Initial gating state. Default TRUE (mirrors McpServerConfig.enabled's
     * default): ATTACH implies intent to use, so a freshly registered set is
     * live; pass false to stage a set in the catalog without exposing it.
     */
    enabled: z.boolean().default(true)
  })
  .strict();

/**
 * Declared structurally (not z.infer): the zod schema above is the runtime
 * boundary, but its loose-object output type would force an index signature
 * onto callers' ToolDefinition literals at compile time.
 */
export interface McpToolSetRegistration {
  readonly serverId: McpServerId;
  readonly tools: readonly ToolDefinition[];
  /** Defaults to true — see McpToolSetRegistrationSchema. */
  readonly enabled?: boolean;
}

/** Read-only catalog entry: one registered set with its gating state. */
export interface McpToolSetView {
  readonly serverId: McpServerId;
  readonly enabled: boolean;
  readonly toolIds: readonly string[];
}

export interface McpIntegrationSlot {
  /** Register a server's bridged tools. Throws on duplicate serverId or invalid input. */
  registerToolSet(registration: McpToolSetRegistration): void;
  /** Enable a registered set. Throws on unknown serverId. */
  enable(serverId: McpServerId): void;
  /** Disable a registered set (kept in the catalog, hidden from the session view). Throws on unknown serverId. */
  disable(serverId: McpServerId): void;
  /** Every registered set with its enabled state and tool ids (snapshot). */
  listToolSets(): readonly McpToolSetView[];
  /** The session tool catalog view: enabled sets' tools flattened (snapshot). */
  listEnabledTools(): readonly ToolDefinition[];
}

interface SlotEntry {
  enabled: boolean;
  readonly tools: readonly ToolDefinition[];
}

export function createMcpIntegrationSlot(): McpIntegrationSlot {
  const sets = new Map<McpServerId, SlotEntry>();

  function requireEntry(serverId: McpServerId): SlotEntry {
    const entry = sets.get(serverId);
    if (!entry) {
      throw new Error(`MCP tool set not registered: ${serverId}`);
    }
    return entry;
  }

  return {
    registerToolSet(registration) {
      const parsed = McpToolSetRegistrationSchema.parse(registration);
      if (sets.has(parsed.serverId)) {
        throw new Error(`MCP tool set already registered: ${parsed.serverId}`);
      }
      sets.set(parsed.serverId, {
        enabled: parsed.enabled,
        // Original references (not the parsed clones) so listEnabledTools()
        // hands the registry the very definitions the bridge produced.
        tools: [...registration.tools]
      });
    },
    enable(serverId) {
      const id = McpServerIdSchema.parse(serverId);
      requireEntry(id).enabled = true;
    },
    disable(serverId) {
      const id = McpServerIdSchema.parse(serverId);
      requireEntry(id).enabled = false;
    },
    listToolSets() {
      return [...sets.entries()].map(([serverId, entry]) => ({
        serverId,
        enabled: entry.enabled,
        toolIds: entry.tools.map((tool) => tool.id)
      }));
    },
    listEnabledTools() {
      return [...sets.values()].filter((entry) => entry.enabled).flatMap((entry) => [...entry.tools]);
    }
  };
}

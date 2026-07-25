import type { ToolDefinition } from "./registry.js";
import {
  CORE_TOOL_IDS,
  DEFAULT_PACKS,
  LazyToolDiscoveryStateSchema,
  type LazyToolDiscoveryState,
  type ToolPack
} from "./lazyToolDiscoverySchema.js";

// ── State factories ──────────────────────────────────────────────────────────

/** Fresh state with no optional packs enabled — core tools only. */
export function createLazyToolDiscoveryState(): LazyToolDiscoveryState {
  return LazyToolDiscoveryStateSchema.parse({ enabledPacks: [] });
}

// ── Queries ──────────────────────────────────────────────────────────────────

/** True when the tool id is in the permanent core set (never hidden). */
export function isCoreTool(toolId: string): boolean {
  return CORE_TOOL_IDS.has(toolId);
}

/** List every available pack, regardless of enablement state. */
export function discoverPacks(): readonly ToolPack[] {
  return DEFAULT_PACKS;
}

/** Pack ids currently enabled. */
export function getEnabledPackIds(state: LazyToolDiscoveryState): readonly string[] {
  return state.enabledPacks;
}

// ── Visibility ───────────────────────────────────────────────────────────────

/**
 * Filter a full tool list to only the tools that should be visible to the
 * model right now: every core tool, plus every tool from an enabled pack.
 * Tools that match neither are hidden.  Result is sorted by id for stable
 * schema ordering (same sort as {@link ToolRegistry.list}).
 */
export function listVisibleTools(
  allTools: readonly ToolDefinition[],
  state: LazyToolDiscoveryState
): readonly ToolDefinition[] {
  const enabledPackIds = new Set(state.enabledPacks);

  return allTools
    .filter((tool) => {
      if (isCoreTool(tool.id)) return true;
      return DEFAULT_PACKS.some(
        (pack) => enabledPackIds.has(pack.id) && isToolInPack(tool.id, pack)
      );
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

// ── Mutations (immutable) ────────────────────────────────────────────────────

/**
 * Enable a pack by id.  Returns a new state object; the original is untouched.
 * Throws when the pack id is unknown — callers should validate via
 * {@link discoverPacks} first.
 */
export function enablePack(
  state: LazyToolDiscoveryState,
  packId: string
): LazyToolDiscoveryState {
  if (!DEFAULT_PACKS.some((p) => p.id === packId)) {
    throw new Error(`Unknown tool pack: ${packId}`);
  }
  if (state.enabledPacks.includes(packId)) {
    return state; // idempotent
  }
  return LazyToolDiscoveryStateSchema.parse({
    enabledPacks: [...state.enabledPacks, packId].sort()
  });
}

/**
 * Disable a pack by id.  Idempotent — disabling an already-disabled pack
 * is a no-op (returns the same state object).
 */
export function disablePack(
  state: LazyToolDiscoveryState,
  packId: string
): LazyToolDiscoveryState {
  if (!state.enabledPacks.includes(packId)) {
    return state;
  }
  return LazyToolDiscoveryStateSchema.parse({
    enabledPacks: state.enabledPacks.filter((id) => id !== packId)
  });
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Match a tool id against a pack's pattern list.  A pattern ending in `.*`
 * matches any tool whose id starts with the prefix (including an exact match
 * on the prefix itself).  All other patterns are exact matches.
 */
function isToolInPack(toolId: string, pack: ToolPack): boolean {
  return pack.toolIdPatterns.some((pattern) => {
    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -2);
      return toolId === prefix || toolId.startsWith(`${prefix}.`);
    }
    return toolId === pattern;
  });
}

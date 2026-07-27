/**
 * Lazy tool discovery (IDEA-F106-LAZY-TOOLS-01) — shared types and dependency-free
 * runtime guards.
 *
 * Safety contract: this module filters the model-facing tool CATALOG only. Every
 * execution still flows through `executeRegisteredTool` (schema validation plus
 * output sanitization at the registry choke point), so hiding a tool from the
 * prompt can never weaken a hard limit. Conversely, safety-critical tools must
 * always remain VISIBLE — see `SAFETY_CRITICAL_TOOL_IDS` in
 * `./lazyToolDiscovery.js`.
 *
 * Environment constraint: this file is imported under
 * `node24 --experimental-strip-types` with no node_modules, so it must have NO
 * runtime imports at all (type-only imports are erased).
 */
import type { ToolDefinition } from "./registry.js";

/**
 * A named bundle of tools kept out of the default prompt surface until an
 * operator or model explicitly enables the pack (e.g. `mcp:github`, `ext:web`).
 * Pack ids are namespaced (`mcp:<serverId>`, `ext:<group>`) so they can never
 * collide with bare tool ids such as `search_tool` / `use_tool`.
 */
export interface ToolPackDefinition {
  readonly id: string;
  /** One-line, prompt-safe description shown by `discoverPacks()`. */
  readonly description: string;
  readonly toolIds: readonly string[];
}

/**
 * Immutable discovery state: the set of pack ids enabled so far. `enablePack`
 * returns a NEW state object and never mutates a prior one, so callers can hold
 * onto per-turn snapshots safely.
 */
export interface LazyToolDiscoveryState {
  readonly enabledPackIds: readonly string[];
}

/**
 * Metadata-only view of a pack, exposed by `discoverPacks()`. Deliberately
 * carries NO tool ids, schemas, or executors — the whole point of lazy
 * discovery is that pack internals stay out of the prompt until enable.
 */
export interface ToolPackMetadata {
  readonly id: string;
  readonly description: string;
}

/**
 * Constructor config for `createLazyToolDiscovery`.
 *
 * - `tools`: the full registered tool set (typically `registry.list()`).
 * - `coreToolIds`: tools visible by default, before any pack is enabled.
 * - `packs`: lazily-loadable bundles.
 * - `safetyCriticalToolIds`: ADDITIONAL ids to union into the always-visible
 *   floor on top of the built-in `SAFETY_CRITICAL_TOOL_IDS`. The built-in
 *   floor cannot be removed or weakened by config.
 */
export interface LazyToolDiscoveryConfig {
  readonly tools: readonly ToolDefinition[];
  readonly coreToolIds: readonly string[];
  readonly packs: readonly ToolPackDefinition[];
  readonly safetyCriticalToolIds?: readonly string[];
}

/** Dependency-free structural guard for {@link ToolPackDefinition}. */
export function isToolPackDefinition(value: unknown): value is ToolPackDefinition {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.description === "string" &&
    Array.isArray(candidate.toolIds) &&
    candidate.toolIds.every((toolId) => typeof toolId === "string" && toolId.length > 0)
  );
}

/** Dependency-free structural guard for {@link LazyToolDiscoveryState}. */
export function isLazyToolDiscoveryState(value: unknown): value is LazyToolDiscoveryState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate.enabledPackIds) &&
    candidate.enabledPackIds.every((packId) => typeof packId === "string" && packId.length > 0)
  );
}

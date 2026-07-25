import type { ToolDefinition, ToolRegistry } from "./registry.js";

/**
 * Composite tool pack (IDEA-F291-TOOL-PACK-01).
 *
 * A pack is a **manifest-only grouping** of already-registered tool ids. It is
 * the thinnest possible "single enable flag" over the frozen tool registry: it
 * names which tools travel together, and `loadPack` resolves those names
 * against a registry the caller hands in.
 *
 * Coordinator vision constraint (binding): a pack CANNOT register tools, grant
 * authority, bypass the frozen registry/mandates, or execute anything. It only
 * resolves already-registered ids to their definitions. Unknown, duplicate,
 * unregistered, and forbidden members fail closed — `loadPack` throws rather
 * than silently dropping or synthesizing a member. This is deliberately a
 * second-class grouping surface, not a second tool-pack authority: the frozen
 * registry remains the single source of truth for what tools exist.
 */

export interface CompositeToolPackDefinition {
  /** Stable pack name, unique within a pack store. */
  readonly name: string;
  /**
   * Tool ids that belong to the pack. Order is not significant — resolved
   * members are returned registry-sorted and de-duplicated. Members are only
   * validated against the registry at load time, never at definition time.
   */
  readonly memberToolIds: readonly string[];
  /** Optional human-readable description of what the pack groups together. */
  readonly description?: string;
}

/**
 * A resolved pack: every member is a real, already-registered tool definition.
 * Carrying the definition (not just the id) lets callers act on the pack
 * without re-querying the registry, but it grants no capability the registry
 * did not already expose.
 */
export interface LoadedCompositeToolPack {
  readonly name: string;
  readonly description?: string;
  readonly members: ReadonlyArray<{ readonly id: string; readonly tool: ToolDefinition }>;
}

export interface CompositeToolPackLoadOptions {
  /**
   * Caller-supplied deny set. Any member id present here fails closed at load
   * time. This lets a mandate/operator gate forbid specific tool ids without
   * the pack layer claiming authority over mandates itself.
   */
  readonly forbiddenToolIds?: ReadonlySet<string>;
}

export interface CompositeToolPackStore {
  has(name: string): boolean;
  get(name: string): CompositeToolPackDefinition | undefined;
  list(): readonly CompositeToolPackDefinition[];
}

/**
 * Build a store of pack definitions from a manifest. Definitions are validated
 * for shape here (non-empty name, unique name, non-empty member list); member
 * ids are validated against the registry only when a pack is loaded, because a
 * pack may be defined before all its members are registered.
 */
export function createCompositeToolPacks(
  definitions: readonly CompositeToolPackDefinition[]
): CompositeToolPackStore {
  const byName = new Map<string, CompositeToolPackDefinition>();

  for (const definition of definitions) {
    if (!definition.name || definition.name.trim().length === 0) {
      throw new Error(`Composite tool pack has an invalid name: ${JSON.stringify(definition.name)}`);
    }
    if (definition.memberToolIds.length === 0) {
      throw new Error(`Composite tool pack "${definition.name}" has an empty member list`);
    }
    if (byName.has(definition.name)) {
      throw new Error(`Composite tool pack already defined: ${definition.name}`);
    }
    byName.set(definition.name, definition);
  }

  return {
    has(name) {
      return byName.has(name);
    },
    get(name) {
      return byName.get(name);
    },
    list() {
      return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    }
  };
}

/**
 * Resolve a named pack against a frozen registry. Read-only with respect to
 * the registry: it never registers, deregisters, or executes a tool.
 *
 * Fail-closed resolution:
 * - unknown pack name → throws
 * - member id not present in the registry → throws (lists the missing id)
 * - member id in the caller-supplied forbidden set → throws (lists the id)
 *
 * Duplicate member ids in the manifest are tolerated and collapsed — they do
 * not grant any doubled authority, so they are not a safety boundary.
 */
export function loadPack(
  registry: ToolRegistry,
  packs: CompositeToolPackStore,
  name: string,
  options: CompositeToolPackLoadOptions = {}
): LoadedCompositeToolPack {
  const definition = packs.get(name);
  if (!definition) {
    throw new Error(`Unknown composite tool pack: ${name}`);
  }

  const forbidden = options.forbiddenToolIds;
  const seen = new Set<string>();
  const members: Array<{ id: string; tool: ToolDefinition }> = [];

  for (const toolId of definition.memberToolIds) {
    if (seen.has(toolId)) {
      // Tolerated: a repeated id grants no doubled authority.
      continue;
    }
    seen.add(toolId);

    if (forbidden?.has(toolId)) {
      throw new Error(`Composite tool pack "${name}" contains a forbidden tool id: ${toolId}`);
    }

    const tool = registry.get(toolId);
    if (!tool) {
      throw new Error(`Composite tool pack "${name}" references a tool not registered: ${toolId}`);
    }

    members.push({ id: toolId, tool });
  }

  // Stable order: registry is the authority, so mirror its id-sorted order.
  members.sort((a, b) => a.id.localeCompare(b.id));

  return {
    name: definition.name,
    ...(definition.description ? { description: definition.description } : {}),
    members
  };
}

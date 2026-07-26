/**
 * Lazy tool discovery (IDEA-F106-LAZY-TOOLS-01).
 *
 * Exposes a small CORE tool set by default; additional packs (MCP groups,
 * extension groups, optional categories) load into the model-facing catalog
 * only after an explicit `enablePack`. This reduces prompt tool-schema bloat
 * without touching execution: every tool still runs through
 * `executeRegisteredTool`, which enforces schema validation and secret-scrubbed
 * output at the registry choke point, so hiding a tool from the catalog can
 * never weaken a hard limit.
 *
 * Invariants:
 * - `listVisibleTools` ALWAYS includes every safety-critical id present in the
 *   registry (`SAFETY_CRITICAL_TOOL_IDS` ∪ config `safetyCriticalToolIds`),
 *   regardless of pack state — enforced inside listVisibleTools, not just at
 *   construction, so no sequence of `enablePack` calls can hide them.
 * - `enablePack` returns a NEW frozen state; prior states are never mutated.
 * - Construction rejects duplicate tool ids, duplicate pack ids, packs
 *   referencing unknown tool ids, and core ids referencing unknown tools.
 *
 * Environment constraint: imported under `node24 --experimental-strip-types`
 * with no node_modules — only type-only imports (erased) and local value
 * imports from dependency-free modules are allowed here.
 */
import type { ToolDefinition } from "./registry.js";
import type {
  LazyToolDiscoveryConfig,
  LazyToolDiscoveryState,
  ToolPackMetadata
} from "./lazyToolDiscoverySchema.js";

/**
 * Tools that must always remain VISIBLE in the default catalog. Exported as a
 * fixed floor and UNIONED with any config-supplied `safetyCriticalToolIds`
 * (accept-and-union, not accept-or-default): a caller may only widen the
 * safety set, never narrow it — narrowing would silently strip plan-mode and
 * operator-escalation surfaces from the prompt. Grounding per id:
 *
 * - `glob`, `grep`, `ls`, `read` — the exact frozen PLAN_MODE_DEFAULT_TOOL_IDS
 *   (src/planner/planMode.ts); the only four builtins declaring
 *   `effect: "read-only"` and the certified plan-mode observation surface.
 *   Dropping them from the default catalog would silently break plan-mode
 *   prompting.
 * - `ask_question` — the sole operator-interaction/escalation channel; a model
 *   that cannot ask is forced to guess on irreversible actions.
 * - `search_tool`, `use_tool` — the existing MCP lazy-discovery meta pair
 *   (src/mcp/metaDispatch.ts). If MCP tools live behind packs, these are the
 *   discover/enable mechanism itself and must stay visible or packs become
 *   unreachable (bootstrap paradox).
 */
export const SAFETY_CRITICAL_TOOL_IDS: readonly string[] = [
  "ask_question",
  "glob",
  "grep",
  "ls",
  "read",
  "search_tool",
  "use_tool"
];

export interface LazyToolDiscovery {
  /** Metadata-only pack listing (id + one-line description); enables nothing. */
  discoverPacks(): readonly ToolPackMetadata[];
  /**
   * Full ToolDefinitions for core ∪ enabled-pack tools: deduped, sorted by id,
   * and always containing every registered safety-critical id.
   */
  listVisibleTools(state: LazyToolDiscoveryState): readonly ToolDefinition[];
  /** New state with `packId` enabled (idempotent). Unknown pack id → throw. */
  enablePack(state: LazyToolDiscoveryState, packId: string): LazyToolDiscoveryState;
  /** The initial state: no packs enabled. */
  initialState(): LazyToolDiscoveryState;
}

/**
 * Build a lazy pack catalog over the full registered tool set.
 *
 * @throws on duplicate tool ids, duplicate pack ids, core ids referencing
 * unknown tools, or packs referencing unknown tool ids — a misconfigured
 * catalog must fail loudly at construction, never silently at prompt time.
 */
export function createLazyToolDiscovery(config: LazyToolDiscoveryConfig): LazyToolDiscovery {
  const toolsById = new Map<string, ToolDefinition>();
  for (const tool of config.tools) {
    if (toolsById.has(tool.id)) {
      throw new Error(`Duplicate tool id in lazy discovery config: ${tool.id}`);
    }
    toolsById.set(tool.id, tool);
  }

  const packsById = new Map<string, readonly string[]>();
  for (const pack of config.packs) {
    if (packsById.has(pack.id)) {
      throw new Error(`Duplicate pack id in lazy discovery config: ${pack.id}`);
    }
    for (const toolId of pack.toolIds) {
      if (!toolsById.has(toolId)) {
        throw new Error(`Pack "${pack.id}" references unknown tool id: ${toolId}`);
      }
    }
    packsById.set(pack.id, pack.toolIds);
  }

  for (const coreId of config.coreToolIds) {
    if (!toolsById.has(coreId)) {
      throw new Error(`coreToolIds references unknown tool id: ${coreId}`);
    }
  }

  // Always-visible floor: config core ∪ built-in safety stub ∪ caller extras.
  // Union is a Set of strings — no tool metadata is copied, so nothing here
  // needs freezing beyond the exposed config arrays we copy below.
  const coreIdSet = new Set<string>([
    ...config.coreToolIds,
    ...SAFETY_CRITICAL_TOOL_IDS,
    ...(config.safetyCriticalToolIds ?? [])
  ]);

  const packMetadata: readonly ToolPackMetadata[] = config.packs.map((pack) => ({
    id: pack.id,
    description: pack.description
  }));

  return {
    discoverPacks() {
      return packMetadata.map((pack) => ({ ...pack }));
    },
    listVisibleTools(state) {
      const visibleIds = new Set<string>(coreIdSet);
      for (const packId of state.enabledPackIds) {
        const packToolIds = packsById.get(packId);
        if (packToolIds) {
          for (const toolId of packToolIds) {
            visibleIds.add(toolId);
          }
        }
      }
      return [...visibleIds]
        .filter((toolId) => toolsById.has(toolId))
        .sort((a, b) => a.localeCompare(b))
        .map((toolId) => toolsById.get(toolId) as ToolDefinition);
    },
    enablePack(state, packId) {
      if (!packsById.has(packId)) {
        throw new Error(`Unknown tool pack: ${packId}`);
      }
      if (state.enabledPackIds.includes(packId)) {
        return state;
      }
      return { enabledPackIds: [...state.enabledPackIds, packId] };
    },
    initialState() {
      return { enabledPackIds: [] };
    }
  };
}

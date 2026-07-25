import { z } from "zod";

/**
 * Role runtime map (F308 / R-TT-ROLE-RT) — fleet config that resolves an agent
 * role id to the runtime/provider slot it should run in.
 *
 * The fleet operator declares a config map of role id → {@link RuntimeSlot}.
 * An agent resolves its own role, then applies per-agent overrides on top. The
 * resolver FAILS CLOSED: an unknown role id throws and is never silently mapped
 * to an implicit default runtime — a missing mapping is a stop condition, not a
 * guess (vision §1.4: never-stuck means a stated move, never a hidden default;
 * vision §1.8 + §3.4: scope stays explicit, no out-of-scope crossing).
 *
 * This is config/lookup machinery only — it owns no runtime of its own and adds
 * no weight to core. The single core runtime dependency is `zod`, used here for
 * the same validated-config convention as the rest of the providers/roles layer.
 */

/**
 * One resolved place a role runs. A "slot" names the runtime surface and the
 * provider route to use; both are opaque ids resolved by their owning modules
 * (runtime/, providers/), so this map stays decoupled from any specific model
 * or framework (vision §1.1, §1.5 — no borrowed ceiling, no single-model lock).
 */
export const RuntimeSlotSchema = z
  .object({
    /** Runtime surface id (e.g. "session", "headless", "tui"). */
    runtime: z.string().min(1),
    /** Provider id this role routes through (e.g. "openai", "anthropic"). */
    providerId: z.string().min(1),
    /** Concrete route id (provider/model) the role binds to. */
    routeId: z.string().min(1)
  })
  .strict();

export type RuntimeSlot = z.infer<typeof RuntimeSlotSchema>;

/**
 * Per-agent overrides keyed by role id. A matching override REPLACES the
 * configured slot for that role (whole-slot replacement, not a merge — the
 * override is itself a fully-specified, validated slot).
 */
export const RoleOverridesSchema = z.record(z.string(), RuntimeSlotSchema);

export type RoleOverrides = z.infer<typeof RoleOverridesSchema>;

/**
 * The fleet config: role id → default runtime/provider slot. Ships empty by
 * construction (no shipped roles — vision §1.6, `src/roles/schema.ts`); the
 * operator populates it from their config.
 */
export const RoleRuntimeMapSchema = z
  .object({
    roles: z.record(z.string(), RuntimeSlotSchema)
  })
  .strict();

export type RoleRuntimeMap = z.infer<typeof RoleRuntimeMapSchema>;

/** A resolved role→runtime binding, carrying the role id it resolved for. */
export interface ResolvedRoleRuntime extends RuntimeSlot {
  readonly roleId: string;
}

/**
 * Resolve a role id to its runtime/provider slot, applying per-agent overrides.
 *
 * Resolution order (config is authority, override wins for KNOWN roles, fail
 * closed on unknown):
 *   1. The config map is the authority on which roles exist. If `roleId` is not
 *      in it, throw — never invent a default slot. An override for an unknown
 *      role CANNOT promote it to known (vision §1.4: a missing mapping is a
 *      stated stop, never a hidden default).
 *   2. If `overrides` carries a validated slot for a known `roleId`, it wins —
 *      the operator's per-agent decision overrides the config default (vision
 *      §1.7: obey the operator). Whole-slot replacement, not a merge.
 *   3. Otherwise the config map's slot for `roleId` is used.
 *
 * Returns a defensive copy so callers cannot mutate the underlying config.
 */
export function resolveRoleRuntime(
  map: RoleRuntimeMap,
  roleId: string,
  overrides: RoleOverrides = {}
): ResolvedRoleRuntime {
  const configured = map.roles[roleId];
  if (!configured) {
    throw new UnknownRoleRuntimeError(roleId);
  }

  const overrideSlot = overrides[roleId];
  if (overrideSlot) {
    return { roleId, ...overrideSlot };
  }

  return { roleId, ...configured };
}

/**
 * Thrown when a role id cannot be resolved to any runtime/provider slot.
 * Distinct class so callers can distinguish fail-closed resolution from
 * incidental errors and surface a real edge instead of guessing.
 */
export class UnknownRoleRuntimeError extends Error {
  public readonly roleId: string;

  public constructor(roleId: string) {
    super(`Unknown role id has no runtime/provider slot: "${roleId}"`);
    this.name = "UnknownRoleRuntimeError";
    this.roleId = roleId;
  }
}

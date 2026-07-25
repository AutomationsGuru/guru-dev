/**
 * Model role pack resolver (IDEA-F3, R-PD-PACK / R-PD-PACK-SW, 2026-07-18).
 *
 * Pure, config-driven resolution from a harness role to a provider/model id.
 * The resolver owns no provider knowledge, performs no I/O, and never installs
 * or imports anything: callers pass the session's default model id and the
 * parsed pack config, and receive the model id to route that role's work to.
 *
 * Behavior guarantees (tested):
 *  - Default identity: with no pack config — or with the built-in
 *    `daily-driver` pack active — every role resolves to the session default,
 *    so enabling pack resolution alone changes nothing.
 *  - Bounded fallback: when the caller reports an oversized working context
 *    and the role binding declares a `largeContextFallback`, that single
 *    fallback is used. Fallback is one bounded step, never a chain, and never
 *    applies when no fallback was declared.
 *  - Unknown role / missing binding: resolves to the session default.
 *  - Switch pack: the active pack is selected by config key; an unknown or
 *    absent `activePack` id falls back to `daily-driver` (identity), and the
 *    resolved pack id is reported so a session receipt/log line can record it.
 */

import {
  ModelRolePackConfigSchema,
  type ModelRole,
  type ModelRolePack,
  type ModelRolePackConfig,
  type ModelRolePackConfigInput
} from "./modelRolePackSchema.js";

/** The built-in pack id that mirrors current single-model behavior. */
export const DEFAULT_MODEL_ROLE_PACK_ID = "daily-driver";

/** The result of resolving one role against a pack. */
export interface ResolvedRoleModel {
  /** The role that was resolved (echoed for receipts/logs). */
  readonly role: ModelRole;
  /** The provider/model id to route this role's work to. */
  readonly model: string;
  /** Which binding produced `model`. */
  readonly source: "primary" | "largeContextFallback" | "default";
  /** The id of the pack that was consulted (built-in id when identity). */
  readonly packId: string;
}

export interface ResolveRoleOptions {
  /** Total tokens in the working context, if the caller tracks it. */
  readonly contextTokens?: number;
  /**
   * Context size above which a declared `largeContextFallback` is used.
   * Ignored when `contextTokens` is not provided.
   */
  readonly largeContextThresholdTokens?: number;
}

/**
 * The built-in identity pack. It declares no role bindings on purpose: the
 * resolver treats a missing binding as "use the session default", so this pack
 * reproduces today's single-model behavior exactly.
 */
export function dailyDriverPack(): ModelRolePack {
  return { id: DEFAULT_MODEL_ROLE_PACK_ID, roles: {} };
}

/**
 * Parse pack config input into a validated config. Tolerates `undefined` and
 * partial input; an invalid shape throws a zod error at the config boundary
 * (fail fast on bad config, never mid-resolution).
 */
export function parseModelRolePackConfig(input?: ModelRolePackConfigInput): ModelRolePackConfig {
  return ModelRolePackConfigSchema.parse(input ?? {});
}

/**
 * Select the active pack. An absent or unknown `activePack` id resolves to the
 * built-in identity pack, so a stale config key can never break routing.
 */
export function resolveActivePack(config?: ModelRolePackConfigInput): ModelRolePack {
  const parsed = parseModelRolePackConfig(config);
  if (parsed.activePack !== undefined) {
    const found = parsed.packs.find((pack) => pack.id === parsed.activePack);
    if (found !== undefined) {
      return found;
    }
  }
  return dailyDriverPack();
}

/**
 * Resolve the model id for a harness role.
 *
 * @param role   Harness role to resolve.
 * @param defaultModel  The session's current default model id — the identity
 *                      value returned whenever a pack does not specialize the
 *                      role (or the fallback predicate does not fire).
 * @param config Pack config input (optional; absent = identity).
 * @param options Context size hints for the bounded large-context fallback.
 */
export function resolveRoleModel(
  role: ModelRole,
  defaultModel: string,
  config?: ModelRolePackConfigInput,
  options: ResolveRoleOptions = {}
): ResolvedRoleModel {
  const pack = resolveActivePack(config);
  const binding = pack.roles[role];

  if (binding === undefined) {
    return { role, model: defaultModel, source: "default", packId: pack.id };
  }

  if (
    binding.largeContextFallback !== undefined &&
    options.contextTokens !== undefined &&
    options.largeContextThresholdTokens !== undefined &&
    options.contextTokens > options.largeContextThresholdTokens
  ) {
    return { role, model: binding.largeContextFallback, source: "largeContextFallback", packId: pack.id };
  }

  return { role, model: binding.model, source: "primary", packId: pack.id };
}

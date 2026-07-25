/**
 * Hook runtime profile resolution (IDEA-F490-HOOKPROF-01).
 *
 * Selects the active hook set for a runtime profile: `minimal` (bare loop),
 * `standard` (daily driver), or `strict` (full observability/compliance).
 * Profiles are strictly cumulative: strict ⊇ standard ⊇ minimal.
 *
 * Constitution enforcement (VISION §3): hard-limit hooks are never disabled.
 * A hard-limit id listed in `disabledIds` is reported in `hardLimitProtected`
 * and remains active — the disable request is ineffective for it, in code,
 * not prose.
 */

export type HookRuntimeProfile = "minimal" | "standard" | "strict";

export type HookId = string;

/** minimal: bare loop — lifecycle + error visibility only. */
const MINIMAL_HOOKS: readonly HookId[] = ["core.lifecycle", "core.error"];

/** standard: daily driver — minimal plus metrics + audit. */
const STANDARD_HOOKS: readonly HookId[] = [...MINIMAL_HOOKS, "core.metrics", "core.audit"];

/** strict: full surface — standard plus security + compliance. */
const STRICT_HOOKS: readonly HookId[] = [...STANDARD_HOOKS, "core.security", "core.compliance"];

/** Profile → hook id set. Cumulative by construction. */
export const PROFILE_HOOKS: Readonly<Record<HookRuntimeProfile, readonly HookId[]>> = {
  minimal: MINIMAL_HOOKS,
  standard: STANDARD_HOOKS,
  strict: STRICT_HOOKS
};

/**
 * Hard-limit hooks, one per constitution limit (VISION §3). These back the
 * five stop conditions — destruction-without-preservation, unapproved spend,
 * leaked secrets, moral/out-of-scope crossing, ungoverned self-improvement —
 * and can never be disabled by any profile or disable list.
 */
export const DEFAULT_HARD_LIMIT_HOOKS: readonly HookId[] = [
  "hardlimit.no-destruction-without-preservation",
  "hardlimit.no-unapproved-spend",
  "hardlimit.no-leaked-secrets",
  "hardlimit.no-out-of-scope-crossing",
  "hardlimit.no-ungoverned-self-improvement"
];

export const HOOK_RUNTIME_PROFILES: readonly HookRuntimeProfile[] = ["minimal", "standard", "strict"];

export interface ResolveActiveHooksOptions {
  /** Runtime profile selecting the base hook set. Defaults to `"standard"`. */
  readonly profile?: HookRuntimeProfile;
  /** Hook ids requested disabled. Hard-limit ids are unaffected. */
  readonly disabledIds?: readonly HookId[];
  /** Hard-limit hook ids. Defaults to {@link DEFAULT_HARD_LIMIT_HOOKS}. */
  readonly hardLimitIds?: readonly HookId[];
}

export interface ResolveActiveHooksResult {
  /** Active hook ids: profile order, then any protected hard-limit ids. De-duplicated. */
  readonly activeHooks: readonly HookId[];
  /** The profile that was applied. */
  readonly appliedProfile: HookRuntimeProfile;
  /** Disable requests that actually took effect (never includes hard-limit ids). */
  readonly disabledEffective: readonly HookId[];
  /** Hard-limit ids kept active despite a disable request. Empty if none were requested. */
  readonly hardLimitProtected: readonly HookId[];
}

export function isHookRuntimeProfile(value: unknown): value is HookRuntimeProfile {
  return typeof value === "string" && (HOOK_RUNTIME_PROFILES as readonly string[]).includes(value);
}

export function isHardLimitHook(id: HookId, hardLimitIds: readonly HookId[] = DEFAULT_HARD_LIMIT_HOOKS): boolean {
  return hardLimitIds.includes(id);
}

/**
 * Resolve the active hook set for a runtime profile.
 *
 * Order of operations:
 * 1. Base set = `PROFILE_HOOKS[profile]` (default profile `"standard"`).
 * 2. Remove `disabledIds` — except hard-limit ids, which cannot be removed.
 * 3. Union in every hard-limit id (even ones absent from the profile set);
 *    hard-limit hooks are active in every profile, including `minimal`.
 *
 * The result is de-duplicated; disable requests against hard-limit ids are
 * surfaced in `hardLimitProtected` so the refusal is observable.
 */
export function resolveActiveHooks(opts: ResolveActiveHooksOptions = {}): ResolveActiveHooksResult {
  const profile = opts.profile ?? "standard";
  const disabledIds = opts.disabledIds ?? [];
  const hardLimitIds = opts.hardLimitIds ?? DEFAULT_HARD_LIMIT_HOOKS;

  const hardLimitSet = new Set(hardLimitIds);
  const disabledSet = new Set(disabledIds);

  const disabledEffective: HookId[] = [];
  const hardLimitProtected: HookId[] = [];
  for (const id of new Set(disabledIds)) {
    if (hardLimitSet.has(id)) {
      hardLimitProtected.push(id);
    } else {
      disabledEffective.push(id);
    }
  }

  const activeHooks: HookId[] = [];
  const seen = new Set<HookId>();
  const push = (id: HookId): void => {
    if (!seen.has(id)) {
      seen.add(id);
      activeHooks.push(id);
    }
  };

  for (const id of PROFILE_HOOKS[profile]) {
    if (!disabledSet.has(id) || hardLimitSet.has(id)) {
      push(id);
    }
  }
  for (const id of hardLimitIds) {
    push(id);
  }

  return { activeHooks, appliedProfile: profile, disabledEffective, hardLimitProtected };
}

/**
 * Hook Runtime Profile System
 *
 * Selects active hooks based on a runtime profile (minimal|standard|strict).
 * Honors disabled hook ID lists while ensuring hard-limit hooks are never disabled.
 *
 * @module hooks/hookRuntimeProfile
 */

/**
 * Available hook runtime profiles
 */
export type HookProfile = 'minimal' | 'standard' | 'strict';

/**
 * Hook identifier type
 */
export type HookId = string;

/**
 * Profile to hook ID mappings (fixture set)
 *
 * Defines which hooks are active for each profile level.
 * Profiles form a hierarchy: strict ⊇ standard ⊇ minimal
 */
export const PROFILE_HOOKS: Record<HookProfile, readonly HookId[]> = {
  minimal: [
    'core.lifecycle',
    'core.error',
  ],
  standard: [
    'core.lifecycle',
    'core.error',
    'core.metrics',
    'core.audit',
  ],
  strict: [
    'core.lifecycle',
    'core.error',
    'core.metrics',
    'core.audit',
    'core.security',
    'core.compliance',
  ],
} as const;

/**
 * Default hard-limit hook IDs
 *
 * These hooks implement the five constitution hard limits and can never be disabled:
 * 1. No destruction without preservation
 * 2. No unapproved spend
 * 3. No leaked secrets
 * 4. No moral or out-of-scope crossing
 * 5. No ungoverned self-improvement
 */
export const DEFAULT_HARD_LIMIT_HOOKS: readonly HookId[] = [
  'constitution.destruction',
  'constitution.spend',
  'constitution.secrets',
  'constitution.moral',
  'constitution.self-improvement',
] as const;

/**
 * Input parameters for resolveActiveHooks
 */
export interface ResolveActiveHooksInput {
  /** Runtime profile determining base hook set */
  profile: HookProfile;
  /** Hook IDs to disable (hard-limit hooks are protected) */
  disabledIds?: readonly HookId[];
  /** Hard-limit hook IDs that must always remain active */
  hardLimitIds?: readonly HookId[];
}

/**
 * Result of hook resolution
 */
export interface ResolveActiveHooksResult {
  /** Final set of active hook IDs */
  activeHooks: readonly HookId[];
  /** Profile that was applied */
  appliedProfile: HookProfile;
  /** Disabled IDs that were actually removed (excludes hard limits) */
  disabledEffective: readonly HookId[];
  /** Hard-limit hooks that were protected from disable */
  hardLimitProtected: readonly HookId[];
}

/**
 * Resolve the set of active hooks for a given profile and configuration.
 *
 * Algorithm:
 * 1. Start with the hook set defined by the profile
 * 2. Remove any hooks listed in disabledIds
 * 3. Always add back any hooks listed in hardLimitIds (even if in disabledIds)
 * 4. Return the final active set with metadata
 *
 * Invariants:
 * - All hardLimitIds are present in the result (never disabled)
 * - disabledEffective contains only non-hard-limit disabled IDs
 * - Profile hierarchy is preserved: strict hooks ⊇ standard hooks ⊇ minimal hooks
 *
 * @param input Resolution parameters
 * @returns Active hooks and resolution metadata
 */
export function resolveActiveHooks(input: ResolveActiveHooksInput): ResolveActiveHooksResult {
  const {
    profile,
    disabledIds = [],
    hardLimitIds = DEFAULT_HARD_LIMIT_HOOKS,
  } = input;

  // Get the base hook set for this profile
  const profileHooks = [...PROFILE_HOOKS[profile]];

  // Compute which disabled IDs are NOT hard limits (these will actually be removed)
  const disabledEffective = disabledIds.filter((id) => !hardLimitIds.includes(id));

  // Remove effectively disabled hooks from the profile set
  const activeWithoutHardLimits = profileHooks.filter((id) => !disabledEffective.includes(id));

  // Determine which hard-limit hooks need to be added back
  // (either they were in the profile set and got removed, or they're additional hard limits)
  const hardLimitProtected: HookId[] = [];
  for (const hardId of hardLimitIds) {
    if (!activeWithoutHardLimits.includes(hardId)) {
      hardLimitProtected.push(hardId);
    }
  }

  // Final active set: profile hooks (minus disabled) + protected hard limits
  const activeHooks = [...activeWithoutHardLimits, ...hardLimitProtected];

  return {
    activeHooks,
    appliedProfile: profile,
    disabledEffective,
    hardLimitProtected,
  };
}

/**
 * Check if a hook ID is a hard-limit hook
 *
 * @param hookId Hook ID to check
 * @param hardLimitIds Hard limit hook IDs (defaults to DEFAULT_HARD_LIMIT_HOOKS)
 * @returns True if the hook is a hard limit
 */
export function isHardLimitHook(
  hookId: HookId,
  hardLimitIds: readonly HookId[] = DEFAULT_HARD_LIMIT_HOOKS
): boolean {
  return hardLimitIds.includes(hookId);
}

/**
 * Get all hooks for a profile (without applying any disable logic)
 *
 * @param profile Profile to expand
 * @returns All hook IDs for that profile
 */
export function getProfileHooks(profile: HookProfile): readonly HookId[] {
  return PROFILE_HOOKS[profile];
}

/**
 * Verify profile hierarchy relationship
 *
 * @param superset Profile that should contain all hooks of subset
 * @param subset Profile that should be contained within superset
 * @returns True if superset ⊇ subset
 */
export function profileContains(superset: HookProfile, subset: HookProfile): boolean {
  const supersetHooks = new Set(PROFILE_HOOKS[superset]);
  const subsetHooks = PROFILE_HOOKS[subset];

  return subsetHooks.every((id) => supersetHooks.has(id));
}
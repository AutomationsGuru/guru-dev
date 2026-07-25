/**
 * Hook runtime profile pick.
 *
 * Selects which lifecycle hook ids are active for a given runtime profile
 * (`minimal` | `standard` | `strict`) and removes explicitly disabled ids so
 * they never fire. The profiles are cumulative by construction
 * (strict ⊇ standard ⊇ minimal) and mirror the lifecycle event names in
 * `src/extensions/events.ts` in the dash form already used by
 * `src/extensions/shellHooks.ts` (`session-start`, `tool-execute`, …).
 *
 * Hard-limit / constitution enforcement is intentionally NOT handled here —
 * this module is a pure picker over a profile table. Hard-limit hook
 * protection lives in the mandate layer (see src/mandates/) and in the
 * sibling hook-profile resolver owned by other plans; this picker never
 * decides which hooks guard the constitution.
 */

export type HookProfileName = "minimal" | "standard" | "strict";

export type HookProfileTable = Readonly<Record<HookProfileName, readonly string[]>>;

const MINIMAL_HOOKS = ["session-start", "session-end"] as const;

const STANDARD_HOOKS = [
  ...MINIMAL_HOOKS,
  "turn-start",
  "turn-end",
  "tool-execute",
  "tool-result"
] as const;

const STRICT_HOOKS = [
  ...STANDARD_HOOKS,
  "provider-select",
  "model-select",
  "project-trust",
  "input-received",
  "resource-loaded"
] as const;

/**
 * The built-in profile table. Frozen fixture: callers may pass their own
 * table to `resolveProfile` instead of editing this one.
 */
export const HOOK_PROFILES: HookProfileTable = Object.freeze({
  minimal: MINIMAL_HOOKS,
  standard: STANDARD_HOOKS,
  strict: STRICT_HOOKS
});

/**
 * Pick the enabled hook set for `profile` from `hooks`, minus `disabled`.
 *
 * - Returns a fresh array; the caller's table is never mutated.
 * - Disabled ids are removed from the picked set, so a disabled id never
 *   fires even when its profile includes it.
 * - Disabled ids not present in the profile are ignored.
 * - Duplicate ids in the profile table collapse to one entry in the result.
 */
export function resolveProfile(
  hooks: HookProfileTable,
  profile: HookProfileName,
  disabled: readonly string[] = []
): string[] {
  const enabled = hooks[profile];
  const disabledSet = new Set(disabled);
  const picked: string[] = [];
  const seen = new Set<string>();

  for (const id of enabled) {
    if (disabledSet.has(id) || seen.has(id)) continue;
    seen.add(id);
    picked.push(id);
  }

  return picked;
}

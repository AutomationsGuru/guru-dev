import { z } from "zod";

/**
 * Approval profile set — named profiles that map tool classes to auto|ask|deny
 * standing policy. A profile is chosen at session start; every tool call passes
 * through it BEFORE the per-call approval gate.
 *
 * The cardinal rule: deny wins over auto for unknown classes. A tool class not
 * listed in the profile defaults to "deny", not "auto" — fail-closed by design.
 */

export const APPROVAL_PROFILE_MODE_SCHEMA = z.enum(["auto", "ask", "deny"]);
export type ApprovalProfileMode = z.infer<typeof APPROVAL_PROFILE_MODE_SCHEMA>;

export const APPROVAL_PROFILE_SCHEMA = z
  .object({
    /** Human-readable label for the operator. */
    name: z.string().min(1),
    /** Tool class → mode. Keys are tool ids or verb-based classes. */
    rules: z.record(z.string().min(1), APPROVAL_PROFILE_MODE_SCHEMA).default({}),
    /**
     * Fallback for tool classes not listed in rules. Defaults to "deny" so
     * the profile is fail-closed: deny wins over auto for unknown classes.
     * An explicit "auto" here is opt-in looseness that must be deliberate.
     */
    defaultMode: APPROVAL_PROFILE_MODE_SCHEMA.default("deny")
  })
  .strict();

export type ApprovalProfile = z.infer<typeof APPROVAL_PROFILE_SCHEMA>;

/**
 * A named set of profiles — the operator's library of standing policies.
 * Stored at rest under ~/.guruharness/approval-profiles.json (POLICY, not secrets).
 */
export const APPROVAL_PROFILE_SET_SCHEMA = z
  .object({
    profiles: z.record(z.string().min(1), APPROVAL_PROFILE_SCHEMA).default({}),
    /** The profile name active for the current session. */
    active: z.string().min(1).optional()
  })
  .strict();

export type ApprovalProfileSet = z.infer<typeof APPROVAL_PROFILE_SET_SCHEMA>;

/**
 * Resolve a tool class against a profile.
 *
 * Returns the mode for the given tool class — the explicit rule if one exists,
 * otherwise the profile's defaultMode. Because the schema default for defaultMode
 * is "deny", an unlisted class resolves to deny unless the profile creator
 * explicitly chose a looser default.
 *
 * Deny wins over auto for the unknown-class case by construction: the fallback is
 * "deny", not "auto". This is the code enforcement of the cardinal rule.
 */
export function resolve(profile: ApprovalProfile, toolClass: string): ApprovalProfileMode {
  return profile.rules[toolClass] ?? profile.defaultMode;
}

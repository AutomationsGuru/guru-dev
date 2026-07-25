import { z } from "zod";

/**
 * Subagent access policy (IDEA-F148-SUBAGENT-ACCESS-01, 2026-07-19) — a pure
 * allow table for spawn options per
 * handoffs/build-plans/in-progress/2026-07-19T0533Z-idea-f148-subagent-parallel-access-policy-build-plan.md.
 * An EMPTY allow-list means the dimension is unrestricted (backwards-compatible
 * default: the empty policy allows everything); a NON-EMPTY list fails closed —
 * unknown/unlisted tools and models are denied.
 */

export const SubagentAccessPolicySchema = z
  .object({
    /** Tools a spawned subagent may use. Empty = unrestricted. */
    allowedTools: z.array(z.string().trim().min(1)).default([]),
    /** Models a spawned subagent may run on. Empty = unrestricted. */
    allowedModels: z.array(z.string().trim().min(1)).default([])
  })
  .strict();

export type SubagentAccessPolicy = z.infer<typeof SubagentAccessPolicySchema>;

/** A spawn request to check against the policy. Dimensions not named are unchecked. */
export interface SubagentSpawnRequest {
  readonly tool?: string;
  readonly model?: string;
}

/**
 * Why a spawn was denied, or null when allowed. Names the denied dimension and
 * value so callers can surface the reason to the operator.
 */
export function spawnDenialReason(policy: SubagentAccessPolicy, request: SubagentSpawnRequest): string | null {
  if (request.tool !== undefined && policy.allowedTools.length > 0 && !policy.allowedTools.includes(request.tool)) {
    return `tool "${request.tool}" is not in the subagent access policy allow-list`;
  }
  if (request.model !== undefined && policy.allowedModels.length > 0 && !policy.allowedModels.includes(request.model)) {
    return `model "${request.model}" is not in the subagent access policy allow-list`;
  }
  return null;
}

/** True when the spawn request is allowed under the policy. */
export function isSpawnAllowed(policy: SubagentAccessPolicy, request: SubagentSpawnRequest): boolean {
  return spawnDenialReason(policy, request) === null;
}

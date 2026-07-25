import { z } from "zod";

/**
 * Session local-default policy (IDEA-F121-LOCAL-DEFAULT-01).
 *
 * A pure policy module: two flags steer which model lane a session prefers and
 * whether remote/cloud tool use is permitted. Workspace-scoped tools always
 * stay available; remote tools require explicit operator opt-in via
 * `allowRemoteElevate`. When the preferred lane has no candidate the resolver
 * degrades to the other lane instead of stalling the session.
 */

/**
 * The local-default policy flags.
 *
 * - `preferLocalModels` — when true, `resolveModelCandidate` picks the local
 *   candidate over the remote one (default false: legacy direct-first order).
 * - `allowRemoteElevate` — operator opt-in for remote/cloud tool use
 *   (default false: remote tools are denied).
 */
export const LocalDefaultPolicySchema = z
  .object({
    /** Prefer local model candidates over remote ones. */
    preferLocalModels: z.boolean().default(false),
    /** Operator opt-in: allow remote/cloud tool use. */
    allowRemoteElevate: z.boolean().default(false)
  })
  .strict();
export type LocalDefaultPolicy = z.infer<typeof LocalDefaultPolicySchema>;

/** A model candidate offered by one lane (local or remote). */
export interface ModelCandidate {
  readonly modelId: string;
  readonly origin: "local" | "remote";
}

/**
 * The outcome of resolving a model candidate: the chosen candidate (or null
 * when neither lane offers one) plus `degraded`, true when the policy's
 * preferred lane had no candidate and the resolver fell back to the other
 * lane so the session never stalls on a missing local model.
 */
export interface ModelResolution {
  readonly candidate: ModelCandidate | null;
  readonly degraded: boolean;
}

/**
 * Resolve which model candidate a session should use. Prefers the local
 * candidate when `preferLocalModels` is set, the remote candidate otherwise;
 * when the preferred lane has no candidate, degrades to the other lane
 * (flagged via `degraded`) rather than stalling.
 */
export function resolveModelCandidate(
  local: ModelCandidate | null,
  remote: ModelCandidate | null,
  policy: LocalDefaultPolicy
): ModelResolution {
  const preferred = policy.preferLocalModels ? local : remote;
  const fallback = policy.preferLocalModels ? remote : local;
  if (preferred) {
    return { candidate: preferred, degraded: false };
  }
  if (fallback) {
    return { candidate: fallback, degraded: true };
  }
  return { candidate: null, degraded: false };
}

/** A tool's execution scope: workspace-scoped (local) or remote/cloud. */
export interface ToolScopeDescriptor {
  readonly scope: "workspace" | "remote";
}

/**
 * Whether a tool may be used under this policy. Workspace-scoped tools stay
 * available unconditionally; remote/cloud tools require the operator's
 * explicit opt-in via `allowRemoteElevate`.
 */
export function canUseRemoteTool(tool: ToolScopeDescriptor, policy: LocalDefaultPolicy): boolean {
  if (tool.scope === "workspace") {
    return true;
  }
  return policy.allowRemoteElevate;
}

import { z } from "zod";

import { McpServerIdSchema } from "../mcp/schemas.js";

/**
 * Shared capability profile — bind multiple agents to one MCP+skills profile
 * (IDEA-F573-SHARED-01). Pure data; profiles are stored once and resolved by
 * reference so bound agents share one capability set instead of each carrying
 * a divergent copy. Mirrors the codebase's roles-are-DATA stance.
 */

const SLUG_REGEX = /^[a-z][a-z0-9-]{0,62}$/u;

/** Lowercase slug id for a capability profile. */
export const CapabilityProfileIdSchema = z
  .string()
  .trim()
  .regex(SLUG_REGEX, "Expected a lowercase slug (a-z, 0-9, dash; starts with a letter; max 63 chars).");
export type CapabilityProfileId = z.infer<typeof CapabilityProfileIdSchema>;

/** Lowercase slug id for an agent (role slug / worker id). */
export const AgentIdSchema = z
  .string()
  .trim()
  .regex(SLUG_REGEX, "Expected a lowercase slug (a-z, 0-9, dash; starts with a letter; max 63 chars).");
export type AgentId = z.infer<typeof AgentIdSchema>;

export const CapabilityProfileSchema = z
  .object({
    profileId: CapabilityProfileIdSchema,
    label: z.string().trim().min(1).max(120),
    /** Skill ids this profile loads (subset of the discovered catalog). */
    skills: z.array(z.string().trim().min(1)).default([]),
    /** MCP server ids to ATTACH when this profile is active. */
    mcpServers: z.array(McpServerIdSchema).default([]),
    /** Extension groups this profile activates (reserved). */
    extensions: z.array(z.string().trim().min(1)).default([]),
    notes: z.string().max(2000).default("")
  })
  .strict();
export type CapabilityProfile = z.infer<typeof CapabilityProfileSchema>;

/**
 * Plain immutable value object. Profiles are stored once and resolved by
 * reference, so two agents bound to the same profile share one capability set.
 */
export interface SharedCapabilityProfileRegistry {
  readonly profiles: ReadonlyMap<CapabilityProfileId, CapabilityProfile>;
  readonly bindings: ReadonlyMap<AgentId, CapabilityProfileId>;
}

export function createEmptyCapabilityProfileRegistry(): SharedCapabilityProfileRegistry {
  return { profiles: new Map(), bindings: new Map() };
}

/** Raised when a binding references a profileId that is not in the registry. */
export class CapabilityProfileNotFoundError extends Error {
  public readonly code = "capability_profile_not_found";
  constructor(profileId: string) {
    super(`Capability profile not found: ${profileId}`);
    this.name = "CapabilityProfileNotFoundError";
  }
}

/** Reserved for future use; exported so callers can type-check the code path. */
export class AgentNotBoundError extends Error {
  public readonly code = "agent_not_bound";
  constructor(agentId: string) {
    super(`Agent is not bound to any capability profile: ${agentId}`);
    this.name = "AgentNotBoundError";
  }
}

/** Dedupe an array of strings preserving first-seen order. Pure; returns a new array. */
function dedupeFirstSeen(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * Insert-or-replace a profile. Validates via `CapabilityProfileSchema.parse`,
 * then dedupes + freezes the capability arrays so the stored arrays can be
 * shared by reference across bound agents without risk of external mutation.
 */
export function createCapabilityProfile(
  registry: SharedCapabilityProfileRegistry,
  profile: CapabilityProfile
): SharedCapabilityProfileRegistry {
  const parsed = CapabilityProfileSchema.parse(profile);
  const normalized: CapabilityProfile = {
    profileId: parsed.profileId,
    label: parsed.label,
    // Frozen at runtime (shared by reference, immune to external mutation); the
    // schema infers mutable `string[]`, so the frozen readonly arrays are cast
    // back to the stored type. Resolve returns these exact instances.
    skills: Object.freeze(dedupeFirstSeen(parsed.skills)) as string[],
    mcpServers: Object.freeze([...parsed.mcpServers]) as string[],
    extensions: Object.freeze([...parsed.extensions]) as string[],
    notes: parsed.notes
  };

  const profiles = new Map(registry.profiles);
  profiles.set(normalized.profileId, normalized);
  return { profiles, bindings: registry.bindings };
}

/** Bind an agent to a profile. Overwrites any existing binding for that agent. */
export function bindAgentToProfile(
  registry: SharedCapabilityProfileRegistry,
  agentId: AgentId,
  profileId: CapabilityProfileId
): SharedCapabilityProfileRegistry {
  const agent = AgentIdSchema.parse(agentId);
  const profile = CapabilityProfileIdSchema.parse(profileId);

  if (!registry.profiles.has(profile)) {
    throw new CapabilityProfileNotFoundError(profile);
  }

  const bindings = new Map(registry.bindings);
  bindings.set(agent, profile);
  return { profiles: registry.profiles, bindings };
}

/** Remove an agent's binding. Idempotent: no-op if the agent is not bound. */
export function unbindAgent(
  registry: SharedCapabilityProfileRegistry,
  agentId: AgentId
): SharedCapabilityProfileRegistry {
  const agent = AgentIdSchema.parse(agentId);
  if (!registry.bindings.has(agent)) {
    return registry;
  }
  const bindings = new Map(registry.bindings);
  bindings.delete(agent);
  return { profiles: registry.profiles, bindings };
}

export type ResolvedAgentCapability =
  | {
      readonly found: true;
      readonly profile: CapabilityProfile;
      readonly skills: readonly string[];
      readonly mcpServers: readonly string[];
      readonly extensions: readonly string[];
    }
  | { readonly found: false };

/**
 * Resolve an agent's capability profile. Returns the profile's stored arrays
 * BY REFERENCE so two agents bound to the same profile share one capability
 * set. If the agent is unbound OR the bound profileId no longer exists (stale
 * binding), returns `{ found: false }` rather than throwing.
 */
export function resolveAgentCapability(
  registry: SharedCapabilityProfileRegistry,
  agentId: AgentId
): ResolvedAgentCapability {
  const agent = AgentIdSchema.parse(agentId);
  const profileId = registry.bindings.get(agent);
  if (profileId === undefined) {
    return { found: false };
  }
  const profile = registry.profiles.get(profileId);
  if (profile === undefined) {
    return { found: false };
  }
  return {
    found: true,
    profile,
    skills: profile.skills,
    mcpServers: profile.mcpServers,
    extensions: profile.extensions
  };
}

/** Return all agent ids bound to a profile, sorted ascending. Deterministic. */
export function listAgentsForProfile(
  registry: SharedCapabilityProfileRegistry,
  profileId: CapabilityProfileId
): readonly AgentId[] {
  const profile = CapabilityProfileIdSchema.parse(profileId);
  const out: AgentId[] = [];
  for (const [agent, boundProfileId] of registry.bindings) {
    if (boundProfileId === profile) {
      out.push(agent);
    }
  }
  out.sort();
  return out;
}

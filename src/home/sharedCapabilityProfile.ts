import { z } from "zod";

import { McpServerIdSchema } from "../mcp/schemas.js";
import { SkillIdSchema } from "../skills/schemas.js";

/**
 * Pure home-level metadata for an agent loadout shared by multiple agents.
 * Profiles describe capability ids only; they never configure or activate MCPs.
 */
export const SharedCapabilityProfileSchema = z
  .object({
    id: z.string().trim().min(1),
    mcpServers: z.array(McpServerIdSchema).default([]),
    skills: z.array(SkillIdSchema).default([])
  })
  .strict();

export type SharedCapabilityProfile = z.infer<typeof SharedCapabilityProfileSchema>;
export type SharedCapabilityProfileInput = z.input<typeof SharedCapabilityProfileSchema>;

export interface SharedCapabilityProfileStore {
  /** Create a reusable profile from pure MCP and skill identifiers. */
  create(profile: SharedCapabilityProfile | SharedCapabilityProfileInput): SharedCapabilityProfile;
  /** Bind one agent id to an existing shared profile. */
  bind(agentId: string, profileId: string): void;
  /** Resolve the profile currently bound to an agent, if any. */
  resolve(agentId: string): SharedCapabilityProfile | undefined;
}

/**
 * Keep shared-profile ownership in memory until a caller explicitly chooses a
 * persistence layer. Binding changes only this registry, never live MCP state.
 */
export function createSharedCapabilityProfileStore(): SharedCapabilityProfileStore {
  const profiles = new Map<string, SharedCapabilityProfile>();
  const bindings = new Map<string, string>();

  return {
    create(input) {
      const profile = SharedCapabilityProfileSchema.parse(input);
      if (profiles.has(profile.id)) {
        throw new Error(`Duplicate shared capability profile id: ${profile.id}`);
      }

      const sharedProfile = {
        ...profile,
        mcpServers: [...profile.mcpServers],
        skills: [...profile.skills]
      };
      profiles.set(sharedProfile.id, sharedProfile);
      return sharedProfile;
    },
    bind(agentId, profileId) {
      const normalizedAgentId = z.string().trim().min(1).parse(agentId);
      const normalizedProfileId = z.string().trim().min(1).parse(profileId);
      if (!profiles.has(normalizedProfileId)) {
        throw new Error(`Unknown shared capability profile: ${normalizedProfileId}`);
      }

      bindings.set(normalizedAgentId, normalizedProfileId);
    },
    resolve(agentId) {
      const profileId = bindings.get(z.string().trim().min(1).parse(agentId));
      return profileId === undefined ? undefined : profiles.get(profileId);
    }
  };
}

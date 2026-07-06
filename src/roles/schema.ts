import { z } from "zod";

/**
 * Role / suit-up primitive (Phase D, 2026-07-04) — planning/THERE.md §8.
 *
 * A role is DATA: a context-specific loadout assembled at strap-up. There are
 * deliberately NO shipped roles (binding directive #2: roles are dynamic —
 * different every day, every user, every machine; suits EMERGE from work).
 * This module ships the machinery empty.
 *
 * Persistence rides the memory organ: a role parks as a `loadout` memory fact
 * named `role-<slug>` whose body carries the profile JSON — the Garage's v1
 * substrate (Phase E compounds it).
 */

export const RoleSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/u);

/**
 * grok-style capability tiers instead of hand-curated per-tool lists:
 * read-only roles get NO mutating tools regardless of their tool list.
 */
export const RoleCapabilityModeSchema = z.enum(["read-only", "all"]);

export const RoleModelPreferenceSchema = z
  .object({
    routeId: z.string().min(1).optional(),
    /** Capabilities the day's model MUST have (verified against the catalog/probe). */
    requires: z.array(z.enum(["chat", "tools", "vision", "thinking"])).default(["chat", "tools"])
  })
  .strict();

export const RoleProfileSchema = z
  .object({
    slug: RoleSlugSchema,
    label: z.string().trim().min(1).max(80),
    capabilityMode: RoleCapabilityModeSchema.default("all"),
    /**
     * Tools this suit offers the model BEYOND the core floor. Selection only —
     * a role can never bypass the mandate/approval gates; write tools stay
     * write-gated regardless of the loadout.
     */
    tools: z.array(z.string().min(1)).default([]),
    /** Skill ids this suit loads (subset of the discovered catalog). */
    skills: z.array(z.string().min(1)).default([]),
    /** Extension groups this suit wants (reserved; core extensions always load). */
    extensions: z.array(z.string().min(1)).default([]),
    mcpServers: z.array(z.string().min(1)).default([]),
    modelPreference: RoleModelPreferenceSchema.default({ requires: ["chat", "tools"] }),
    /** Tools observed used-and-succeeded while suited — parked by park(), grows per Phase E. */
    verifiedTools: z.array(z.string().min(1)).default([]),
    /** Sessions this suit has been worn (strap-up counter; garage telemetry). */
    wornCount: z.number().int().nonnegative().default(0),
    notes: z.string().max(2000).default("")
  })
  .strict();

export type RoleProfile = z.infer<typeof RoleProfileSchema>;

/** Core tool floor — always present in an "all" suit; read floor in read-only suits. */
export const ROLE_CORE_FLOOR: readonly string[] = ["read", "bash", "edit", "write"];
export const ROLE_READ_ONLY_FLOOR: readonly string[] = ["read"];

/** Derive a role slug from a free-text intake ("we're doing finances today"). */
export function slugifyRole(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/\b(today|we're|we are|working on|doing|let's|lets|on)\b/gu, " ")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40)
    .replace(/^-+|-+$/gu, "");
  const slug = cleaned.length >= 3 ? cleaned : `${cleaned}-role`.replace(/^-+/u, "role-");
  return RoleSlugSchema.parse(slug);
}

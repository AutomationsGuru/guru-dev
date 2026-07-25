import { z } from "zod";

/**
 * Named specialist agents (F88, 2026-07-19) — the config contract for
 * specialist identities spawned by the swarm layer. A specialist is a named,
 * kebab-case identity with a dedicated system prompt and a bounded,
 * allow-listed tool subset. The registry (specialistRegistry.ts) clamps that
 * allow-list against the tools the runner actually offers, so a specialist
 * can never widen what the swarm worker would provide.
 */

export const SpecialistConfigSchema = z
  .object({
    /** Kebab-case identity (e.g. "library-research"). */
    name: z.string().trim().min(1).regex(/^[a-z0-9-]+$/u, "Name must be kebab-case"),
    /** Dedicated system prompt for the specialist worker. */
    systemPrompt: z.string().trim().min(1),
    /** Allow-listed tool ids; intersected against runner-offered tools at spawn. */
    allowedTools: z.array(z.string().trim().min(1)).min(1)
  })
  .strict();

export type SpecialistConfig = z.infer<typeof SpecialistConfigSchema>;

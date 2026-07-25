import { z } from "zod";

/**
 * Agent identity memory (IDEA-F174, 2026-07-19).
 *
 * A durable agent id with named memory blocks (label→text) that survives across
 * sessions and merges into the system context. The constitution's hard-limit
 * rule is enforced structurally here, not in prose: every identity carries a
 * non-empty `hardLimitAnchor` block, and `applyUpdate` rejects any edit that
 * would remove it — so the operator (or a runaway loop) can reshape the agent's
 * identity but can never silently strip the five hard limits out of it. The
 * anchor is the in-identity token of Section 3 of the vision; deleting it is a
 * constitution move, never a routine memory edit.
 *
 * Scope: this is the identity-organ shape, intentionally independent of the L1
 * fact store (`store.ts`). One agent = one identity file; blocks are the agent's
 * self-description (name, role context, persona, constraints), not episodic
 * facts. Serialization is JSON for a clean round-trip (the fact store uses
 * markdown+frontmatter because humans edit those; identity is machine-managed).
 */

/** Block label = filename-safe key (lowercase kebab, mirrors MemoryFactName). */
export const AgentIdentityBlockLabelSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/u, "identity block labels are lowercase kebab-case slugs (2-64 chars)");

/**
 * The constitution anchor — a non-empty block the agent may never lose. The
 * label is fixed (`hard-limit-anchor`) so callers and tests can name it; the
 * text carries the five-limit summary the agent re-reads at boot.
 */
export const HARD_LIMIT_ANCHOR_LABEL = "hard-limit-anchor";

/** Default anchor text — the five hard limits from VISION.md §3, in order. */
export const DEFAULT_HARD_LIMIT_ANCHOR_TEXT = [
  "Five hard limits bind in every mode, resolving before YOLO:",
  "1. No destruction without preservation — back up before any delete/overwrite.",
  "2. No unapproved spend — money never moves without approval or an explicit budget.",
  "3. No leaked secrets — secret values are never read, printed, logged, or persisted.",
  "4. No moral or out-of-scope crossing — stay inside the task's stated boundary.",
  "5. No ungoverned self-improvement — every self-mutation needs validation + review + approval + a done packet."
].join("\n");

/** A single named block of the agent's identity. */
export const AgentIdentityBlockSchema = z
  .object({
    label: AgentIdentityBlockLabelSchema,
    text: z.string().trim().min(1, "identity block text must be non-empty"),
    /** Whether this block is constitution-protected (cannot be removed by applyUpdate). */
    protected: z.boolean().default(false)
  })
  .strict();

export type AgentIdentityBlock = z.infer<typeof AgentIdentityBlockSchema>;

/** The versioned, serializable agent identity record. */
export const AgentIdentitySchema = z
  .object({
    /** Immutable agent id — stable across sessions, unique per agent. */
    agentId: z.string().trim().min(1),
    version: z.literal(1),
    createdAt: z.string().trim().min(1),
    updatedAt: z.string().trim().min(1),
    blocks: z.array(AgentIdentityBlockSchema).default([])
  })
  .strict();

export type AgentIdentity = z.infer<typeof AgentIdentitySchema>;

/** The result of applying an update: either the new identity or a rejection. */
export const AgentIdentityUpdateResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      identity: AgentIdentitySchema
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      /** Machine-readable blocker kinds (mirrors the store's blockers convention). */
      blockers: z.array(z.string().min(1)).min(1),
      summary: z.string().trim().min(1)
    })
    .strict()
]);

export type AgentIdentityUpdateResult = z.infer<typeof AgentIdentityUpdateResultSchema>;

/** Operational input for setting/replacing a block. */
export const AgentIdentityBlockInputSchema = z
  .object({
    label: AgentIdentityBlockLabelSchema,
    text: z.string().trim().min(1),
    protected: z.boolean().optional()
  })
  .strict();

export type AgentIdentityBlockInput = z.infer<typeof AgentIdentityBlockInputSchema>;

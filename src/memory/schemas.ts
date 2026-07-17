import { z } from "zod";

/**
 * Guru memory organ — file-based L1 (Foundation Wave PR 2, 2026-07-04).
 *
 * One fact per markdown file with minimal Obsidian-standard frontmatter, plus a
 * DERIVED MEMORY.md index injected into the system prompt at boot. Design archive:
 * `../../../archive/handoffs-history/vision-corpus/guru-memory-design.md`
 * (role path: `~/.guruharness/roles/<slug>/memory` per ADR 2026-07-05-memory-scopes).
 * Record shape matches operational-store inputs and Honcho remember — L2 Postgres
 * (`provider.ts`) and L3 Honcho (`honcho/`, `syncOnTurn`) replay the same fields;
 * cross-layer `syncUp` writer is not shipped yet (see `../../gaps/README.md` G21).
 */

/** Slug = filename base = [[link]] key (same regex family as operational slugs). */
export const MemoryFactNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/u, "memory fact names are lowercase kebab-case slugs (3-64 chars)");

/**
 * Fact types: the four proven cross-session scopes plus the GARAGE-serving types
 * (capability / loadout / path-outcome, and `learning` — the knowledge flywheel's
 * typed learnings, injected decay-ranked at boot and cited/decayed at park).
 */
export const MemoryFactTypeSchema = z.enum(["user", "feedback", "project", "reference", "capability", "loadout", "path-outcome", "learning"]);

export type MemoryFactType = z.infer<typeof MemoryFactTypeSchema>;

export const MemoryFactSchema = z
  .object({
    name: MemoryFactNameSchema,
    title: z.string().trim().min(1).max(120),
    /** One-line gist — doubles as the retrieval cue on the index line. */
    description: z.string().trim().min(1).max(300),
    type: MemoryFactTypeSchema,
    createdAt: z.string().trim().min(1),
    updatedAt: z.string().trim().min(1),
    confidence: z.number().min(0).max(1).default(1),
    originSessionId: z.string().trim().min(1).optional()
  })
  .strict();

export type MemoryFact = z.infer<typeof MemoryFactSchema>;

/** Live storage readiness — location is safe metadata, never a connection string. */
export const MemoryStoreStatusSchema = z
  .object({
    provider: z.enum(["markdown", "postgres"]),
    status: z.enum(["ready", "missing-env", "offline", "error"]),
    summary: z.string().trim().min(1),
    missingEnvNames: z.array(z.string().trim().min(1)).default([]),
    location: z.string().trim().min(1)
  })
  .strict();
export type MemoryStoreStatus = z.infer<typeof MemoryStoreStatusSchema>;

export const MemoryRememberInputSchema = z
  .object({
    /**
     * Explicit slug: update-in-place when it exists, force-create when it doesn't
     * (passing a name is the "yes, I mean a new fact" confirmation after a
     * similarity blocker). Omit to derive from the title with dedupe-before-save.
     */
    name: MemoryFactNameSchema.optional(),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(300),
    body: z.string().trim().min(1),
    type: MemoryFactTypeSchema.default("project"),
    /** In-place edit mode when the fact already exists. */
    edit: z.enum(["replace", "append"]).default("replace"),
    confidence: z.number().min(0).max(1).default(1)
  })
  .strict();

export type MemoryRememberInput = z.infer<typeof MemoryRememberInputSchema>;

export const MemoryWriteResultSchema = z
  .object({
    status: z.enum(["created", "updated", "blocked", "forgotten"]),
    name: MemoryFactNameSchema.optional(),
    summary: z.string().trim().min(1),
    blockers: z.array(z.string().min(1)).default([])
  })
  .strict();

export type MemoryWriteResult = z.infer<typeof MemoryWriteResultSchema>;

export const MemorySearchInputSchema = z
  .object({
    terms: z.string().trim().min(1),
    type: MemoryFactTypeSchema.optional(),
    limit: z.number().int().positive().max(20).default(6)
  })
  .strict();

export type MemorySearchInput = z.infer<typeof MemorySearchInputSchema>;

export const MemorySearchHitSchema = z
  .object({
    name: MemoryFactNameSchema,
    title: z.string(),
    description: z.string(),
    type: MemoryFactTypeSchema,
    updatedAt: z.string(),
    score: z.number().min(0)
  })
  .strict();

export const MemorySearchResultSchema = z
  .object({
    hits: z.array(MemorySearchHitSchema),
    summary: z.string().trim().min(1)
  })
  .strict();

export type MemorySearchResult = z.infer<typeof MemorySearchResultSchema>;

export const MemoryGetInputSchema = z.object({ name: MemoryFactNameSchema }).strict();

export const MemoryGetResultSchema = z
  .object({
    found: z.boolean(),
    fact: MemoryFactSchema.optional(),
    body: z.string().optional(),
    /** "This memory is N days old..." — computed from updatedAt at read time. */
    stalenessBanner: z.string().optional(),
    links: z.array(z.string()).default([]),
    backlinks: z.array(z.string()).default([]),
    danglingLinks: z.array(z.string()).default([]),
    summary: z.string().trim().min(1)
  })
  .strict();

export type MemoryGetResult = z.infer<typeof MemoryGetResultSchema>;

export const MemoryForgetInputSchema = z
  .object({
    name: MemoryFactNameSchema,
    reason: z.string().trim().min(1).max(300)
  })
  .strict();

export type MemoryForgetInput = z.infer<typeof MemoryForgetInputSchema>;

export const MemoryDoctorReportSchema = z
  .object({
    directory: z.string(),
    factCount: z.number().int().nonnegative(),
    corruptSkipped: z.array(z.string()).default([]),
    orphanTempsRemoved: z.number().int().nonnegative(),
    trashRemoved: z.number().int().nonnegative(),
    danglingLinks: z.array(z.string()).default([]),
    indexRebuilt: z.boolean(),
    summary: z.string().trim().min(1)
  })
  .strict();

export type MemoryDoctorReport = z.infer<typeof MemoryDoctorReportSchema>;

const MemorySyncContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/u, "memory sync hashes must be lowercase SHA-256 hex");

export const MemorySyncSinkStateSchema = z
  .object({
    contentHash: MemorySyncContentHashSchema,
    syncedAt: z.string().datetime()
  })
  .strict();
export type MemorySyncSinkState = z.infer<typeof MemorySyncSinkStateSchema>;

export const MemorySyncFactStateSchema = z
  .object({
    l2: MemorySyncSinkStateSchema.optional(),
    l3: MemorySyncSinkStateSchema.optional()
  })
  .strict();
export type MemorySyncFactState = z.infer<typeof MemorySyncFactStateSchema>;

/** Per-memory-directory upward replay ledger. L2/L3 advance independently. */
export const MemorySyncStateSchema = z
  .object({
    version: z.literal(1),
    facts: z.record(MemoryFactNameSchema, MemorySyncFactStateSchema)
  })
  .strict();
export type MemorySyncState = z.infer<typeof MemorySyncStateSchema>;

export const MemorySyncSinkStatusSchema = z.enum(["not-configured", "unchanged", "deduplicated", "synced", "blocked", "failed"]);
export type MemorySyncSinkStatus = z.infer<typeof MemorySyncSinkStatusSchema>;

export const MemorySyncSinkResultSchema = z
  .object({
    status: MemorySyncSinkStatusSchema,
    summary: z.string().trim().min(1)
  })
  .strict();
export type MemorySyncSinkResult = z.infer<typeof MemorySyncSinkResultSchema>;

export const MemorySyncFactResultSchema = z
  .object({
    name: MemoryFactNameSchema,
    contentHash: MemorySyncContentHashSchema,
    l2: MemorySyncSinkResultSchema,
    l3: MemorySyncSinkResultSchema,
    blockers: z.array(z.string().trim().min(1))
  })
  .strict();
export type MemorySyncFactResult = z.infer<typeof MemorySyncFactResultSchema>;

export const MemorySyncReportSchema = z
  .object({
    status: z.enum(["succeeded", "partial", "blocked"]),
    facts: z.array(MemorySyncFactResultSchema),
    warnings: z.array(z.string().trim().min(1)),
    summary: z.string().trim().min(1)
  })
  .strict();
export type MemorySyncReport = z.infer<typeof MemorySyncReportSchema>;

/** Soft cap mirrors the largest fact in the proven live corpus; hard cap blocks. */
export const MEMORY_BODY_SOFT_CAP = 16 * 1024;
export const MEMORY_BODY_HARD_CAP = 32 * 1024;

/** Derive a valid fact slug from a human title. */
export function slugifyFactName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64)
    .replace(/^-+|-+$/gu, "");
  const padded = slug.length >= 3 ? slug : `${slug}-fact`.replace(/^-+/u, "fact-");
  return MemoryFactNameSchema.parse(padded);
}

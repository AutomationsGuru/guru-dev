import { z } from "zod";

/**
 * Shadow checkpoint types (IDEA-F96-SHADOW-CKPT-01, R-GC-SHADOW).
 *
 * Optional pre-mutation checkpoint taken before write/replace tools: project file
 * bytes live in a profile-scoped side store (never the project's `.git/`), along
 * with a conversation transcript pointer and the pending tool call so restore can
 * re-propose edit/ignore/approve. Composes conceptually with C1 side-snapshot and
 * F62 step-checkpoint without re-porting those modules.
 *
 * The store factory lives in `shadowCheckpointStore.ts`. This file is schemas and
 * public types only - pure, no I/O.
 */

/** Opaque pending tool call re-queued after restore for operator edit/ignore/approve. */
export const PendingToolCallSchema = z
  .object({
    id: z.string().trim().min(1).max(256),
    name: z.string().trim().min(1).max(256),
    /** JSON-serializable tool arguments (object or already-stringified provider args). */
    arguments: z.unknown()
  })
  .strict();
export type PendingToolCall = z.infer<typeof PendingToolCallSchema>;

export const ShadowFileEntrySchema = z
  .object({
    relativePath: z.string().trim().min(1).max(4096),
    /** false = path did not exist at capture (restore must remove it). */
    existed: z.boolean(),
    /** Store-relative payload path under the checkpoint dir; null when !existed. */
    payloadPath: z.string().trim().min(1).max(512).nullable(),
    sizeBytes: z.number().int().nonnegative(),
    mode: z.number().int().nonnegative().nullable(),
    digest: z.string().trim().min(1).max(128).nullable()
  })
  .strict();
export type ShadowFileEntry = z.infer<typeof ShadowFileEntrySchema>;

export const ShadowCheckpointSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().trim().min(1).max(128),
    createdAt: z.string().datetime(),
    label: z.string().trim().min(1).max(256),
    sessionId: z.string().trim().min(1).max(256).nullable(),
    /** Message count at capture - caller rewinds transcript to this length on restore. */
    transcriptMessageCount: z.number().int().nonnegative(),
    pendingToolCall: PendingToolCallSchema.nullable(),
    entries: z.array(ShadowFileEntrySchema).max(10_000),
    skipped: z.array(z.string().trim().min(1).max(4096)).max(10_000),
    restoredAt: z.string().datetime().nullable()
  })
  .strict();
export type ShadowCheckpoint = z.infer<typeof ShadowCheckpointSchema>;

export const ShadowCheckpointSummarySchema = z
  .object({
    id: z.string().trim().min(1),
    label: z.string().trim().min(1),
    createdAt: z.string().datetime(),
    entryCount: z.number().int().nonnegative(),
    skippedCount: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    transcriptMessageCount: z.number().int().nonnegative(),
    hasPendingToolCall: z.boolean(),
    restoredAt: z.string().datetime().nullable()
  })
  .strict();
export type ShadowCheckpointSummary = z.infer<typeof ShadowCheckpointSummarySchema>;

export interface ShadowCheckpointCreateInput {
  readonly paths: readonly string[];
  readonly transcriptMessageCount: number;
  readonly pendingToolCall?: PendingToolCall | null;
  readonly label?: string;
  readonly sessionId?: string | null;
}

export interface ShadowCheckpointCreateResult {
  readonly checkpoint: ShadowCheckpoint;
  readonly summary: ShadowCheckpointSummary;
}

export interface ShadowCheckpointRestoreResult {
  readonly checkpointId: string;
  readonly restored: readonly string[];
  readonly removed: readonly string[];
  readonly skipped: readonly string[];
  /** Operator re-queues this for edit/ignore/approve. */
  readonly pendingToolCall: PendingToolCall | null;
  /** Caller rewinds session transcript to this message count. */
  readonly transcriptMessageCount: number;
  readonly label: string;
}

export interface ShadowCheckpointLimits {
  readonly maxFileBytes: number;
  readonly maxCheckpointBytes: number;
  readonly maxCheckpoints: number;
}

export const DEFAULT_SHADOW_CHECKPOINT_LIMITS: ShadowCheckpointLimits = {
  maxFileBytes: 1024 * 1024,
  maxCheckpointBytes: 16 * 1024 * 1024,
  maxCheckpoints: 32
};

export interface ShadowCheckpointStoreOptions {
  readonly workspaceRoot: string;
  /**
   * Profile-scoped side store root (e.g. ~/.guruharness/shadow-checkpoints/<project-key>).
   * NEVER the project's `.git` directory.
   */
  readonly storeRoot: string;
  /** Default false until stable - disabled path must no-op. */
  readonly enabled?: boolean;
  readonly limits?: ShadowCheckpointLimits;
}

export interface ShadowCheckpointStore {
  readonly enabled: boolean;
  create(input: ShadowCheckpointCreateInput): Promise<ShadowCheckpointCreateResult | null>;
  list(): Promise<readonly ShadowCheckpointSummary[]>;
  get(id: string): Promise<ShadowCheckpoint | null>;
  restore(id: string): Promise<ShadowCheckpointRestoreResult | null>;
}

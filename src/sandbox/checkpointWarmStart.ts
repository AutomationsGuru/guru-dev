import { z } from "zod";

// ── Status ───────────────────────────────────────────────────────────────────

/**
 * Lifecycle status for a spawned sandbox box. A freshly spawned box begins in
 * `created`; lifecycle transitions are owned by the sandbox box-lifecycle layer.
 */
export const SandboxBoxStatusSchema = z.enum(["created", "running", "stopped", "destroyed"]);
export type SandboxBoxStatus = z.infer<typeof SandboxBoxStatusSchema>;

// ── Checkpoint record ────────────────────────────────────────────────────────

const CheckpointIdSchema = z.string().trim().min(1).max(256);

/**
 * A sandbox checkpoint — a named snapshot a new box can share as its base. A
 * root checkpoint has no parent; a derived checkpoint records its lineage via
 * `parentId` so a warm-start chain stays observable.
 */
export const CheckpointRecordSchema = z
  .object({
    id: CheckpointIdSchema,
    parentId: CheckpointIdSchema.nullable(),
  })
  .strict();
export type CheckpointRecord = z.infer<typeof CheckpointRecordSchema>;

// ── Spawned box record ───────────────────────────────────────────────────────

/**
 * A sandbox box spawned from a checkpoint. `checkpointId` is the snapshot the
 * box shares as its base — the warm-start link.
 */
export const SandboxBoxRecordSchema = z
  .object({
    id: z.string().trim().min(1).max(256),
    status: SandboxBoxStatusSchema,
    checkpointId: CheckpointIdSchema,
  })
  .strict();
export type SandboxBoxRecord = z.infer<typeof SandboxBoxRecordSchema>;

// ── Registries ───────────────────────────────────────────────────────────────

/** In-memory checkpoint registry — a plain Map keyed by checkpoint id. */
export type SandboxCheckpointRegistry = Map<string, CheckpointRecord>;

/** In-memory sandbox box registry — a plain Map keyed by box id. */
export type SandboxRegistry = Map<string, SandboxBoxRecord>;

/**
 * A fresh pair of registries for a warm-start-capable sandbox: checkpoints hold
 * snapshots, boxes reference one. Returns the two registries a caller threads
 * into `createCheckpoint` / `spawnFromCheckpoint`.
 */
export function createRegistries(): {
  checkpoints: SandboxCheckpointRegistry;
  boxes: SandboxRegistry;
} {
  return { checkpoints: new Map(), boxes: new Map() };
}

// ── Error ────────────────────────────────────────────────────────────────────

export class CheckpointWarmStartError extends Error {
  public readonly subjectId: string;
  public readonly attempted: string;
  public readonly reason: string;

  constructor(subjectId: string, attempted: string, reason: string) {
    super(`Checkpoint warm-start "${subjectId}": cannot ${attempted} — ${reason}`);
    this.name = "CheckpointWarmStartError";
    this.subjectId = subjectId;
    this.attempted = attempted;
    this.reason = reason;
  }
}

// ── Options ──────────────────────────────────────────────────────────────────

export interface CreateCheckpointOptions {
  readonly parentId?: string;
}

// ── Pure APIs ────────────────────────────────────────────────────────────────

/**
 * Record a checkpoint. With no `parentId` it is a root snapshot; otherwise the
 * parent must already exist so the lineage stays grounded. Rejects empty or
 * duplicate ids.
 */
export function createCheckpoint(
  registry: SandboxCheckpointRegistry,
  id: string,
  options?: CreateCheckpointOptions,
): CheckpointRecord {
  const trimmedId = CheckpointIdSchema.safeParse(id);
  if (!trimmedId.success) {
    throw new CheckpointWarmStartError(id, "create", "checkpoint id must be a non-empty string");
  }
  const safeId = trimmedId.data;
  if (registry.has(safeId)) {
    throw new CheckpointWarmStartError(safeId, "create", "checkpoint id already exists");
  }

  let parentId: string | null = null;
  if (options?.parentId !== undefined) {
    const trimmedParent = CheckpointIdSchema.safeParse(options.parentId);
    if (!trimmedParent.success) {
      throw new CheckpointWarmStartError(
        options.parentId,
        "create",
        "parent checkpoint id must be a non-empty string",
      );
    }
    parentId = trimmedParent.data;
    if (!registry.has(parentId)) {
      throw new CheckpointWarmStartError(
        parentId,
        "create",
        "parent checkpoint does not exist",
      );
    }
  }

  const record: CheckpointRecord = { id: safeId, parentId };
  registry.set(safeId, record);
  return record;
}

/**
 * Spawn a new sandbox box in `created` status that shares `checkpointId` as its
 * base snapshot. Rejects unknown checkpoints and reused box ids.
 */
export function spawnFromCheckpoint(
  boxes: SandboxRegistry,
  checkpoints: SandboxCheckpointRegistry,
  checkpointId: string,
  boxId: string,
): SandboxBoxRecord {
  const trimmedCheckpoint = CheckpointIdSchema.safeParse(checkpointId);
  if (!trimmedCheckpoint.success) {
    throw new CheckpointWarmStartError(
      checkpointId,
      "spawn",
      "checkpoint id must be a non-empty string",
    );
  }
  const safeCheckpointId = trimmedCheckpoint.data;
  if (!checkpoints.has(safeCheckpointId)) {
    throw new CheckpointWarmStartError(
      safeCheckpointId,
      "spawn",
      "checkpoint does not exist",
    );
  }

  const trimmedBox = z.string().trim().min(1).max(256).safeParse(boxId);
  if (!trimmedBox.success) {
    throw new CheckpointWarmStartError(boxId, "spawn", "box id must be a non-empty string");
  }
  const safeBoxId = trimmedBox.data;
  if (boxes.has(safeBoxId)) {
    throw new CheckpointWarmStartError(safeBoxId, "spawn", "box id already exists");
  }

  const record: SandboxBoxRecord = {
    id: safeBoxId,
    status: "created",
    checkpointId: safeCheckpointId,
  };
  boxes.set(safeBoxId, record);
  return record;
}

// ── Lookup ───────────────────────────────────────────────────────────────────

export function getCheckpoint(
  registry: SandboxCheckpointRegistry,
  id: string,
): CheckpointRecord | undefined {
  return registry.get(id);
}

export function getBox(
  registry: SandboxRegistry,
  id: string,
): SandboxBoxRecord | undefined {
  return registry.get(id);
}

export function listCheckpoints(
  registry: SandboxCheckpointRegistry,
): CheckpointRecord[] {
  return [...registry.values()];
}

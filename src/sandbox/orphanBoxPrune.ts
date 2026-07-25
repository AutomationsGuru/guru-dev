export type SandboxBoxStatus = "created" | "running" | "stopped" | "destroyed";

export interface SandboxBoxRecord {
  readonly id: string;
  readonly status: SandboxBoxStatus;
  /** Epoch milliseconds when the box was destroyed, retained for audit visibility. */
  readonly destroyedAt?: number;
}

export interface OrphanBoxPruneOptions {
  readonly now: number;
  readonly retainMs: number;
}

/**
 * Keeps active records and recent destroyed records. A destroyed record without
 * a timestamp is retained because its age cannot be proven safely.
 */
export function prune(records: readonly SandboxBoxRecord[], options: OrphanBoxPruneOptions): SandboxBoxRecord[] {
  const cutoff = options.now - options.retainMs;
  return records.filter((record) => record.status !== "destroyed" || record.destroyedAt === undefined || record.destroyedAt >= cutoff);
}

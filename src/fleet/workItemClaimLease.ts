import { randomUUID } from "node:crypto";

import { z } from "zod";

/**
 * Work-item claim lease (F310 / R-TT-CLAIM) — a fleet coordination primitive
 * giving exactly one owner the exclusive right to advance a work item for a
 * bounded lease window. The lease is acquired, kept alive by heartbeats, and
 * released. A second acquire while a lease is live **fails closed** (returns
 * null / throws depending on the call) so two workers can never believe they
 * both own the same item. An expired lease is reclaimable by anyone, including
 * its former owner.
 *
 * Design notes (vision §1: independent, lightweight, no borrowed framework):
 * - `zod` is the only runtime dependency, matching the rest of the harness.
 * - Time and id generation are INJECTED so tests can drive expiry/reclaim
 *   deterministically without sleeping. The default clock reads wall time.
 * - There is no storage backend wired here on purpose — a `WorkItemLeaseStore`
 *   is injected. The in-memory store is the default and is what fleet
 *   coordination uses until a real backing store is ATTACHed (tracked, gated,
 *   replaceable). The lease logic itself is backend-agnostic and owns none.
 * - Hard caps live in the schema: a bad config cannot create an unbounded or
 *   zero-length lease that would wedge a work item forever or churn it.
 */

/** Hard-capped lease configuration. Defaults are safe; misconfiguration throws. */
export const WorkItemLeaseConfigSchema = z
  .object({
    /** Lease time-to-live in ms. Must be positive and bounded so a forgotten
     *  lease cannot hold a work item hostage indefinitely. */
    leaseTtlMs: z.number().int().positive().max(60_000).default(30_000),
    /** Floor on the effective TTL after a heartbeat. A heartbeat can never
     *  shrink the remaining TTL below this — it only extends toward the full
     *  TTL. Prevents a buggy caller from racing a lease to expiry. */
    minLeaseTtlMs: z.number().int().positive().max(60_000).default(5_000),
    /** Heartbeat may extend the TTL up to this multiple of the base TTL in one
     *  call, so a single heartbeat cannot grant an unbounded extension. */
    maxHeartbeatExtensionMultiplier: z.number().int().min(1).max(4).default(1)
  })
  .strict()
  .refine((cfg) => cfg.minLeaseTtlMs <= cfg.leaseTtlMs, {
    message: "minLeaseTtlMs must not exceed leaseTtlMs",
    path: ["minLeaseTtlMs"]
  });

export type WorkItemLeaseConfig = z.infer<typeof WorkItemLeaseConfigSchema>;

/** A live or lapsed lease record. `ownerId` is opaque to the lease (a worker id). */
export interface WorkItemLease {
  readonly workItemId: string;
  readonly ownerId: string;
  /** Monotonic-ish epoch ms (from the injected clock) when the lease was first acquired. */
  readonly acquiredAt: number;
  /** Epoch ms when the lease lapses unless refreshed or released. */
  expiresAt: number;
  /** Last heartbeat time (acquiredAt until the first heartbeat). */
  heartbeatedAt: number;
  /** Release count over this work-item id's lifetime (informational). */
  releaseCount: number;
  state: WorkItemLeaseState;
}

export const WorkItemLeaseStateSchema = z.enum(["active", "released", "expired"]);
export type WorkItemLeaseState = z.infer<typeof WorkItemLeaseStateSchema>;

/** Result of an acquire attempt. A live competing lease → `outcome: "denied"`. */
export interface WorkItemAcquireResult {
  readonly outcome: "acquired" | "denied";
  readonly lease?: WorkItemLease;
  /** Present when denied — the owner that currently holds (or held) the lease. */
  readonly conflictingOwnerId?: string;
  readonly conflictingExpiresAt?: number;
}

/** Injected clock — defaults to wall time. Tests pass a controlled clock. */
export type WorkItemLeaseClock = () => number;

/** Injected id generator for owners that don't supply one. Defaults to UUIDv4. */
export type WorkItemLeaseOwnerIdProvider = () => string;

/**
 * Backend-agnostic lease store. The default in-memory implementation lives
 * below; a real backing store (PostgreSQL `SELECT ... FOR UPDATE` SKIP LOCKED,
 * Redis SET NX EX, etc.) is an explicit ATTACH that implements this interface
 * — never a silent runtime foundation of the lease logic.
 */
export interface WorkItemLeaseStore {
  /** Return the current record for a work item, or undefined if none ever existed. */
  get(workItemId: string): WorkItemLease | undefined;
  /** Insert or fully overwrite the record for a work item. */
  upsert(lease: WorkItemLease): void;
  /** Remove the record entirely (used when a lease is released and the slot is recycled). */
  delete(workItemId: string): void;
}

/** In-memory lease store. Process-local; sufficient for single-process fleet coordination. */
export function createInMemoryWorkItemLeaseStore(): WorkItemLeaseStore {
  const records = new Map<string, WorkItemLease>();
  return {
    get: (workItemId) => records.get(workItemId),
    upsert: (lease) => {
      records.set(lease.workItemId, { ...lease });
    },
    delete: (workItemId) => {
      records.delete(workItemId);
    }
  };
}

export interface WorkItemClaimLeaseOptions {
  /** Partial config; defaults and caps are applied by the schema. */
  readonly config?: Partial<WorkItemLeaseConfig>;
  readonly store?: WorkItemLeaseStore;
  /** Injected clock (defaults to wall time). */
  readonly now?: WorkItemLeaseClock;
  /** Injected owner-id provider for acquires that omit an explicit ownerId. */
  readonly generateOwnerId?: WorkItemLeaseOwnerIdProvider;
}

export interface WorkItemClaimLease {
  readonly config: WorkItemLeaseConfig;
  /** Inspect the current lease for an item without mutating it. */
  inspect(workItemId: string): WorkItemLease | undefined;
  /**
   * Acquire (or reclaim) the lease. Fails closed — `outcome: "denied"` — when a
   * live lease is held by a different owner. The same owner re-acquiring an
   * active lease is treated as a no-op heartbeat and returns `acquired`.
   */
  acquire(
    workItemId: string,
    ownerId?: string,
    options?: { readonly throwOnDenied?: boolean }
  ): WorkItemAcquireResult;
  /** Refresh the lease TTL for the current owner. No-op (returns false) if the caller is not the owner or the lease is gone. */
  heartbeat(workItemId: string, ownerId?: string): boolean;
  /** Release the lease. Only the current owner may release. Returns false if the caller does not own a live lease. */
  release(workItemId: string, ownerId?: string): boolean;
}

/**
 * Create a work-item claim lease. The lease enforces exclusivity in logic; a
 * backing store may add cross-process durability when one is ATTACHed. Until
 * then this is single-process coordination, honestly so.
 */
export function createWorkItemClaimLease(
  options: WorkItemClaimLeaseOptions = {}
): WorkItemClaimLease {
  const config = WorkItemLeaseConfigSchema.parse(options.config ?? {});
  const store = options.store ?? createInMemoryWorkItemLeaseStore();
  const now: WorkItemLeaseClock = options.now ?? (() => Date.now());
  const generateOwnerId: WorkItemLeaseOwnerIdProvider = options.generateOwnerId ?? (() => randomUUID());

  const resolveOwner = (ownerId?: string): string => ownerId ?? generateOwnerId();

  /**
   * Reconcile a stored record against the clock. If its TTL has elapsed it is
   * flipped to `expired` in place so subsequent acquires may reclaim it. Returns
   * whether the record is currently live (active and not past expiry).
   */
  const reconcile = (record: WorkItemLease): boolean => {
    const t = now();
    if (record.state === "active" && record.expiresAt <= t) {
      record.state = "expired";
      return false;
    }
    return record.state === "active";
  };

  const acquire: WorkItemClaimLease["acquire"] = (workItemId, ownerId, callOptions = {}) => {
    const owner = resolveOwner(ownerId);
    const t = now();
    const existing = store.get(workItemId);
    if (existing) {
      const live = reconcile(existing);
      if (live && existing.ownerId !== owner) {
        // Fail closed: a different owner holds a live lease.
        const denied: WorkItemAcquireResult = {
          outcome: "denied",
          conflictingOwnerId: existing.ownerId,
          conflictingExpiresAt: existing.expiresAt
        };
        if (callOptions.throwOnDenied) {
          throw new WorkItemLeaseDeniedError(workItemId, existing.ownerId, existing.expiresAt);
        }
        store.upsert(existing); // persist the expired/active state reconciliation
        return denied;
      }
      // Either the same owner re-acquiring an active lease (a refresh), or a
      // lapsed lease being reclaimed by a new owner. Rebuild the record so the
      // ownerId reflects the claimant and acquiredAt resets on a true reclaim.
      const baseTtl = Math.max(config.leaseTtlMs, config.minLeaseTtlMs);
      const reclaimed = existing.state === "expired" || existing.ownerId !== owner;
      const refreshed: WorkItemLease = {
        workItemId: existing.workItemId,
        ownerId: owner,
        acquiredAt: reclaimed ? t : existing.acquiredAt,
        expiresAt: t + baseTtl,
        heartbeatedAt: t,
        releaseCount: existing.releaseCount,
        state: "active"
      };
      store.upsert(refreshed);
      return { outcome: "acquired", lease: refreshed };
    }
    const baseTtl = Math.max(config.leaseTtlMs, config.minLeaseTtlMs);
    const lease: WorkItemLease = {
      workItemId,
      ownerId: owner,
      acquiredAt: t,
      expiresAt: t + baseTtl,
      heartbeatedAt: t,
      releaseCount: 0,
      state: "active"
    };
    store.upsert(lease);
    return { outcome: "acquired", lease };
  };

  const heartbeat: WorkItemClaimLease["heartbeat"] = (workItemId, ownerId) => {
    const owner = resolveOwner(ownerId);
    const record = store.get(workItemId);
    if (!record) return false;
    const live = reconcile(record);
    if (!live || record.ownerId !== owner) return false;
    const t = now();
    const extensionCap = config.leaseTtlMs * config.maxHeartbeatExtensionMultiplier;
    const fullExpiry = t + config.leaseTtlMs;
    const cappedExpiry = Math.min(fullExpiry, t + extensionCap);
    // Never shrink below the floor of (current expiry, minLeaseTtlMs from now).
    const floor = Math.max(record.expiresAt, t + config.minLeaseTtlMs);
    record.expiresAt = Math.max(cappedExpiry, floor);
    record.heartbeatedAt = t;
    record.state = "active";
    store.upsert(record);
    return true;
  };

  const release: WorkItemClaimLease["release"] = (workItemId, ownerId) => {
    const owner = resolveOwner(ownerId);
    const record = store.get(workItemId);
    if (!record) return false;
    reconcile(record);
    if (record.ownerId !== owner) return false;
    record.state = "released";
    record.releaseCount += 1;
    store.upsert(record);
    // A released slot is reclaimable immediately; drop it so a fresh acquire is clean.
    store.delete(workItemId);
    return true;
  };

  return {
    config,
    inspect: (workItemId) => {
      const record = store.get(workItemId);
      if (record) reconcile(record);
      return record;
    },
    acquire,
    heartbeat,
    release
  };
}

/** Structured error thrown by `acquire(..., { throwOnDenied: true })` on a denied claim. */
export class WorkItemLeaseDeniedError extends Error {
  readonly code = "work_item_lease_denied";
  constructor(
    readonly workItemId: string,
    readonly conflictingOwnerId: string,
    readonly conflictingExpiresAt: number
  ) {
    super(
      `Work item ${workItemId} is held by owner ${conflictingOwnerId} until ${conflictingExpiresAt}.`
    );
    this.name = "WorkItemLeaseDeniedError";
  }
}

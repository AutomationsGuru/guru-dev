/**
 * Provider health probe cache.
 *
 * Lightweight, in-memory, per-provider health record used by the route ranker:
 * the ranker may deprioritize (not hard-exclude) a provider whose last probe
 * came back `degraded`, and treats providers with no fresh probe as `unknown`.
 *
 * Design contract (see handoffs build-plan IDEA-F57-PROVIDER-HEALTH-01):
 *
 * - Status is one of `ok | degraded | unknown`. `unknown` is the safe default —
 *   a provider we have no fresh evidence about is neither healthy nor unhealthy.
 * - TTL expiry downgrades the effective status to `unknown`. The last-known
 *   record is retained so the ranker can *fail open* to it (prefer a stale-ok
 *   route over crashing the loop) instead of hard-failing.
 * - **No fake success.** `ok` is only ever recorded from a probe that actually
 *   ran and returned a real response. Recording an `ok` without `verified: true`
 *   throws, and any recorded cost must be a real, finite, non-negative number
 *   observed by the probe — never synthesized. The harness never invents a cost
 *   or a success it did not observe (hard limit §3.2: unknown cost is not free).
 *
 * This module owns no I/O and no third-party dependency; it is pure state with
 * an injectable clock so TTL behaviour is deterministic under test.
 */

/** Effective health verdict for a provider. */
export type ProviderHealthStatus = "ok" | "degraded" | "unknown";

/** A single recorded probe outcome. */
export interface ProviderHealthRecord {
  readonly providerId: string;
  readonly status: Exclude<ProviderHealthStatus, "unknown">;
  /** Epoch millis the probe was recorded at. */
  readonly recordedAt: number;
  /** Observed cost in USD for the probe, if the probe reported one. Never synthesized. */
  readonly costUsd?: number;
  /** Free-form note (e.g. observed latency band or error class). Not a secret. */
  readonly note?: string;
}

/** Snapshot returned by {@link getStatus}. */
export interface ProviderHealthSnapshot {
  readonly providerId: string;
  /** Effective status after TTL. `unknown` when absent or expired. */
  readonly status: ProviderHealthStatus;
  /** Whether the underlying record is still within TTL. */
  readonly fresh: boolean;
  /** Last-known record, retained across expiry so callers can fail open. */
  readonly lastKnown?: ProviderHealthRecord;
}

/** Input accepted by {@link recordProbe}. */
export interface ProviderProbeInput {
  readonly status: Exclude<ProviderHealthStatus, "unknown">;
  /**
   * True only when a real probe ran and returned a genuine response. Required
   * for `ok`; forbidden from being absent when claiming success. This is the
   * structural guard against fabricated health.
   */
  readonly verified?: boolean;
  /** Epoch millis; defaults to the store's clock. */
  readonly at?: number;
  readonly costUsd?: number;
  readonly note?: string;
}

export interface ProviderHealthStoreOptions {
  /** TTL in millis before a record is treated as stale (`unknown`). */
  readonly ttlMs?: number;
  /** Injectable clock; defaults to `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_TTL_MS = 60_000;

/**
 * In-memory provider health cache. Create one per process/ranker and share it;
 * the store is intentionally simple — a `Map` keyed by provider id.
 */
export class ProviderHealthStore {
  private readonly records = new Map<string, ProviderHealthRecord>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: ProviderHealthStoreOptions = {}) {
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new Error(`ProviderHealthStore: ttlMs must be a finite non-negative number (got ${ttlMs}).`);
    }
    this.ttlMs = ttlMs;
    this.now = options.now ?? Date.now;
  }

  /**
   * Record a probe outcome for a provider.
   *
   * Throws if a caller attempts to record `ok` without `verified: true`, or
   * with an invented/non-finite/negative cost — the harness never fabricates
   * success or cost.
   */
  recordProbe(providerId: string, input: ProviderProbeInput): ProviderHealthRecord {
    if (!providerId || typeof providerId !== "string") {
      throw new Error("ProviderHealthStore.recordProbe: providerId is required.");
    }
    if (input.status !== "ok" && input.status !== "degraded") {
      throw new Error(`ProviderHealthStore.recordProbe: status must be "ok" or "degraded" (got ${String(input.status)}).`);
    }
    if (input.status === "ok" && input.verified !== true) {
      throw new Error('ProviderHealthStore.recordProbe: status "ok" requires verified:true — never invent success.');
    }
    if (input.costUsd !== undefined) {
      if (!Number.isFinite(input.costUsd) || input.costUsd < 0) {
        throw new Error(`ProviderHealthStore.recordProbe: costUsd must be a finite non-negative number (got ${String(input.costUsd)}).`);
      }
    }

    const record: ProviderHealthRecord = {
      providerId,
      status: input.status,
      recordedAt: input.at ?? this.now(),
      ...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
      ...(input.note !== undefined ? { note: input.note } : {})
    };
    this.records.set(providerId, record);
    return record;
  }

  /**
   * Effective health for a provider after TTL. Returns `unknown` when there is
   * no record or the record has expired; the stale record is still exposed via
   * `lastKnown` so the ranker can fail open rather than dead-end.
   */
  getStatus(providerId: string): ProviderHealthSnapshot {
    const lastKnown = this.records.get(providerId);
    if (!lastKnown) {
      return { providerId, status: "unknown", fresh: false };
    }
    const fresh = this.now() - lastKnown.recordedAt < this.ttlMs;
    return {
      providerId,
      status: fresh ? lastKnown.status : "unknown",
      fresh,
      lastKnown
    };
  }

  /** Drop all records (e.g. between sessions). */
  clear(): void {
    this.records.clear();
  }
}

/** Convenience: a process-wide default store used by the route ranker. */
let defaultStore: ProviderHealthStore | undefined;

export function getDefaultProviderHealthStore(): ProviderHealthStore {
  if (!defaultStore) {
    defaultStore = new ProviderHealthStore();
  }
  return defaultStore;
}

/**
 * Test-only escape hatch to reset the process-wide default. Exported for
 * deterministic tests; not intended for product call sites.
 */
export function __resetDefaultProviderHealthStoreForTests(): void {
  defaultStore = undefined;
}

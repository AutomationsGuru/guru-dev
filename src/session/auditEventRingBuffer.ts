/**
 * AuditEventRingBuffer — a bounded, in-memory ring buffer of audit events.
 *
 * One of the audit primitives behind the session layer (IDEA-F427-AUDIT-01,
 * R-AURA-AUDIT). It captures a rolling window of the most recent audit events
 * so an operator can inspect "what just happened" without keeping an unbounded
 * history in memory.
 *
 * HARD LIMITS (enforced structurally, in code — never weakened by a caller):
 *
 * - **Bounded.** Capacity is fixed at construction and clamped to a positive
 *   integer; it can never be raised above the configured ceiling and is never
 *   bypassed. When the buffer is full, appends drop the *oldest* entry — the
 *   bound holds in every mode.
 * - **In-memory only.** No disk, no network, no SSE, no logging side channel.
 *   The buffer is process-local and never persists.
 * - **No secret-bearing payload expansion.** Events carry an opaque, caller-
 *   chosen `kind`, a monotonic sequence number, a wall-clock timestamp, and a
 *   caller-supplied `detail`. The buffer treats `detail` as an opaque reference
 *   it never inspects, serializes for transport, or expands — so a caller may
 *   store a safe summary or handle without risking value exposure. This is a
 *   structural secret-hygiene guard, not a prompt rule.
 *
 * The buffer is deliberately tiny and dependency-free: it is a primitive, not a
 * transport, and it registers no capability through the extension seam.
 */

/** A single captured audit event. `detail` is opaque to the buffer. */
export interface AuditEvent<D = unknown> {
  /** Monotonic, gapless sequence number assigned at append time (starts at 1). */
  readonly seq: number;
  /** Wall-clock millis when appended (caller-independent `Date.now()` at push). */
  readonly at: number;
  /** Caller-chosen event kind (e.g. "tool.denied"). */
  readonly kind: string;
  /** Opaque per-event detail; never inspected, serialized for transport, or expanded. */
  readonly detail: D;
}

/** A live, bounded, in-memory ring buffer of audit events. */
export interface AuditEventRingBuffer<D = unknown> {
  /** Maximum number of events retained. Always a positive integer; never weakens. */
  readonly capacity: number;
  /** Current number of retained events (0..capacity). */
  readonly size: number;
  /** Total events ever appended (monotonic; >= size once eviction has occurred). */
  readonly appended: number;
  /** Append an event; returns its assigned sequence number. Drops oldest if full. */
  append(kind: string, detail: D): number;
  /** List the most recent events, oldest-first. `limit` clamps to [0, size]. */
  list(limit?: number): readonly AuditEvent<D>[];
  /** Drop every retained event. Sequence numbering continues (does not reset). */
  clear(): void;
}

/**
 * Absolute ceiling on capacity. Capacity passed to {@link createAuditEventRingBuffer}
 * is clamped to [1, MAX_CAPACITY]; a caller can never raise the bound past this.
 * Sized for a rolling operational window, not a durable store.
 */
export const AUDIT_RING_BUFFER_MAX_CAPACITY = 10_000;

/**
 * Create a bounded in-memory audit-event ring buffer.
 *
 * @param capacity Desired capacity; clamped to the inclusive range
 *   [1, {@link AUDIT_RING_BUFFER_MAX_CAPACITY}]. Non-finite / non-integer /
 *   out-of-range values fall back to the default rather than weakening the bound
 *   or throwing — the buffer is always valid and always bounded.
 * @param now Optional clock injector for deterministic tests; defaults to
 *   `Date.now`. Never exposed beyond this buffer.
 */
export function createAuditEventRingBuffer<D = unknown>(
  capacity: number = 256,
  now: () => number = Date.now
): AuditEventRingBuffer<D> {
  // Clamp the bound structurally: always a positive integer, never above the
  // ceiling, never NaN/Infinity. A bad input yields a valid bounded buffer
  // rather than an unbounded one — the hard limit cannot be dodged by a caller.
  const cap = Number.isFinite(capacity) && Number.isInteger(capacity) && capacity >= 1
    ? Math.min(capacity, AUDIT_RING_BUFFER_MAX_CAPACITY)
    : 256;

  // Backing store sized exactly to capacity; filled ring-style. `start` is the
  // index of the oldest live entry once the ring has wrapped.
  const ring: (AuditEvent<D> | undefined)[] = new Array(cap).fill(undefined);
  let start = 0; // index of oldest entry (meaningful once `appended > cap`)
  let size = 0; // live count, 0..cap
  let appended = 0; // monotonic total ever appended
  let seq = 0; // last assigned sequence number

  const api: AuditEventRingBuffer<D> = {
    get capacity() {
      return cap;
    },
    get size() {
      return size;
    },
    get appended() {
      return appended;
    },
    append(kind, detail) {
      const event: AuditEvent<D> = {
        seq: (seq += 1),
        at: now(),
        kind,
        // Store the opaque reference as-is; never copy/expand/serialize it. This
        // is the structural secret-hygiene guard: a caller may pass a safe
        // summary or handle, and the buffer cannot leak its contents because it
        // never reads them.
        detail
      };

      if (size < cap) {
        // Still filling the first lap: write to the next free slot.
        ring[(start + size) % cap] = event;
        size += 1;
      } else {
        // Ring full: overwrite the oldest entry in place and advance `start`,
        // evicting it. The capacity bound is preserved exactly.
        ring[start] = event;
        start = (start + 1) % cap;
      }
      appended += 1;
      return event.seq;
    },
    list(limit) {
      // Clamp limit to [0, size]; treat undefined/NaN/non-finite as "all".
      let n: number;
      if (limit === undefined || !Number.isFinite(limit)) {
        n = size;
      } else {
        n = Math.max(0, Math.min(Math.trunc(limit), size));
      }
      if (n === 0) return [];
      // "Last N, oldest-first": take the `n` most recent entries (the tail of
      // the live window), then emit them oldest-first. The newest entry is at
      // index (start + size - 1) % cap; the oldest of the selected slice sits
      // `n - 1` slots behind it.
      const newest = (start + size - 1) % cap;
      const oldestOfSlice = (newest - (n - 1) + cap) % cap;
      const out: AuditEvent<D>[] = new Array(n);
      for (let i = 0; i < n; i += 1) {
        out[i] = ring[(oldestOfSlice + i) % cap] as AuditEvent<D>;
      }
      return out;
    },
    clear() {
      // Drop references so retained detail objects can be GC'd; keep the bound.
      ring.fill(undefined);
      start = 0;
      size = 0;
      // Intentionally do NOT reset `seq`/`appended`: sequence numbering is
      // monotonic for the life of the buffer, so post-clear events stay
      // distinguishable from pre-clear ones in an audit trail.
    }
  };

  return api;
}

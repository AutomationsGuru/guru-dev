import { describe, expect, it } from "vitest";

import {
  WorkItemLeaseConfigSchema,
  WorkItemLeaseDeniedError,
  createInMemoryWorkItemLeaseStore,
  createWorkItemClaimLease
} from "../../src/fleet/workItemClaimLease.js";

/** A controllable clock so expiry/reclaim is deterministic — no real sleeping. */
function controlledClock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    }
  };
}

describe("workItemClaimLease config — hard caps in the schema", () => {
  it("applies safe defaults", () => {
    const config = WorkItemLeaseConfigSchema.parse({});
    expect(config.leaseTtlMs).toBe(30_000);
    expect(config.minLeaseTtlMs).toBeLessThanOrEqual(config.leaseTtlMs);
  });

  it("rejects an unbounded or zero TTL", () => {
    expect(() => WorkItemLeaseConfigSchema.parse({ leaseTtlMs: 0 })).toThrow();
    expect(() => WorkItemLeaseConfigSchema.parse({ leaseTtlMs: 999_999_999 })).toThrow();
  });

  it("rejects a min TTL that exceeds the base TTL", () => {
    expect(() =>
      WorkItemLeaseConfigSchema.parse({ leaseTtlMs: 5_000, minLeaseTtlMs: 10_000 })
    ).toThrow();
  });
});

describe("workItemClaimLease — exclusive acquire fails closed", () => {
  it("grants the first acquire and denies a second owner while live", () => {
    const clock = controlledClock();
    const lease = createWorkItemClaimLease({ now: clock.now });

    const first = lease.acquire("item-1", "worker-A");
    expect(first.outcome).toBe("acquired");
    expect(first.lease?.ownerId).toBe("worker-A");
    expect(first.lease?.state).toBe("active");

    // Second owner while the lease is live must fail CLOSED — no fake shared grant.
    const second = lease.acquire("item-1", "worker-B");
    expect(second.outcome).toBe("denied");
    expect(second.lease).toBeUndefined();
    expect(second.conflictingOwnerId).toBe("worker-A");
    expect(second.conflictingExpiresAt).toBe(first.lease?.expiresAt);
  });

  it("throwOnDenied surfaces a structured error instead of a silent deny", () => {
    const clock = controlledClock();
    const lease = createWorkItemClaimLease({ now: clock.now });
    lease.acquire("item-1", "worker-A");
    expect(() => lease.acquire("item-1", "worker-B", { throwOnDenied: true })).toThrow(
      WorkItemLeaseDeniedError
    );
    try {
      lease.acquire("item-1", "worker-B", { throwOnDenied: true });
    } catch (err) {
      const denied = err as WorkItemLeaseDeniedError;
      expect(denied.code).toBe("work_item_lease_denied");
      expect(denied.conflictingOwnerId).toBe("worker-A");
    }
  });

  it("the same owner re-acquiring an active lease is a no-op refresh, not a denial", () => {
    const clock = controlledClock();
    const lease = createWorkItemClaimLease({ config: { leaseTtlMs: 10_000 }, now: clock.now });
    const first = lease.acquire("item-1", "worker-A");
    const firstExpiry = first.lease?.expiresAt;
    clock.advance(2_000);
    const again = lease.acquire("item-1", "worker-A");
    expect(again.outcome).toBe("acquired");
    expect(again.lease?.expiresAt).toBeGreaterThan(firstExpiry ?? 0);
  });
});

describe("workItemClaimLease — expired lease is reclaimable", () => {
  it("a lapsed lease can be reclaimed by a different owner", () => {
    const clock = controlledClock();
    const lease = createWorkItemClaimLease({ config: { leaseTtlMs: 5_000 }, now: clock.now });

    lease.acquire("item-1", "worker-A");
    clock.advance(5_001); // past TTL — A's lease has lapsed
    const reclaimed = lease.acquire("item-1", "worker-B");
    expect(reclaimed.outcome).toBe("acquired");
    expect(reclaimed.lease?.ownerId).toBe("worker-B");
  });

  it("inspect reflects expiry after the TTL elapses", () => {
    const clock = controlledClock();
    const lease = createWorkItemClaimLease({ config: { leaseTtlMs: 5_000 }, now: clock.now });
    lease.acquire("item-1", "worker-A");
    expect(lease.inspect("item-1")?.state).toBe("active");
    clock.advance(5_001);
    expect(lease.inspect("item-1")?.state).toBe("expired");
  });

  it("a heartbeat from a non-owner is ignored (no silent takeover)", () => {
    const clock = controlledClock();
    const lease = createWorkItemClaimLease({ config: { leaseTtlMs: 10_000 }, now: clock.now });
    lease.acquire("item-1", "worker-A");
    clock.advance(1_000);
    expect(lease.heartbeat("item-1", "worker-B")).toBe(false);
    // A still owns; B's heartbeat did not move the expiry.
    const record = lease.inspect("item-1");
    expect(record?.ownerId).toBe("worker-A");
  });
});

describe("workItemClaimLease — heartbeat extends TTL", () => {
  it("a heartbeat pushes expiry forward for the owner", () => {
    const clock = controlledClock();
    const lease = createWorkItemClaimLease({ config: { leaseTtlMs: 10_000 }, now: clock.now });
    const first = lease.acquire("item-1", "worker-A");
    const before = first.lease?.expiresAt ?? 0;
    clock.advance(8_000); // 2s of life left
    expect(lease.heartbeat("item-1", "worker-A")).toBe(true);
    const after = lease.inspect("item-1")?.expiresAt ?? 0;
    expect(after).toBeGreaterThan(before);
    // A lease kept alive by heartbeats must still deny a competitor.
    expect(lease.acquire("item-1", "worker-B").outcome).toBe("denied");
  });

  it("heartbeat cannot race a lease to expiry below the floor", () => {
    const clock = controlledClock();
    const lease = createWorkItemClaimLease({
      config: { leaseTtlMs: 10_000, minLeaseTtlMs: 5_000 },
      now: clock.now
    });
    lease.acquire("item-1", "worker-A");
    clock.advance(8_000); // 2s remaining
    lease.heartbeat("item-1", "worker-A");
    const expiry = lease.inspect("item-1")?.expiresAt ?? 0;
    // From t=9000, floor is +5000 → at least 14000.
    expect(expiry).toBeGreaterThanOrEqual(14_000);
  });
});

describe("workItemClaimLease — release", () => {
  it("only the current owner can release; a stranger cannot", () => {
    const clock = controlledClock();
    const lease = createWorkItemClaimLease({ now: clock.now });
    lease.acquire("item-1", "worker-A");
    expect(lease.release("item-1", "worker-B")).toBe(false);
    expect(lease.release("item-1", "worker-A")).toBe(true);
    // After release the slot is reclaimable immediately.
    const next = lease.acquire("item-1", "worker-B");
    expect(next.outcome).toBe("acquired");
    expect(next.lease?.ownerId).toBe("worker-B");
  });

  it("releasing an unknown item fails honestly (no fake success)", () => {
    const clock = controlledClock();
    const lease = createWorkItemClaimLease({ now: clock.now });
    expect(lease.release("never-acquired", "worker-A")).toBe(false);
    expect(lease.heartbeat("never-acquired", "worker-A")).toBe(false);
  });
});

describe("workItemClaimLease — store injection", () => {
  it("two leases over the same injected store see one exclusive owner", () => {
    const clock = controlledClock();
    const store = createInMemoryWorkItemLeaseStore();
    const a = createWorkItemClaimLease({ store, now: clock.now });
    const b = createWorkItemClaimLease({ store, now: clock.now });
    expect(a.acquire("shared", "worker-A").outcome).toBe("acquired");
    expect(b.acquire("shared", "worker-B").outcome).toBe("denied");
  });
});

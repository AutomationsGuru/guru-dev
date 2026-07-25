import { describe, expect, it } from "vitest";

import { prune, type SandboxBoxRecord } from '../../src/sandbox/orphanBoxPrune.js';

const NOW = 1_000_000;
const RETAIN_MS = 60_000;

function box(overrides: Partial<SandboxBoxRecord>): SandboxBoxRecord {
  return {
    id: "box-default",
    status: "created",
    ...overrides
  };
}

describe("orphan box state prune", () => {
  it("keeps active boxes regardless of their destroyed timestamp", () => {
    const records = [
      box({ id: "created", status: "created", destroyedAt: 0 }),
      box({ id: "running", status: "running", destroyedAt: 0 }),
      box({ id: "stopped", status: "stopped", destroyedAt: 0 })
    ];

    expect(prune(records, { now: NOW, retainMs: RETAIN_MS })).toEqual(records);
  });

  it("removes destroyed boxes older than the retention period", () => {
    const recent = box({ id: "recent", status: "destroyed", destroyedAt: NOW - RETAIN_MS + 1 });
    const boundary = box({ id: "boundary", status: "destroyed", destroyedAt: NOW - RETAIN_MS });
    const old = box({ id: "old", status: "destroyed", destroyedAt: NOW - RETAIN_MS - 1 });
    const withoutTimestamp = box({ id: "without-timestamp", status: "destroyed" });

    expect(prune([recent, boundary, old, withoutTimestamp], { now: NOW, retainMs: RETAIN_MS })).toEqual([
      recent,
      boundary,
      withoutTimestamp
    ]);
  });
});

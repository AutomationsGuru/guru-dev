import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { TurnEventLog, hashTurnEvent, parseTurnEventPack, parseTurnEventPackJson } from "../../src/session/turnEventLog.js";
import { TurnReplayError, replayDryRun } from "../../src/session/turnEventReplay.js";

const T0 = "2026-07-19T06:02:00.000Z";
const EXPORTED_AT = "2026-07-19T07:00:00.000Z";

/** Mirror of the pack head computation, for building re-sealed tampered packs. */
function computeTestHead(entryHashes: readonly string[]): string {
  return createHash("sha256").update(entryHashes.join("\n")).digest("hex");
}

function seedLog(): TurnEventLog {
  const log = new TurnEventLog();
  log.append({ turn: 1, kind: "user", at: T0, payload: { text: "fix the flaky test" } });
  log.append({ turn: 1, kind: "decision", at: T0, payload: { move: "BUILD", gate: "preserve" } });
  log.append({ turn: 1, kind: "tool", at: T0, payload: { toolId: "edit", status: "succeeded" } });
  log.append({ turn: 1, kind: "assistant", at: T0, payload: { text: "test pinned" } });
  log.append({ turn: 2, kind: "user", at: T0, payload: { text: "now run it" } });
  log.append({ turn: 2, kind: "tool", at: T0, payload: { toolId: "bash", status: "succeeded" } });
  return log;
}

describe("TurnEventLog.append", () => {
  it("assigns contiguous 1..N seq in append order and never reuses one", () => {
    const log = seedLog();

    const events = log.list();
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events.map((event) => event.kind)).toEqual([
      "user",
      "decision",
      "tool",
      "assistant",
      "user",
      "tool"
    ]);

    log.append({ turn: 2, kind: "assistant", at: T0, payload: { text: "green" } });
    expect(log.list().map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("list filters by turn and kind without mutating the log", () => {
    const log = seedLog();

    expect(log.list({ turn: 2 }).map((event) => event.seq)).toEqual([5, 6]);
    expect(log.list({ kind: "tool" }).map((event) => event.seq)).toEqual([3, 6]);
    expect(log.list({ turn: 1, kind: "tool" }).map((event) => event.seq)).toEqual([3]);
    expect(log.size).toBe(6);
  });
});

describe("TurnEventLog.exportPack", () => {
  it("seals the log with per-entry hashes and a verifiable head", () => {
    const pack = seedLog().exportPack(EXPORTED_AT);

    expect(pack.version).toBe(1);
    expect(pack.createdAt).toBe(EXPORTED_AT);
    expect(pack.count).toBe(6);
    expect(pack.entryHashes).toHaveLength(6);
    expect(pack.head).toMatch(/^[0-9a-f]{64}$/);
    expect(parseTurnEventPackJson(JSON.stringify(pack))).toEqual(pack);
  });

  it("is stable: same log exports identical hashes", () => {
    const a = seedLog().exportPack(EXPORTED_AT);
    const b = seedLog().exportPack(EXPORTED_AT);
    expect(a.head).toBe(b.head);
    expect(a.entryHashes).toEqual(b.entryHashes);
  });
});

describe("replayDryRun — happy replay", () => {
  it("verifies a clean pack and returns events in recorded decision order", () => {
    const pack = seedLog().exportPack(EXPORTED_AT);

    const result = replayDryRun(pack);

    expect(result.ok).toBe(true);
    expect(result.checks).toEqual({
      count: 6,
      hashesVerified: 6,
      sequenceOk: true,
      turnsMonotonic: true
    });
    expect(result.turns).toEqual([1, 2]);
    expect(result.events.map((event) => event.kind)).toEqual([
      "user",
      "decision",
      "tool",
      "assistant",
      "user",
      "tool"
    ]);
    expect(result.events[1]?.payload).toEqual({ move: "BUILD", gate: "preserve" });
  });

  it("accepts a round-tripped JSON pack and an empty log", () => {
    const pack = seedLog().exportPack(EXPORTED_AT);
    expect(replayDryRun(JSON.parse(JSON.stringify(pack))).ok).toBe(true);

    const empty = new TurnEventLog().exportPack(EXPORTED_AT);
    const result = replayDryRun(empty);
    expect(result.ok).toBe(true);
    expect(result.checks.count).toBe(0);
    expect(result.turns).toEqual([]);
  });
});

describe("replayDryRun — corrupt pack fails", () => {
  const corruptors: Array<[string, (pack: ReturnType<TurnEventLog["exportPack"]>) => unknown, string]> = [
    [
      "truncated events",
      (pack) => ({ ...pack, events: pack.events.slice(0, 3) }),
      "invalid-pack"
    ],
    [
      "tampered payload",
      (pack) => ({
        ...pack,
        events: pack.events.map((event, index) =>
          index === 2 ? { ...event, payload: { ...event.payload, status: "failed" } } : event
        )
      }),
      "hash-mismatch"
    ],
    [
      "reordered events",
      (pack) => ({ ...pack, events: [pack.events[0], pack.events[2], pack.events[1], ...pack.events.slice(3)] }),
      "sequence-gap"
    ],
    [
      "forged head",
      (pack) => ({ ...pack, head: "0".repeat(64) }),
      "head-mismatch"
    ],
    [
      "dropped entry hash",
      (pack) => ({ ...pack, entryHashes: pack.entryHashes.slice(1) }),
      "invalid-pack"
    ],
    [
      "unknown event kind",
      (pack) => ({
        ...pack,
        events: pack.events.map((event, index) => (index === 0 ? { ...event, kind: "system" } : event))
      }),
      "invalid-pack"
    ],
    [
      "turn regression",
      (pack) => {
        // Rewrite the last event back to turn 1 and re-seal hashes/head so the
        // failure lands on turn order, not the hash chain.
        const events = pack.events.map((event, index) => (index === 5 ? { ...event, turn: 1 } : event));
        const entryHashes = events.map(hashTurnEvent);
        const head = computeTestHead(entryHashes);
        return { ...pack, events, entryHashes, head };
      },
      "turn-regression"
    ]
  ];

  it.each(corruptors)("%s", (_name, corrupt, code) => {
    const tampered = corrupt(seedLog().exportPack(EXPORTED_AT));

    expect(() => replayDryRun(tampered)).toThrowError(TurnReplayError);
    try {
      replayDryRun(tampered);
      expect.unreachable("corrupt pack must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(TurnReplayError);
      expect((error as TurnReplayError).code).toBe(code);
    }
  });

  it("rejects non-pack input outright", () => {
    expect(() => replayDryRun(null)).toThrowError(TurnReplayError);
    expect(() => replayDryRun({ version: 2 })).toThrowError(TurnReplayError);
    expect(() => parseTurnEventPack("not a pack")).toThrow();
  });
});

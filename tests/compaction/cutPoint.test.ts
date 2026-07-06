import { describe, expect, it } from "vitest";

import { findCutPoint } from "../../src/compaction/cutPoint.js";
import { estimateTranscriptTokens, ENTRY_OVERHEAD_TOKENS } from "../../src/compaction/estimate.js";
import type { TranscriptEntry, TranscriptEntryKind } from "../../src/compaction/schemas.js";

/** 1 char = 1 token estimator makes the budget math exact in every case. */
const chars = (text: string): number => text.length;

let sequence = 0;
function entry(kind: TranscriptEntryKind, content: string): TranscriptEntry {
  sequence += 1;
  return { id: `t${sequence}`, kind, content };
}

const text = (n: number): string => "x".repeat(n);

describe("findCutPoint — the binding invariants (ADR 2026-07-04)", () => {
  it("returns null when the whole transcript fits keepRecentTokens", () => {
    const entries = [entry("user", text(10)), entry("assistant", text(10))];
    expect(findCutPoint(entries, 1_000, chars)).toBeNull();
  });

  it("returns null for transcripts too small to split", () => {
    expect(findCutPoint([], 10, chars)).toBeNull();
    expect(findCutPoint([entry("user", text(500))], 10, chars)).toBeNull();
  });

  it("walks back from the newest entry and keeps the suffix under budget", () => {
    // 6 entries of 20 chars (24 tokens each with overhead). Budget 60 → keeps 2.
    const entries = [
      entry("user", text(20)),
      entry("assistant", text(20)),
      entry("user", text(20)),
      entry("assistant", text(20)),
      entry("user", text(20)),
      entry("assistant", text(20))
    ];
    const plan = findCutPoint(entries, 60, chars);
    expect(plan).not.toBeNull();
    expect(plan?.firstKeptIndex).toBe(4);
    const kept = entries.slice(plan?.firstKeptIndex ?? 0);
    expect(estimateTranscriptTokens(kept, chars)).toBeLessThanOrEqual(60);
    // The kept suffix opens at a user entry → clean cut, not split-turn.
    expect(plan?.splitTurn).toBe(false);
  });

  it("NEVER cuts at a toolResult — snaps forward to the next user/assistant", () => {
    const entries = [
      entry("user", text(40)),
      entry("assistant", text(40)),
      entry("toolCall", text(40)),
      entry("toolResult", text(40)),
      entry("assistant", text(10)),
      entry("user", text(10))
    ];
    // Budget forces the raw candidate onto the toolResult (index 3).
    const budget = 40 + 10 + 10 + 3 * ENTRY_OVERHEAD_TOKENS + 5;
    const plan = findCutPoint(entries, budget, chars);
    expect(plan).not.toBeNull();
    const firstKept = entries[plan?.firstKeptIndex ?? -1];
    expect(firstKept?.kind).not.toBe("toolResult");
    expect(["user", "assistant"]).toContain(firstKept?.kind ?? "");
    // The pair stays together on the summarized side.
    expect(plan?.firstKeptIndex).toBeGreaterThan(3);
  });

  it("NEVER orphans a toolCall from its result (previous-entry rule)", () => {
    const entries = [
      entry("user", text(40)),
      entry("toolCall", text(40)),
      entry("assistant", text(40)), // malformed adjacency: candidate here is invalid
      entry("user", text(10))
    ];
    const budget = 40 + 10 + 2 * ENTRY_OVERHEAD_TOKENS + 5; // candidate = index 2
    const plan = findCutPoint(entries, budget, chars);
    expect(plan).not.toBeNull();
    // Index 2 (assistant preceded by toolCall) is invalid → snap forward to 3.
    expect(plan?.firstKeptIndex).toBe(3);
  });

  it("split-turn: a single oversized turn cuts mid-turn at an assistant entry", () => {
    const entries = [
      entry("user", text(10)),
      entry("assistant", text(10)),
      entry("user", text(30)), // the turn start
      entry("assistant", text(200)),
      entry("assistant", text(200)) // huge turn continues
    ];
    const plan = findCutPoint(entries, 250, chars);
    expect(plan).not.toBeNull();
    const firstKept = entries[plan?.firstKeptIndex ?? -1];
    expect(firstKept?.kind).toBe("assistant");
    expect(plan?.splitTurn).toBe(true);
    expect(plan?.turnStartIndex).toBe(2);
  });

  it("keeps at least the newest entry even when everything is oversized", () => {
    const entries = [entry("user", text(500)), entry("assistant", text(500)), entry("assistant", text(500))];
    const plan = findCutPoint(entries, 10, chars);
    expect(plan).not.toBeNull();
    expect(plan?.firstKeptIndex).toBeLessThanOrEqual(entries.length - 1);
    expect(plan?.firstKeptIndex).toBeGreaterThan(0);
  });

  it("returns null when no valid cut exists anywhere", () => {
    const entries = [entry("toolCall", text(100)), entry("toolResult", text(100))];
    expect(findCutPoint(entries, 10, chars)).toBeNull();
  });

  it("BACKWARD snap actually executes: no valid cut forward of the candidate → nearest valid earlier cut wins", () => {
    // Candidate lands at index 4 (toolCall); forward scan (4: toolCall, 5: toolResult)
    // finds nothing valid, so the backward loop must run and settle on index 1.
    const entries = [
      entry("user", text(10)),
      entry("assistant", text(10)),
      entry("toolCall", text(10)),
      entry("toolResult", text(10)),
      entry("toolCall", text(60)),
      entry("toolResult", text(60))
    ];
    const budget = 60 + 60 + 2 * ENTRY_OVERHEAD_TOKENS + 5; // crosses at index 4
    const plan = findCutPoint(entries, budget, chars);
    expect(plan).not.toBeNull();
    expect(plan?.firstKeptIndex).toBe(1); // backward: 3,2 invalid → 1 (assistant, prev=user)
    expect(entries[plan?.firstKeptIndex ?? -1]?.kind).toBe("assistant");
    expect(plan?.splitTurn).toBe(true);
  });

  it("reports tokensBefore for the whole transcript and tokensSummarized for the folded region", () => {
    const entries = [
      entry("user", text(100)),
      entry("assistant", text(100)),
      entry("user", text(10)),
      entry("assistant", text(10))
    ];
    const plan = findCutPoint(entries, 40, chars);
    expect(plan).not.toBeNull();
    expect(plan?.tokensBefore).toBe(estimateTranscriptTokens(entries, chars));
    expect(plan?.tokensSummarized).toBe(estimateTranscriptTokens(entries.slice(0, plan?.firstKeptIndex ?? 0), chars));
    expect((plan?.tokensSummarized ?? 0) + estimateTranscriptTokens(entries.slice(plan?.firstKeptIndex ?? 0), chars)).toBe(
      plan?.tokensBefore ?? -1
    );
  });
});

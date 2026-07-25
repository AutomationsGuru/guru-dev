import { describe, expect, it } from "vitest";

import {
  SUMMARY_ENTRY_PREFIX,
  chatHistoryToTranscript,
  phase1PruneToolResults,
  phase1PruneToolResultsReported,
  phase2AttachSummary,
  twoPhaseContextCompact,
  type Phase1PruneOptions
} from '../../src/session/twoPhaseContextCompact.js';
import type { ChatTurnMessage } from '../../src/model/directChat.js';
import type { TranscriptEntry } from '../../src/compaction/schemas.js';

const entry = (id: string, kind: TranscriptEntry["kind"], content: string): TranscriptEntry => ({ id, kind, content });

const large = (n: number): string => "x".repeat(n);

describe("phase1PruneToolResults", () => {
  const baseOpts: Phase1PruneOptions = { maxToolResultChars: 200 };

  it("truncates a toolResult larger than the ceiling and marks it elided", () => {
    const entries = [
      entry("t1", "toolCall", '{"toolId":"read","input":{"path":"a"}}'),
      entry("r1", "toolResult", large(500))
    ];
    const out = phase1PruneToolResults(entries, baseOpts);
    expect(out).toHaveLength(2);
    expect(out[1]?.kind).toBe("toolResult");
    const content = out[1]?.content ?? "";
    expect(content.length).toBeLessThan(500);
    expect(content).toContain("[… elided");
    // The id and kind of the pruned entry are preserved.
    expect(out[1]?.id).toBe("r1");
  });

  it("leaves small tool results untouched", () => {
    const entries = [entry("r1", "toolResult", "small payload")];
    const out = phase1PruneToolResults(entries, baseOpts);
    expect(out[0]?.content).toBe("small payload");
  });

  it("preserves head/tail context of a large tool result when keepHead/keepTail are set", () => {
    const entries = [entry("r1", "toolResult", large(1000))];
    const out = phase1PruneToolResults(entries, {
      maxToolResultChars: 200,
      keepHeadChars: 40,
      keepTailChars: 40
    });
    const content = out[0]?.content ?? "";
    expect(content.startsWith("x".repeat(40))).toBe(true);
    expect(content.endsWith("x".repeat(40))).toBe(true);
    expect(content).toContain("[… elided");
  });

  it("prunes only entries at-or-after pruneFromIndex when provided", () => {
    const entries = [
      entry("r-old", "toolResult", large(500)),
      entry("u1", "user", "keep going"),
      entry("r-new", "toolResult", large(500))
    ];
    const out = phase1PruneToolResults(entries, { ...baseOpts, pruneFromIndex: 1 });
    expect(out[0]?.content).toBe(large(500));
    expect(out[2]?.content).toContain("[… elided");
  });

  it("returns a shallow copy and never mutates the input", () => {
    const entries = [entry("r1", "toolResult", large(500))];
    const snapshot = entries[0]?.content;
    const out = phase1PruneToolResults(entries, baseOpts);
    expect(out).not.toBe(entries);
    expect(entries[0]?.content).toBe(snapshot);
  });

  it("reports how many tool results were pruned", () => {
    const entries = [
      entry("r1", "toolResult", large(500)),
      entry("r2", "toolResult", "small"),
      entry("r3", "toolResult", large(500))
    ];
    const out = phase1PruneToolResultsReported(entries, baseOpts);
    expect(out.prunedCount).toBe(2);
    expect(out.entries).toHaveLength(3);
  });

  it("never splits a toolCall away from its toolResult (no orphaning)", () => {
    // A toolCall followed by a large result stays a pair after pruning.
    const entries = [
      entry("t1", "toolCall", '{"toolId":"read"}'),
      entry("r1", "toolResult", large(500)),
      entry("a1", "assistant", "done")
    ];
    const out = phase1PruneToolResults(entries, baseOpts);
    expect(out[0]?.kind).toBe("toolCall");
    expect(out[1]?.kind).toBe("toolResult");
    expect(out[2]?.kind).toBe("assistant");
  });
});

describe("phase2AttachSummary", () => {
  it("prepends a summary system entry to the history", () => {
    const messages: ChatTurnMessage[] = [{ role: "user", content: "hi" }];
    const out = phase2AttachSummary(messages, "what happened");
    expect(out[0]?.role).toBe("system");
    expect(out[0]?.content.startsWith(SUMMARY_ENTRY_PREFIX)).toBe(true);
    expect(out[0]?.content).toContain("what happened");
  });

  it("preserves an existing system head and inserts the summary right after it", () => {
    const messages: ChatTurnMessage[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "hi" }
    ];
    const out = phase2AttachSummary(messages, "summary");
    expect(out[0]?.content).toBe("system prompt");
    expect(out[1]?.role).toBe("system");
    expect(out[1]?.content.startsWith(SUMMARY_ENTRY_PREFIX)).toBe(true);
    expect(out[2]).toEqual({ role: "user", content: "hi" });
  });

  it("replaces a prior compaction summary instead of stacking a second one", () => {
    const messages: ChatTurnMessage[] = [{ role: "user", content: "hi" }];
    const once = phase2AttachSummary(messages, "first");
    const twice = phase2AttachSummary(once, "second");
    const summaries = twice.filter((m) => m.content.startsWith(SUMMARY_ENTRY_PREFIX));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.content).toContain("second");
  });

  it("does not mutate the input array", () => {
    const messages: ChatTurnMessage[] = [{ role: "user", content: "hi" }];
    phase2AttachSummary(messages, "summary");
    expect(messages).toEqual([{ role: "user", content: "hi" }]);
  });
});

describe("chatHistoryToTranscript", () => {
  it("adapts flat chat messages into transcript entries", () => {
    const messages: ChatTurnMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" }
    ];
    const entries = chatHistoryToTranscript(messages);
    expect(entries.map((e) => e.kind)).toEqual(["system", "user", "assistant"]);
    expect(entries.map((e) => e.content)).toEqual(["sys", "hi", "hello"]);
    expect(entries[0]?.id).toBeTruthy();
  });
});

describe("twoPhaseContextCompact (end-to-end)", () => {
  it("removes large tool payloads in phase1 then attaches the summary in phase2", () => {
    // phase1 operates on the transcript model (where toolResult lives);
    // phase2 attaches the summary to the flat chat history.
    const transcript: TranscriptEntry[] = [
      entry("u1", "user", "read a big file"),
      entry("t1", "toolCall", '{"toolId":"read","input":{"path":"a"}}'),
      entry("r1", "toolResult", large(10_000)),
      entry("a1", "assistant", "ok")
    ];
    const pruned = phase1PruneToolResults(transcript, { maxToolResultChars: 200 });
    // The oversized tool result was truncated in place.
    expect(pruned.find((e) => e.id === "r1")?.content.length).toBeLessThan(10_000);
    expect(pruned.find((e) => e.id === "r1")?.content).toContain("[… elided");
    // No entry still carries the full 10k payload.
    expect(pruned.some((e) => e.content.length >= 10_000)).toBe(false);
    // The toolCall/result pair stays adjacent (no orphaning).
    const rIdx = pruned.findIndex((e) => e.id === "r1");
    expect(pruned[rIdx - 1]?.kind).toBe("toolCall");

    const reduced: ChatTurnMessage[] = [
      { role: "user", content: "read a big file" },
      { role: "assistant", content: "ok" }
    ];
    const out = phase2AttachSummary(reduced, "the operator read a big file");
    expect(out[0]?.content.startsWith(SUMMARY_ENTRY_PREFIX)).toBe(true);
    expect(out[0]?.content).toContain("the operator read a big file");
  });

  it("twoPhaseContextCompact flattens chat history through both phases", () => {
    const messages: ChatTurnMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" }
    ];
    const out = twoPhaseContextCompact(messages, "greeted", { maxToolResultChars: 200 });
    expect(out[0]?.content.startsWith(SUMMARY_ENTRY_PREFIX)).toBe(true);
    expect(out.filter((m) => !m.content.startsWith(SUMMARY_ENTRY_PREFIX))).toHaveLength(2);
  });
});

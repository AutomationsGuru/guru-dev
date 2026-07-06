import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_SUMMARY_BLOCK_CHARS,
  renderTranscriptBlock,
  runCompaction,
  shouldCompact,
  SUMMARY_ENTRY_PREFIX,
  extractFilesFromEntries,
  type SummarizeRequest
} from "../../src/compaction/engine.js";
import { CompactionConfigSchema, type TranscriptEntry, type TranscriptEntryKind } from "../../src/compaction/schemas.js";
import { clearRegisteredSecretValues, registerSecretValue } from "../../src/safety/secretSafety.js";

const chars = (text: string): number => text.length;
const NOW = new Date("2026-07-04T12:00:00.000Z");

let sequence = 0;
function entry(kind: TranscriptEntryKind, content: string): TranscriptEntry {
  sequence += 1;
  return { id: `t${sequence}`, kind, content };
}
const text = (n: number): string => "x".repeat(n);

function config(overrides: Partial<{ enabled: boolean; reserveTokens: number; keepRecentTokens: number; summaryMaxTokens: number }> = {}) {
  return CompactionConfigSchema.parse({ ...overrides });
}

/** A deterministic fake summarizer that records every request it gets. */
function fakeSummarizer(reply: (request: SummarizeRequest) => string = () => "SUMMARY") {
  const calls: SummarizeRequest[] = [];
  const summarize = (request: SummarizeRequest): Promise<string> => {
    calls.push(request);
    return Promise.resolve(reply(request));
  };
  return { calls, summarize };
}

afterEach(() => {
  clearRegisteredSecretValues();
});

describe("shouldCompact — the auto-trigger inequality", () => {
  const base = { config: config({ reserveTokens: 1_000 }), contextWindowTokens: 10_000 };

  it("fires when the REAL last input tokens cross contextWindow − reserve", () => {
    expect(shouldCompact({ ...base, lastInputTokens: 9_001, estimatedTokens: 0 })).toBe(true);
    expect(shouldCompact({ ...base, lastInputTokens: 9_000, estimatedTokens: 0 })).toBe(false);
  });

  it("fires when the ESTIMATED outgoing tokens cross the threshold (huge paste, silent lane)", () => {
    expect(shouldCompact({ ...base, lastInputTokens: 0, estimatedTokens: 9_001 })).toBe(true);
  });

  it("never fires when disabled, window unknown, or the window is degenerate", () => {
    expect(shouldCompact({ ...base, config: config({ enabled: false }), lastInputTokens: 99_999, estimatedTokens: 99_999 })).toBe(false);
    expect(shouldCompact({ config: base.config, contextWindowTokens: undefined, lastInputTokens: 99_999, estimatedTokens: 99_999 })).toBe(false);
    expect(shouldCompact({ config: config({ reserveTokens: 16_384 }), contextWindowTokens: 8_000, lastInputTokens: 99_999, estimatedTokens: 99_999 })).toBe(false);
  });
});

describe("runCompaction — orchestration", () => {
  it("folds the older region into a summary entry and keeps the suffix verbatim", async () => {
    const entries = [
      entry("user", text(100)),
      entry("assistant", text(100)),
      entry("user", text(10)),
      entry("assistant", text(10))
    ];
    const { calls, summarize } = fakeSummarizer(() => "the operator built a compaction engine");
    const result = await runCompaction({
      entries,
      config: config({ keepRecentTokens: 40 }),
      summarize,
      estimator: chars,
      now: () => NOW,
      reason: "threshold"
    });
    expect(result).not.toBeNull();
    if (result === null || "cancelled" in result) {
      throw new Error("expected a run result");
    }
    expect(calls).toHaveLength(1);
    expect(result.summaryEntry.kind).toBe("system");
    expect(result.summaryEntry.content.startsWith(SUMMARY_ENTRY_PREFIX)).toBe(true);
    expect(result.summaryEntry.content).toContain("the operator built a compaction engine");
    expect(result.keptEntries).toEqual(entries.slice(result.plan.firstKeptIndex));
    expect(result.state.count).toBe(1);
    expect(result.state.compactedAt).toBe(NOW.toISOString());
    expect(result.state.firstKeptEntryId).toBe(entries[result.plan.firstKeptIndex]?.id);
    expect(result.state.tokensBefore).toBe(result.plan.tokensBefore);
  });

  it("split-turn runs the DUAL summary (history + turn prefix) and merges them", async () => {
    const entries = [
      entry("user", text(10)),
      entry("assistant", text(10)),
      entry("user", text(30)),
      entry("assistant", text(200)),
      entry("assistant", text(200))
    ];
    const { calls, summarize } = fakeSummarizer((request) => (request.label === "history" ? "OLD-HISTORY" : "TURN-PREFIX"));
    const result = await runCompaction({
      entries,
      config: config({ keepRecentTokens: 250 }),
      summarize,
      estimator: chars,
      now: () => NOW,
      reason: "threshold"
    });
    if (result === null || "cancelled" in result) {
      throw new Error("expected a run result");
    }
    expect(result.plan.splitTurn).toBe(true);
    expect(calls.map((call) => call.label).sort()).toEqual(["history", "turn-prefix"]);
    expect(result.state.summary).toContain("OLD-HISTORY");
    expect(result.state.summary).toContain("[current turn so far]");
    expect(result.state.summary).toContain("TURN-PREFIX");
  });

  it("passes the previous summary and custom instructions through to the summarizer (iterative)", async () => {
    const entries = [entry("user", text(100)), entry("assistant", text(100)), entry("user", text(5))];
    const { calls, summarize } = fakeSummarizer();
    const result = await runCompaction({
      entries,
      config: config({ keepRecentTokens: 20 }),
      summarize,
      estimator: chars,
      now: () => NOW,
      reason: "manual",
      previousSummary: "PRIOR-SUMMARY",
      previousCount: 2,
      customInstructions: "focus on the database work"
    });
    if (result === null || "cancelled" in result) {
      throw new Error("expected a run result");
    }
    expect(calls[0]?.previousSummary).toBe("PRIOR-SUMMARY");
    expect(calls[0]?.customInstructions).toBe("focus on the database work");
    expect(result.state.count).toBe(3);
  });

  it("beforeCompact hook can cancel — the summarizer never runs", async () => {
    const entries = [entry("user", text(100)), entry("assistant", text(100)), entry("user", text(5))];
    const { calls, summarize } = fakeSummarizer();
    const result = await runCompaction({
      entries,
      config: config({ keepRecentTokens: 20 }),
      summarize,
      estimator: chars,
      now: () => NOW,
      reason: "threshold",
      beforeCompact: () => ({ cancel: true })
    });
    expect(result).toEqual({ cancelled: true });
    expect(calls).toHaveLength(0);
  });

  it("onCompact hook receives the durable state", async () => {
    const entries = [entry("user", text(100)), entry("assistant", text(100)), entry("user", text(5))];
    const { summarize } = fakeSummarizer();
    let observed: unknown;
    const result = await runCompaction({
      entries,
      config: config({ keepRecentTokens: 20 }),
      summarize,
      estimator: chars,
      now: () => NOW,
      reason: "threshold",
      onCompact: (state) => {
        observed = state;
      }
    });
    if (result === null || "cancelled" in result) {
      throw new Error("expected a run result");
    }
    expect(observed).toEqual(result.state);
  });

  it("SCRUBS registered secrets from the transcript block SENT to the summarizer (input side)", async () => {
    const secret = "sk-live-input-side-secret-55555";
    registerSecretValue(secret);
    const entries = [
      entry("user", `deploy with ${secret} please ${text(100)}`),
      entry("assistant", text(100)),
      entry("user", text(5))
    ];
    const { calls, summarize } = fakeSummarizer();
    await runCompaction({
      entries,
      config: config({ keepRecentTokens: 20 }),
      summarize,
      estimator: chars,
      now: () => NOW,
      reason: "threshold"
    });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.transcriptBlock).not.toContain(secret);
    }
  });

  it("SCRUBS registered secret values out of the summary (engine-level, FR-21)", async () => {
    const secret = "sk-live-abc123-compaction-test-secret";
    registerSecretValue(secret);
    const entries = [entry("user", text(100)), entry("assistant", text(100)), entry("user", text(5))];
    const { summarize } = fakeSummarizer(() => `the key ${secret} was used for the deploy`);
    const result = await runCompaction({
      entries,
      config: config({ keepRecentTokens: 20 }),
      summarize,
      estimator: chars,
      now: () => NOW,
      reason: "threshold"
    });
    if (result === null || "cancelled" in result) {
      throw new Error("expected a run result");
    }
    expect(result.state.summary).not.toContain(secret);
    expect(result.summaryEntry.content).not.toContain(secret);
  });

  it("tracks files cumulatively: previous details + session files + toolCall extraction, deduped and sorted", async () => {
    const entries = [
      entry("toolCall", JSON.stringify({ toolId: "read", input: { path: "src/b.ts" } })),
      entry("toolResult", "ok"),
      entry("user", text(200)),
      entry("assistant", text(200)),
      entry("toolCall", JSON.stringify({ toolId: "edit", input: { path: "src/c.ts" } })),
      entry("toolResult", "ok"),
      entry("user", text(5)),
      entry("assistant", text(5))
    ];
    const { summarize } = fakeSummarizer();
    const result = await runCompaction({
      entries,
      config: config({ keepRecentTokens: 30 }),
      summarize,
      estimator: chars,
      now: () => NOW,
      reason: "threshold",
      previousDetails: { readFiles: ["src/a.ts"], modifiedFiles: [] },
      previousCount: 1,
      sessionFiles: { readFiles: ["src/b.ts"], modifiedFiles: ["src/d.ts"] }
    });
    if (result === null || "cancelled" in result) {
      throw new Error("expected a run result");
    }
    expect(result.state.details.readFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.state.details.modifiedFiles).toEqual(["src/c.ts", "src/d.ts"]);
  });

  it("FAILS (throws) on an empty summarizer response — the folded history must never be destroyed", async () => {
    const entries = [entry("user", text(100)), entry("assistant", text(100)), entry("user", text(5))];
    const { summarize } = fakeSummarizer(() => "   ");
    await expect(
      runCompaction({
        entries,
        config: config({ keepRecentTokens: 20 }),
        summarize,
        estimator: chars,
        now: () => NOW,
        reason: "threshold"
      })
    ).rejects.toThrow(/empty summary/u);
  });

  it("returns null when there is nothing to fold", async () => {
    const { calls, summarize } = fakeSummarizer();
    const result = await runCompaction({
      entries: [entry("user", "hi"), entry("assistant", "hello")],
      config: config(),
      summarize,
      estimator: chars,
      now: () => NOW,
      reason: "threshold"
    });
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("renderTranscriptBlock / extractFilesFromEntries", () => {
  it("caps oversized blocks with head+tail elision so summarization can't overflow", () => {
    const huge = [entry("user", text(MAX_SUMMARY_BLOCK_CHARS)), entry("assistant", text(MAX_SUMMARY_BLOCK_CHARS))];
    const block = renderTranscriptBlock(huge);
    expect(block.length).toBeLessThanOrEqual(MAX_SUMMARY_BLOCK_CHARS + 200);
    expect(block).toContain("chars elided");
  });

  it("extracts read vs modified paths from toolCall entries and ignores junk", () => {
    const details = extractFilesFromEntries([
      entry("toolCall", JSON.stringify({ toolId: "read", input: { path: "a.ts" } })),
      entry("toolCall", JSON.stringify({ toolId: "write", input: { path: "b.ts" } })),
      entry("toolCall", "not-json"),
      entry("toolCall", JSON.stringify({ toolId: "bash", input: { command: "ls" } })),
      entry("user", "hello")
    ]);
    expect(details).toEqual({ readFiles: ["a.ts"], modifiedFiles: ["b.ts"] });
  });
});

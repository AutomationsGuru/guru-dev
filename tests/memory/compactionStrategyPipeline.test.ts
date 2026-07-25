import { describe, expect, it } from "vitest";

import type { TranscriptEntry } from '../../src/compaction/schemas.js';
import {
  measureTranscriptTokens,
  runCompactionStrategyPipeline,
  type CompactionStrategy
} from '../../src/memory/compactionStrategyPipeline.js';

function entry(id: string, content: string, kind: TranscriptEntry["kind"] = "user"): TranscriptEntry {
  return { id, kind, content };
}

/** Deterministic estimator: 1 token per character, no surprises. */
const charEstimator = (text: string) => text.length;

/** Sliding-window style strategy: keep only the last `keep` messages. */
function keepLast(keep: number): CompactionStrategy {
  return (messages) => messages.slice(Math.max(0, messages.length - keep));
}

/** Truncate style strategy: cap every message body at `max` chars. */
function capContent(max: number): CompactionStrategy {
  return (messages) => messages.map((m) => ({ ...m, content: m.content.slice(0, max) }));
}

describe("runCompactionStrategyPipeline", () => {
  it("is a no-op for an empty pipeline", () => {
    const messages = [entry("a", "x".repeat(100)), entry("b", "y".repeat(100))];
    const result = runCompactionStrategyPipeline(messages, 10, { strategies: [], estimator: charEstimator });
    expect(result.messages).toBe(messages);
    expect(result.withinBudget).toBe(false);
    expect(result.tokensAfter).toBe(result.tokensBefore);
    expect(result.stoppedAtStrategy).toBeUndefined();
  });

  it("does not invoke strategies when the transcript already fits", () => {
    const messages = [entry("a", "tiny")];
    let invoked = 0;
    const spy: CompactionStrategy = (ms) => {
      invoked += 1;
      return ms;
    };
    const result = runCompactionStrategyPipeline(messages, 1000, {
      strategies: [spy],
      estimator: charEstimator
    });
    expect(invoked).toBe(0);
    expect(result.messages).toBe(messages);
    expect(result.withinBudget).toBe(true);
  });

  it("applies multiple strategies in order until the budget is met", () => {
    const messages = [
      entry("a", "a".repeat(50)),
      entry("b", "b".repeat(50)),
      entry("c", "c".repeat(50)),
      entry("d", "d".repeat(50))
    ];
    // Budget 28 fits two capped messages (10 chars + 4 framing each) but not two full ones.
    const result = runCompactionStrategyPipeline(messages, 28, {
      strategies: [keepLast(2), capContent(10)],
      estimator: charEstimator
    });
    expect(result.withinBudget).toBe(true);
    expect(result.stoppedAtStrategy).toBe(1);
    expect(result.messages.map((m) => m.id)).toEqual(["c", "d"]);
    expect(result.messages.every((m) => m.content.length <= 10)).toBe(true);
    expect(result.tokensAfter).toBeLessThanOrEqual(28);
  });

  it("stops early and skips later strategies once under budget", () => {
    const messages = [entry("a", "a".repeat(40)), entry("b", "b".repeat(40)), entry("c", "c".repeat(40))];
    const seen: number[] = [];
    const makeSpy = (index: number, strategy: CompactionStrategy): CompactionStrategy => (ms, budget, est) => {
      seen.push(index);
      return strategy(ms, budget, est);
    };
    // Budget 44 fits the last message (40 chars + 4 framing) but no pair.
    const result = runCompactionStrategyPipeline(messages, 44, {
      strategies: [makeSpy(0, keepLast(1)), makeSpy(1, capContent(5))],
      estimator: charEstimator
    });
    expect(seen).toEqual([0]);
    expect(result.stoppedAtStrategy).toBe(0);
    expect(result.messages.map((m) => m.id)).toEqual(["c"]);
  });

  it("reports exhaustion when every strategy runs and the budget is still exceeded", () => {
    const messages = [entry("a", "a".repeat(30)), entry("b", "b".repeat(30))];
    const identity: CompactionStrategy = (ms) => ms;
    const result = runCompactionStrategyPipeline(messages, 5, {
      strategies: [identity, identity],
      estimator: charEstimator
    });
    expect(result.withinBudget).toBe(false);
    expect(result.stoppedAtStrategy).toBeUndefined();
    expect(result.tokensAfter).toBeGreaterThan(5);
  });

  it("never mutates the input transcript", () => {
    const messages = [entry("a", "a".repeat(60)), entry("b", "b".repeat(60))];
    const snapshot = messages.map((m) => ({ ...m }));
    runCompactionStrategyPipeline(messages, 10, {
      strategies: [capContent(5), keepLast(1)],
      estimator: charEstimator
    });
    expect(messages).toEqual(snapshot);
  });

  it("uses the default estimator when none is provided", () => {
    const messages = [entry("a", "abcd")]; // 4 chars + ENTRY_OVERHEAD_TOKENS framing
    const result = runCompactionStrategyPipeline(messages, 1_000, { strategies: [] });
    expect(result.tokensBefore).toBe(measureTranscriptTokens(messages, (text) => Math.ceil(text.length / 4)));
    expect(result.withinBudget).toBe(true);
  });
});

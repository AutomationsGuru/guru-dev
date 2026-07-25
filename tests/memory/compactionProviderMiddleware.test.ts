import {
  beforeModel,
  estimateHistoryTokens,
  type CompactionPipeline,
  type HistoryProvider,
  type TokenEstimator
} from '../../src/memory/compactionProviderMiddleware.js';

class FakeHistoryProvider implements HistoryProvider {
  readonly replaceAllCalls: Array<readonly string[]> = [];
  private messages: readonly string[];

  constructor(initial: readonly string[]) {
    this.messages = [...initial];
  }

  list(): readonly string[] {
    return this.messages;
  }

  replaceAll(messages: readonly string[]): void {
    this.replaceAllCalls.push(messages);
    this.messages = [...messages];
  }
}

function makeSpyPipeline(result: (messages: readonly string[], budget: number) => readonly string[]) {
  const calls: Array<{ messages: readonly string[]; budget: number }> = [];
  const pipeline: CompactionPipeline = (messages, budget) => {
    calls.push({ messages, budget });
    return result(messages, budget);
  };
  return { pipeline, calls };
}

describe("compaction provider middleware", () => {
  it("compacts when estimated tokens exceed the budget", () => {
    const provider = new FakeHistoryProvider(["a".repeat(400), "b".repeat(400)]);
    const { pipeline, calls } = makeSpyPipeline((messages) => [messages[1] ?? ""]);
    const result = beforeModel({ provider, pipeline, tokenBudget: 100 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.messages).toEqual(["a".repeat(400), "b".repeat(400)]);
    expect(calls[0]?.budget).toBe(100);
    expect(provider.replaceAllCalls).toEqual([["b".repeat(400)]]);
    expect(result.compacted).toBe(true);
    if (result.compacted) {
      expect(result.tokensBefore).toBeGreaterThan(100);
      expect(result.tokensAfter).toBeLessThanOrEqual(result.tokensBefore);
      expect(result.messages).toEqual(["b".repeat(400)]);
    }
  });

  it("no-ops under the threshold without calling the pipeline or the provider", () => {
    const provider = new FakeHistoryProvider(["short"]);
    const { pipeline, calls } = makeSpyPipeline(() => ["shrunk"]);
    const result = beforeModel({ provider, pipeline, tokenBudget: 1000 });

    expect(calls).toHaveLength(0);
    expect(provider.replaceAllCalls).toHaveLength(0);
    expect(result).toMatchObject({ compacted: false, messages: ["short"], tokensBefore: estimateHistoryTokens(["short"]) });
  });

  it("no-ops on empty history without calling the pipeline", () => {
    const provider = new FakeHistoryProvider([]);
    const { pipeline, calls } = makeSpyPipeline(() => []);
    const result = beforeModel({ provider, pipeline, tokenBudget: 1 });

    expect(calls).toHaveLength(0);
    expect(provider.replaceAllCalls).toHaveLength(0);
    expect(result).toMatchObject({ compacted: false, messages: [], tokensBefore: 0 });
  });

  it("treats an identical pipeline result as a no-op (no replaceAll thrash)", () => {
    const messages = ["x".repeat(800)];
    const provider = new FakeHistoryProvider(messages);
    const { pipeline, calls } = makeSpyPipeline((input) => [...input]);
    const result = beforeModel({ provider, pipeline, tokenBudget: 10 });

    expect(calls).toHaveLength(1);
    expect(provider.replaceAllCalls).toHaveLength(0);
    expect(result.compacted).toBe(false);
    expect(result.messages).toEqual(messages);
  });

  it("honors a custom estimator to force over/under budget", () => {
    const forceOver: TokenEstimator = () => 10_000;
    const forceUnder: TokenEstimator = () => 1;

    const overProvider = new FakeHistoryProvider(["tiny"]);
    const { pipeline: overPipeline, calls: overCalls } = makeSpyPipeline(() => ["shrunk"]);
    const overResult = beforeModel({ provider: overProvider, pipeline: overPipeline, tokenBudget: 100, estimator: forceOver });
    expect(overCalls).toHaveLength(1);
    expect(overResult.compacted).toBe(true);

    const underProvider = new FakeHistoryProvider(["x".repeat(100_000)]);
    const { pipeline: underPipeline, calls: underCalls } = makeSpyPipeline(() => []);
    const underResult = beforeModel({ provider: underProvider, pipeline: underPipeline, tokenBudget: 100, estimator: forceUnder });
    expect(underCalls).toHaveLength(0);
    expect(underResult.compacted).toBe(false);
    expect(underResult.tokensBefore).toBe(1);
  });

  it("reads result.messages back from the provider's new contents after compaction", () => {
    const provider = new FakeHistoryProvider(["a".repeat(400), "b".repeat(400)]);
    const { pipeline } = makeSpyPipeline(() => ["fresh-1", "fresh-2"]);
    const result = beforeModel({ provider, pipeline, tokenBudget: 50 });

    expect(result.compacted).toBe(true);
    expect(result.messages).toEqual(provider.list());
    expect(result.messages).toEqual(["fresh-1", "fresh-2"]);
  });
});

describe("estimateHistoryTokens", () => {
  it("rounds up per message and gives empty messages zero tokens", () => {
    expect(estimateHistoryTokens([])).toBe(0);
    expect(estimateHistoryTokens(["abcd"])).toBe(1);
    expect(estimateHistoryTokens(["abcde"])).toBe(2);
    expect(estimateHistoryTokens(["", "abcd"])).toBe(1);
    expect(estimateHistoryTokens(["a", "b"])).toBe(2);
  });
});

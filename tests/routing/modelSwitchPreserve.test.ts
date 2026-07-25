import { describe, expect, it } from "vitest";

import { AgentSession, type AgentSessionDeps, type TurnRunner } from "../../src/session/agentSession.js";
import type { AgentTurnResult } from "../../src/model/agentTurn.js";
import {
  switchModel,
  accumulateUsageMap,
  totalTokens,
  snapshotBaseline,
  ZERO_BASELINE,
  type ModelUsageBucket,
  type SessionStatsBaseline,
} from "../../src/routing/modelSwitchPreserve.js";
import {
  ProviderRouteDescriptorSchema,
  type ProviderRouteDescriptor,
} from "../../src/providers/schemas.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function modelRoute(
  routeId: string,
  modelId: string,
  over: Record<string, unknown> = {},
): ProviderRouteDescriptor {
  return ProviderRouteDescriptorSchema.parse({
    providerId: "stub",
    routeId,
    modelId,
    routeType: "direct-api",
    apiFamily: "openai-chat-completions",
    status: "active",
    directFirstRank: 0,
    allowedRouterFallback: false,
    capabilities: { supportsTools: true },
    context: { contextWindowTokens: 128_000 },
    ...over,
  });
}

const routeA = modelRoute("stub/model-a", "model-a");
const routeB = modelRoute("stub/model-b", "model-b");
const routeC = modelRoute("stub/model-c", "model-c");

const EMPTY_MANDATE = { grants: [], denies: [] } as never;

const RUNTIME = {
  executeTool: async () =>
    ({ toolId: "read", status: "succeeded", startedAt: "t", endedAt: "t", durationMs: 0 }) as never,
} as never;

function stubRunner(over: {
  text?: string;
  usage?: { inputTokens: number; outputTokens: number; lastRequestInputTokens: number };
} = {}): TurnRunner {
  return (async (_route, _messages, _options) => {
    const result: AgentTurnResult = {
      text: over.text ?? "ok",
      modelId: _route.modelId,
      routeId: _route.routeId,
      apiFamily: "openai-chat-completions",
      toolCallCount: 0,
      toolEvents: [],
      ...(over.usage ? { usage: over.usage } : {}),
    };
    return result;
  }) as TurnRunner;
}

function makeSession(
  route: ProviderRouteDescriptor,
  over: Partial<AgentSessionDeps> = {},
): AgentSession {
  return new AgentSession({
    runtime: RUNTIME,
    route,
    sessionTools: [],
    mandate: EMPTY_MANDATE,
    runTurn: stubRunner(),
    now: () => new Date(Date.UTC(2026, 6, 5)),
    ...over,
  });
}

/** Seed messages into the session history. */
function seedMessages(session: AgentSession, count: number): void {
  for (let i = 0; i < count; i += 1) {
    session.history.push({ role: "user", content: `question ${i + 1}` });
    session.history.push({ role: "assistant", content: `answer ${i + 1}` });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("switchModel", () => {
  it("returns the prior model id and the new model id", () => {
    const session = makeSession(routeA);
    const { result } = switchModel(session, routeB, ZERO_BASELINE);

    expect(result.previousModelId).toBe("model-a");
    expect(result.currentModelId).toBe("model-b");
  });

  it("freezes per-model usage delta at the moment of switch", async () => {
    const session = makeSession(routeA);
    seedMessages(session, 2);
    await session.prompt("hello");

    const statsBefore = session.stats();
    const { result } = switchModel(session, routeB, ZERO_BASELINE);

    // Since baseline is ZERO, the delta equals the full cumulative stats.
    expect(result.frozenUsage.modelId).toBe("model-a");
    expect(result.frozenUsage.inputTokens).toBe(statsBefore.inputTokens);
    expect(result.frozenUsage.outputTokens).toBe(statsBefore.outputTokens);
    expect(result.frozenUsage.turns).toBe(statsBefore.turns);
  });

  it("returns a new baseline for the next switch", async () => {
    const session = makeSession(routeA);
    await session.prompt("hello");
    const stats = session.stats();

    const { newBaseline } = switchModel(session, routeB, ZERO_BASELINE);

    expect(newBaseline.inputTokens).toBe(stats.inputTokens);
    expect(newBaseline.outputTokens).toBe(stats.outputTokens);
    expect(newBaseline.turns).toBe(stats.turns);
  });

  it("computes correct delta when baseline is non-zero", async () => {
    const session = makeSession(routeA);
    // Model-A: 1 turn.
    await session.prompt("turn on model-a");
    const statsAfterA = session.stats();

    // Switch A→B. Baseline is ZERO (fresh session). Frozen A = full stats.
    const { result: switchAB, newBaseline: afterAB } = switchModel(session, routeB, ZERO_BASELINE);
    expect(switchAB.frozenUsage.inputTokens).toBe(statsAfterA.inputTokens);

    // Model-B: 1 turn.
    await session.prompt("turn on model-b");
    const statsAfterB = session.stats();

    // Switch B→C. Baseline is afterAB (stats at the moment B was activated).
    const { result: switchBC } = switchModel(session, routeC, afterAB);

    // B's frozen usage should be: statsAfterB - afterAB (only B's consumption).
    expect(switchBC.frozenUsage.modelId).toBe("model-b");
    expect(switchBC.frozenUsage.inputTokens).toBe(statsAfterB.inputTokens - afterAB.inputTokens);
    expect(switchBC.frozenUsage.outputTokens).toBe(statsAfterB.outputTokens - afterAB.outputTokens);
    // Turns always increment via prompt(); reliably shows per-model isolation.
    expect(switchBC.frozenUsage.turns).toBe(statsAfterB.turns - afterAB.turns);
    // Cumulative turns after B is 2 (A:1 + B:1); B's delta must be exactly 1.
    expect(switchBC.frozenUsage.turns).toBe(1);
    expect(switchBC.frozenUsage.turns).toBeLessThan(statsAfterB.turns);
  });

  it("preserves all conversation messages across switch", () => {
    const session = makeSession(routeA);
    seedMessages(session, 3);
    const messagesBefore = [...session.history];

    switchModel(session, routeB, ZERO_BASELINE);

    expect(session.history).toEqual(messagesBefore);
    expect(session.history.length).toBe(6); // 3 user + 3 assistant
    expect(session.activeRoute.modelId).toBe("model-b");
  });

  it("preserves messages and switches correctly when switching again", () => {
    const session = makeSession(routeA);
    seedMessages(session, 2);
    const messagesBefore = [...session.history];

    switchModel(session, routeB, ZERO_BASELINE);
    expect(session.activeRoute.modelId).toBe("model-b");
    expect(session.history).toEqual(messagesBefore);

    switchModel(session, routeC, ZERO_BASELINE);
    expect(session.activeRoute.modelId).toBe("model-c");
    expect(session.history).toEqual(messagesBefore);
  });

  it("preserves a system prompt across model switch", () => {
    const session = makeSession(routeA, { systemPrompt: "You are a helpful assistant." });
    const messagesBefore = [...session.history];
    expect(messagesBefore[0]?.role).toBe("system");

    switchModel(session, routeB, ZERO_BASELINE);
    expect(session.history).toEqual(messagesBefore);
    expect(session.activeRoute.modelId).toBe("model-b");
  });

  it("preserves an empty history across switch", () => {
    const session = makeSession(routeA);
    expect(session.history.length).toBe(0);

    const { result } = switchModel(session, routeB, ZERO_BASELINE);
    expect(result.previousModelId).toBe("model-a");
    expect(result.currentModelId).toBe("model-b");
    expect(session.history.length).toBe(0);
  });

  it("returns zero usage for a fresh session with no turns", () => {
    const session = makeSession(routeA);
    const { result } = switchModel(session, routeB, ZERO_BASELINE);

    expect(result.frozenUsage).toEqual({
      modelId: "model-a",
      inputTokens: 0,
      outputTokens: 0,
      turns: 0,
    });
  });

  it("activeRoute reflects the new route after switch", () => {
    const session = makeSession(routeA);
    switchModel(session, routeB, ZERO_BASELINE);

    const active = session.activeRoute;
    expect(active.routeId).toBe("stub/model-b");
    expect(active.modelId).toBe("model-b");
  });
});

describe("snapshotBaseline", () => {
  it("captures current cumulative stats", () => {
    const session = makeSession(routeA);
    const snap = snapshotBaseline(session);
    expect(snap).toEqual({ inputTokens: 0, outputTokens: 0, turns: 0 });
  });

  it("equals ZERO_BASELINE for a fresh session", () => {
    const session = makeSession(routeA);
    expect(snapshotBaseline(session)).toEqual(ZERO_BASELINE);
  });
});

describe("accumulateUsageMap", () => {
  it("includes the current session delta under its active model id", () => {
    const session = makeSession(routeA);
    const map = accumulateUsageMap([], session, ZERO_BASELINE);

    expect(map["model-a"]).toBeDefined();
    expect(map["model-a"]?.modelId).toBe("model-a");
    // Fresh session with no turns → delta is zero.
    expect(map["model-a"]?.turns).toBe(0);
  });

  it("merges prior buckets with current session delta", () => {
    const session = makeSession(routeB);
    const prior: ModelUsageBucket[] = [
      { modelId: "model-a", inputTokens: 500, outputTokens: 300, turns: 3 },
    ];

    const map = accumulateUsageMap(prior, session, ZERO_BASELINE);

    // Prior bucket preserved exactly.
    expect(map["model-a"]).toEqual(prior[0]);
    expect(map["model-b"]).toBeDefined();
    expect(map["model-b"]?.modelId).toBe("model-b");
  });

  it("adds to prior when switched back to the same model", async () => {
    const session = makeSession(routeA);
    await session.prompt("first turn on model-a");

    // Switch A→B. Freeze model-a usage delta.
    const { result: switchAB, newBaseline } = switchModel(session, routeB, ZERO_BASELINE);

    // Run a turn on model-b.
    await session.prompt("turn on model-b");

    // Switch B→A. Freeze model-b usage delta.
    const { result: switchBA, newBaseline: baselineAfterBA } = switchModel(session, routeA, newBaseline);

    // Run another turn on model-a.
    await session.prompt("second turn on model-a");

    // Accumulate: prior buckets are A's first delta + B's delta.
    // Current model is A again, with baseline = stats when A was reactivated.
    const map = accumulateUsageMap(
      [switchAB.frozenUsage, switchBA.frozenUsage],
      session,
      baselineAfterBA,
    );

    // Model-a total = first delta (from switchAB) + current delta (since switchBA).
    expect(map["model-a"]).toBeDefined();
    expect(map["model-a"]!.inputTokens).toBe(
      switchAB.frozenUsage.inputTokens + (session.stats().inputTokens - baselineAfterBA.inputTokens),
    );
    // Model-b is just its own delta from the A→B period.
    expect(map["model-b"]).toBeDefined();
    expect(map["model-b"]!.inputTokens).toBe(switchBA.frozenUsage.inputTokens);
  });

  it("accumulates across multiple prior buckets", () => {
    const session = makeSession(routeC);
    const prior: ModelUsageBucket[] = [
      { modelId: "model-a", inputTokens: 100, outputTokens: 50, turns: 1 },
      { modelId: "model-b", inputTokens: 300, outputTokens: 150, turns: 2 },
    ];

    const map = accumulateUsageMap(prior, session, ZERO_BASELINE);

    expect(Object.keys(map).sort()).toEqual(["model-a", "model-b", "model-c"]);
    expect(map["model-a"]?.inputTokens).toBe(100);
    expect(map["model-b"]?.inputTokens).toBe(300);
    expect(map["model-c"]).toBeDefined();
  });

  it("handles an empty prior array", () => {
    const session = makeSession(routeA);
    const map = accumulateUsageMap([], session, ZERO_BASELINE);

    expect(Object.keys(map)).toEqual(["model-a"]);
  });

  it("freezes prior usage — later turns on current don't affect prior totals", async () => {
    const session = makeSession(routeA);
    seedMessages(session, 1);
    await session.prompt("turn 1");

    // Switch to model-b, freezing model-a's usage delta.
    const { result: switch1, newBaseline } = switchModel(session, routeB, ZERO_BASELINE);
    const frozenA = switch1.frozenUsage;

    // Run turns on model-b (would change current stats, not prior).
    await session.prompt("turn on model-b");

    const map = accumulateUsageMap([frozenA], session, newBaseline);

    // Prior frozen bucket for model-a should match what was frozen at switch time.
    expect(map["model-a"]?.inputTokens).toBe(frozenA.inputTokens);
    expect(map["model-a"]?.outputTokens).toBe(frozenA.outputTokens);
    expect(map["model-a"]?.turns).toBe(frozenA.turns);
    // Current model-b should reflect its own delta since the switch.
    expect(map["model-b"]).toBeDefined();
    expect(map["model-b"]!.turns).toBeGreaterThanOrEqual(1);
  });
});

describe("ZERO_BASELINE", () => {
  it("is a frozen baseline with all zeros", () => {
    expect(ZERO_BASELINE).toEqual({ inputTokens: 0, outputTokens: 0, turns: 0 });
  });
});

describe("totalTokens", () => {
  it("sums input and output tokens across all models", () => {
    const map = {
      "model-a": { modelId: "model-a", inputTokens: 100, outputTokens: 50, turns: 1 },
      "model-b": { modelId: "model-b", inputTokens: 300, outputTokens: 150, turns: 2 },
    };

    const totals = totalTokens(map);
    expect(totals.inputTokens).toBe(400);
    expect(totals.outputTokens).toBe(200);
  });

  it("returns zero for an empty map", () => {
    const totals = totalTokens({});
    expect(totals.inputTokens).toBe(0);
    expect(totals.outputTokens).toBe(0);
  });

  it("returns zero for buckets with zero tokens", () => {
    const map = {
      "model-a": { modelId: "model-a", inputTokens: 0, outputTokens: 0, turns: 0 },
    };

    const totals = totalTokens(map);
    expect(totals.inputTokens).toBe(0);
    expect(totals.outputTokens).toBe(0);
  });
});

describe("end-to-end: model switch lifecycle", () => {
  it("tracks usage per model across multiple switches without dropping history", async () => {
    // Session starts on model-a.
    const session = makeSession(routeA);
    seedMessages(session, 1);
    await session.prompt("turn on model-a");
    const messagesBefore = [...session.history];

    // Switch to model-b — freeze model-a usage delta (baseline = ZERO).
    const { result: switchAB, newBaseline: blAB } = switchModel(session, routeB, ZERO_BASELINE);
    expect(switchAB.previousModelId).toBe("model-a");
    expect(session.activeRoute.modelId).toBe("model-b");

    // Continue conversation on model-b.
    seedMessages(session, 1);
    await session.prompt("turn on model-b");

    // Switch to model-c — freeze model-b usage delta (baseline = when B started).
    const { result: switchBC, newBaseline: blBC } = switchModel(session, routeC, blAB);
    expect(switchBC.previousModelId).toBe("model-b");
    expect(session.activeRoute.modelId).toBe("model-c");

    // Run a turn on model-c.
    await session.prompt("turn on model-c");

    // Messages must all still be present.
    const allMessages = [...session.history];
    for (let i = 0; i < messagesBefore.length; i += 1) {
      expect(allMessages[i]).toEqual(messagesBefore[i]);
    }
    expect(allMessages.length).toBeGreaterThan(messagesBefore.length);

    // Build the full usage map across all three models.
    const map = accumulateUsageMap(
      [switchAB.frozenUsage, switchBC.frozenUsage],
      session,
      blBC,
    );

    expect(map["model-a"]).toBeDefined();
    expect(map["model-b"]).toBeDefined();
    expect(map["model-c"]).toBeDefined();

    // model-a usage should match its frozen delta (baseline was ZERO → delta = full A).
    expect(map["model-a"]?.inputTokens).toBe(switchAB.frozenUsage.inputTokens);
    // model-b usage should match its frozen delta.
    expect(map["model-b"]?.inputTokens).toBe(switchBC.frozenUsage.inputTokens);
    // model-c usage should be the delta since blBC.
    expect(map["model-c"]?.inputTokens).toBe(
      session.stats().inputTokens - blBC.inputTokens,
    );
  });

  it("switching back to a prior model accumulates usage correctly", async () => {
    const session = makeSession(routeA);
    seedMessages(session, 1);
    await session.prompt("turn 1 on model-a");

    // Switch A→B. Freeze model-a delta. Baseline = ZERO.
    const { result: switchAB, newBaseline: blAB } = switchModel(session, routeB, ZERO_BASELINE);
    seedMessages(session, 1);
    await session.prompt("turn on model-b");

    // Switch B→A. Freeze model-b delta. Baseline = stats when B was activated.
    const { result: switchBA, newBaseline: blBA } = switchModel(session, routeA, blAB);

    // Run another turn on model-a.
    seedMessages(session, 1);
    await session.prompt("turn 2 on model-a");

    // Usage map: prior = A's first delta + B's delta. Current A on blBA baseline.
    const map = accumulateUsageMap(
      [switchAB.frozenUsage, switchBA.frozenUsage],
      session,
      blBA,
    );

    // Model-a total = first A stint + second A stint.
    const secondADelta = session.stats().inputTokens - blBA.inputTokens;
    expect(map["model-a"]?.inputTokens).toBe(
      switchAB.frozenUsage.inputTokens + secondADelta,
    );
    // Model-b should be its frozen delta only.
    expect(map["model-b"]).toBeDefined();
    expect(map["model-b"]?.inputTokens).toBe(switchBA.frozenUsage.inputTokens);

    // Grand total should match cumulative session stats.
    const totals = totalTokens(map);
    expect(totals.inputTokens).toBe(session.stats().inputTokens);
    expect(totals.outputTokens).toBe(session.stats().outputTokens);
  });

  it("grand total matches cumulative stats after any switch sequence", async () => {
    const session = makeSession(routeA);
    const buckets: ModelUsageBucket[] = [];
    let baseline: SessionStatsBaseline = ZERO_BASELINE;

    // A: 2 turns → B: 1 turn → C: 1 turn → back to A: 1 turn.
    await session.prompt("A-1");
    await session.prompt("A-2");

    ({ result: { frozenUsage: buckets[0]! }, newBaseline: baseline } = switchModel(session, routeB, baseline));

    await session.prompt("B-1");

    ({ result: { frozenUsage: buckets[1]! }, newBaseline: baseline } = switchModel(session, routeC, baseline));

    await session.prompt("C-1");

    ({ result: { frozenUsage: buckets[2]! }, newBaseline: baseline } = switchModel(session, routeA, baseline));

    await session.prompt("A-3");

    const map = accumulateUsageMap(buckets, session, baseline);
    const totals = totalTokens(map);

    // Total across all models must equal cumulative session stats.
    expect(totals.inputTokens).toBe(session.stats().inputTokens);
    expect(totals.outputTokens).toBe(session.stats().outputTokens);
  });
});

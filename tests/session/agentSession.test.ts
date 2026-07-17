import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentSession, type AgentSessionDeps, type TurnRunner } from "../../src/session/agentSession.js";
import type { SummarizeRequest } from "../../src/compaction/engine.js";
import type { ChatTurnMessage } from "../../src/model/directChat.js";
import { createFileMemoryStore } from "../../src/memory/store.js";
import type { AgentTurnResult } from "../../src/model/agentTurn.js";
import { ProviderRouteDescriptorSchema, type ProviderRouteDescriptor } from "../../src/providers/schemas.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function modelRoute(
  routeId: string,
  modelId: string,
  over: Record<string, unknown> = {}
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
    ...over
  });
}

const route = modelRoute("stub/model", "m");
const session = (repoRoot?: string) => ({ id: "s1", repo: repoRoot ? { repoRoot } : null, tools: [] }) as never;
const EMPTY_MANDATE = { grants: [], denies: [] } as never;

/** A stub turn runner: echoes a fixed reply, optionally streams tokens + a tool event. */
function stubRunner(over: { text?: string; tokens?: string[]; toolEvent?: { toolId: string; status: "succeeded" | "failed" }; approveInput?: unknown; captureApprove?: (toolId: string, allowed: boolean) => void } = {}): TurnRunner {
  return (async (_route, _messages, options) => {
    for (const chunk of over.tokens ?? []) options.onToken?.(chunk);
    if (over.toolEvent) {
      const allowed = await options.approveTool(over.toolEvent.toolId, over.approveInput ?? { path: "x" });
      over.captureApprove?.(over.toolEvent.toolId, allowed);
      options.onToolEvent?.({ toolId: over.toolEvent.toolId, status: over.toolEvent.status });
    }
    const result: AgentTurnResult = { text: over.text ?? "ok", modelId: "m", routeId: "stub/model", apiFamily: "openai-chat-completions", toolCallCount: over.toolEvent ? 1 : 0, toolEvents: [] };
    return result;
  }) as TurnRunner;
}

function makeSession(over: Partial<AgentSessionDeps> = {}): AgentSession {
  return new AgentSession({
    runtime: { executeTool: async () => ({ toolId: "read", status: "succeeded", startedAt: "t", endedAt: "t", durationMs: 0 }) } as never,
    route,
    session: session(),
    sessionTools: [],
    mandate: EMPTY_MANDATE,
    runTurn: stubRunner(),
    now: () => new Date(Date.UTC(2026, 6, 5)),
    ...over
  });
}

const ENABLED_COMPACTION = {
  enabled: true,
  reserveTokens: 1_000,
  keepRecentTokens: 130,
  summaryMaxTokens: 256
} as const;

function seedCompactableHistory(target: AgentSession): void {
  for (let index = 0; index < 3; index += 1) {
    target.history.push(
      { role: "user", content: `question-${index}-${"q".repeat(220)}` },
      { role: "assistant", content: `answer-${index}-${"a".repeat(220)}` }
    );
  }
}

describe("AgentSession — the turn engine", () => {
  it("ACCEPTANCE: prompt() runs a turn, appends user+assistant, advances stats", async () => {
    const s = makeSession({ runTurn: stubRunner({ text: "hello there" }), systemPrompt: "SYS" });
    const result = await s.prompt("hi");
    expect(result.text).toBe("hello there");
    expect(s.history.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    expect(s.history[1]?.content).toBe("hi");
    expect(s.history[2]?.content).toBe("hello there");
    expect(s.stats().turns).toBe(1);
  });

  it("deterministic pass-through: the token stream + final text are exactly the runner's (byte-identical)", async () => {
    const chunks: string[] = [];
    const s = makeSession({ runTurn: stubRunner({ text: "abc", tokens: ["a", "b", "c"] }) });
    s.subscribe("token", (p) => chunks.push(p.chunk));
    const result = await s.prompt("go");
    expect(chunks.join("")).toBe("abc");
    expect(result.text).toBe("abc");
  });

  it("emits typed lifecycle events in order", async () => {
    const events: string[] = [];
    const s = makeSession({ runTurn: stubRunner({ text: "done", toolEvent: { toolId: "read", status: "succeeded" } }) });
    s.subscribe("turn.start", () => events.push("start"));
    s.subscribe("tool.observation", (e) => events.push(`tool:${e.toolId}`));
    s.subscribe("turn.stop", () => events.push("stop"));
    s.subscribe("done.packet", () => events.push("done"));
    await s.prompt("x");
    expect(events).toEqual(["start", "tool:read", "stop", "done"]);
  });

  it("approveTool routes through the mandate: read-only allowed, ungated write denied unless writesAllowed", async () => {
    const decisions: Record<string, boolean> = {};
    const capture = (toolId: string, allowed: boolean) => { decisions[toolId] = allowed; };
    await makeSession({ runTurn: stubRunner({ toolEvent: { toolId: "read", status: "succeeded" }, captureApprove: capture }) }).prompt("a");
    expect(decisions.read).toBe(true); // read-only floor
    await makeSession({ writesAllowed: false, runTurn: stubRunner({ toolEvent: { toolId: "write", status: "failed" }, captureApprove: capture }) }).prompt("b");
    expect(decisions.write).toBe(false); // escalate → writesAllowed false
    await makeSession({ writesAllowed: true, runTurn: stubRunner({ toolEvent: { toolId: "write", status: "succeeded" }, captureApprove: capture }) }).prompt("c");
    expect(decisions.write).toBe(true); // escalate → writesAllowed true
  });

  it("F2 (fail-open fix): a HARD-EDGE escalate is DENIED even with writesAllowed:true — never auto-approved by a session grant", async () => {
    const decisions: Record<string, boolean> = {};
    const capture = (toolId: string, allowed: boolean) => {
      decisions[toolId] = allowed;
    };
    // a write to a SECRET path (.env) is a hard edge — writesAllowed must NOT approve it (§3).
    await makeSession({
      writesAllowed: true,
      runTurn: stubRunner({ toolEvent: { toolId: "write", status: "failed" }, approveInput: { path: ".env" }, captureApprove: capture })
    }).prompt("hard");
    expect(decisions.write).toBe(false);
  });

  it("PRESERVE-DON'T-REPLACE holds on the ENGINE path: a gutting edit is denied even with writesAllowed:true", async () => {
    const decisions: Record<string, boolean> = {};
    const capture = (toolId: string, allowed: boolean) => {
      decisions[toolId] = allowed;
    };
    const original = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    // Gutting: 30 lines -> 2 (net -28 >= threshold, survivor < half) escalates to
    // destructive-class, and the engine default has no interactive double-check,
    // so it must deny — writesAllowed and standing grants notwithstanding.
    await makeSession({
      writesAllowed: true,
      runTurn: stubRunner({
        toolEvent: { toolId: "edit", status: "failed" },
        approveInput: { oldText: original, newText: "line 0\nline 1" },
        captureApprove: capture
      })
    }).prompt("gut");
    expect(decisions.edit).toBe(false);

    // A modest trim (30 -> 25 lines) is NOT a gutting; writesAllowed still works.
    await makeSession({
      writesAllowed: true,
      runTurn: stubRunner({
        toolEvent: { toolId: "edit", status: "succeeded" },
        approveInput: { oldText: original, newText: Array.from({ length: 25 }, (_, i) => `line ${i}`).join("\n") },
        captureApprove: capture
      })
    }).prompt("trim");
    expect(decisions.edit).toBe(true);
  });

  it("rejects overlapping turns: a second prompt() throws, history stays clean, abort still reaches the running turn", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const blockedRunner: TurnRunner = (async () => {
      await gate;
      const result: AgentTurnResult = { text: "first done", modelId: "m", routeId: "stub/model", apiFamily: "openai-chat-completions", toolCallCount: 0, toolEvents: [] };
      return result;
    }) as TurnRunner;
    const s = makeSession({ runTurn: blockedRunner });

    const first = s.prompt("one");
    await expect(s.prompt("two")).rejects.toThrow(/already running/);
    // The rejected prompt must not leave a dangling user message.
    expect(s.history.filter((message) => message.role === "user")).toHaveLength(1);
    // The RUNNING turn stays abortable (the old overlap clobbered its controller).
    expect(s.abort()).toBe(true);
    release();
    await first;
    // The finished turn released the busy sentinel — the session is reusable.
    const again = await s.prompt("three");
    expect(again.text).toBe("first done");
  });
});

describe("AgentSession — driveTurn (the TUI seam, v0.18b)", () => {
  it("runs the turn on the DRIVER's history, pushes the assistant there, calls onAssistant + render hooks", async () => {
    const history = [{ role: "user" as const, content: "already pushed by the TUI" }];
    const tokens: string[] = [];
    let assistantSeen = "";
    const s = makeSession({ runTurn: stubRunner({ text: "reply", tokens: ["re", "ply"] }) });
    const result = await s.driveTurn({
      getHistory: () => history,
      onToken: (chunk) => tokens.push(chunk),
      onAssistant: (content) => { assistantSeen = content; }
    });
    expect(result.text).toBe("reply");
    expect(history[history.length - 1]).toEqual({ role: "assistant", content: "reply" });
    expect(tokens.join("")).toBe("reply");
    expect(assistantSeen).toBe("reply");
  });

  it("uses the driver's tool/executeTool/approveTool + prepareMessages overrides (the REPL's exact behavior)", async () => {
    let sentCount = -1;
    let approvedVia = "";
    const history = [{ role: "system" as const, content: "s" }, { role: "user" as const, content: "u" }];
    const runner: TurnRunner = (async (_r, messages, options) => {
      sentCount = messages.length;
      approvedVia = options.approveTool("write", { path: "x" }) ? "driver-allow" : "driver-deny";
      return { text: "done", modelId: "m", routeId: "stub/model", apiFamily: "openai-chat-completions", toolCallCount: 0, toolEvents: [] };
    }) as TurnRunner;
    const s = makeSession({ runTurn: runner });
    await s.driveTurn({
      getHistory: () => history,
      prepareMessages: (h) => h.slice(-1), // window to just the last message
      approveTool: () => true // the driver's own policy
    });
    expect(sentCount).toBe(1); // prepareMessages windowed 2 → 1
    expect(approvedVia).toBe("driver-allow"); // driver's approveTool used, not the mandate default
  });

  it("prompt() is driveTurn with the default driver — behavior unchanged (contract intact)", async () => {
    const s = makeSession({ runTurn: stubRunner({ text: "z" }) });
    await s.prompt("hey");
    expect(s.history.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(s.stats().turns).toBe(1);
  });
});

describe("AgentSession — active route switching", () => {
  it("uses the selected route, context budget, and tool capability on the next default turn", async () => {
    const repoRoot = join(tmpdir(), `guru-as-route-${process.pid}-${dirs.length}`);
    dirs.push(repoRoot);
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(join(repoRoot, "note.txt"), "ROUTE-CONTEXT-SENTINEL".repeat(16), "utf8");
    const selected = modelRoute("stub/selected", "selected-model", {
      capabilities: { supportsTools: false },
      context: { contextWindowTokens: 16 }
    });
    let seenRoute: ProviderRouteDescriptor | undefined;
    let seenPrompt = "";
    let seenToolIds: readonly string[] = [];
    const runner: TurnRunner = (async (turnRoute, messages, options) => {
      seenRoute = turnRoute;
      seenPrompt = messages.at(-1)?.content ?? "";
      seenToolIds = options.tools.map((tool) => tool.id);
      return {
        text: "selected reply",
        modelId: turnRoute.modelId,
        routeId: turnRoute.routeId,
        apiFamily: turnRoute.apiFamily ?? "openai-chat-completions",
        toolCallCount: 0,
        toolEvents: []
      } satisfies AgentTurnResult;
    }) as TurnRunner;
    const s = makeSession({
      session: session(repoRoot),
      sessionTools: [{ id: "read" } as never],
      runTurn: runner
    });

    expect(s.switchRoute(selected)).toEqual({
      previous: { routeId: "stub/model", modelId: "m" },
      current: { routeId: "stub/selected", modelId: "selected-model" }
    });
    expect(s.activeRoute).toBe(selected);
    expect(s.stats().contextWindowTokens).toBe(16);

    await s.prompt("inspect @note.txt");
    expect(seenRoute).toBe(selected);
    expect(seenPrompt).toBe("inspect @note.txt");
    expect(seenPrompt).not.toContain("ROUTE-CONTEXT-SENTINEL");
    expect(seenToolIds).toEqual([]);
  });

  it("drops a constructor model override when an exact route is selected", async () => {
    const selected = modelRoute("stub/selected", "selected-model");
    const seen: Array<{ routeId: string; routeModelId: string; modelIdOverride: string | undefined }> = [];
    const runner: TurnRunner = (async (turnRoute, _messages, options) => {
      seen.push({
        routeId: turnRoute.routeId,
        routeModelId: turnRoute.modelId,
        modelIdOverride: options.modelIdOverride
      });
      return {
        text: `reply:${turnRoute.routeId}`,
        modelId: options.modelIdOverride ?? turnRoute.modelId,
        routeId: turnRoute.routeId,
        apiFamily: turnRoute.apiFamily ?? "openai-chat-completions",
        toolCallCount: 0,
        toolEvents: []
      } satisfies AgentTurnResult;
    }) as TurnRunner;
    const s = makeSession({ modelIdOverride: "legacy-initial-override", runTurn: runner });

    await s.prompt("before switch");
    s.switchRoute(selected);
    await s.prompt("after switch");

    expect(seen).toEqual([
      { routeId: "stub/model", routeModelId: "m", modelIdOverride: "legacy-initial-override" },
      { routeId: "stub/selected", routeModelId: "selected-model", modelIdOverride: undefined }
    ]);
  });

  it("preserves history, usage, queues, listeners, garage state, runtime session, tools, and mandate state", async () => {
    const directory = join(tmpdir(), `guru-as-route-memory-${process.pid}-${dirs.length}`);
    dirs.push(directory);
    mkdirSync(directory, { recursive: true });
    const memory = createFileMemoryStore({ directory, now: () => new Date(Date.UTC(2026, 6, 5)) });
    const selected = modelRoute("stub/preserved", "preserved-model", { context: { contextWindowTokens: 64_000 } });
    const runtimeSessionIds: string[] = [];
    const toolIdsByTurn: string[][] = [];
    const mandateDecisions: boolean[] = [];
    const runtime = {
      executeTool: async (sessionId: string, toolId: string) => {
        runtimeSessionIds.push(`${sessionId}:${toolId}`);
        return { toolId, status: "succeeded", startedAt: "t", endedAt: "t", durationMs: 0 };
      }
    } as never;
    const runner: TurnRunner = (async (turnRoute, _messages, options) => {
      toolIdsByTurn.push(options.tools.map((tool) => tool.id));
      mandateDecisions.push(await options.approveTool("read", { path: "README.md" }));
      await options.executeTool("read", { path: "README.md" });
      return {
        text: `reply:${turnRoute.routeId}`,
        modelId: turnRoute.modelId,
        routeId: turnRoute.routeId,
        apiFamily: turnRoute.apiFamily ?? "openai-chat-completions",
        toolCallCount: 0,
        toolEvents: [],
        usage: { inputTokens: 7, outputTokens: 3, lastRequestInputTokens: 5 }
      } satisfies AgentTurnResult;
    }) as TurnRunner;
    const s = makeSession({
      runtime,
      session: { id: "preserved-session", repo: null, tools: [] } as never,
      sessionTools: [{ id: "read" } as never],
      memory,
      runTurn: runner
    });
    expect(s.suitUp("preserved suit").suit?.slug).toBe("preserved-suit");
    await s.prompt("before switch");
    s.followUp("still queued");
    let donePackets = 0;
    s.subscribe("done.packet", () => { donePackets += 1; });
    const historyRef = s.history;
    const historyBefore = structuredClone(s.history);
    const queueBefore = s.queueDepth();
    const { contextWindowTokens: _oldContext, ...usageBefore } = s.stats();

    s.switchRoute(selected);

    expect(s.history).toBe(historyRef);
    expect(s.history).toEqual(historyBefore);
    const { contextWindowTokens: newContext, ...usageAfter } = s.stats();
    expect(usageAfter).toEqual(usageBefore);
    expect(newContext).toBe(64_000);
    expect(s.queueDepth()).toBe(queueBefore);
    expect(s.park()).not.toBeNull();

    await s.prompt("after switch");
    expect(donePackets).toBe(1);
    expect(runtimeSessionIds).toEqual(["preserved-session:read", "preserved-session:read"]);
    expect(toolIdsByTurn).toEqual([["read"], ["read"]]);
    expect(mandateDecisions).toEqual([true, true]);
    expect(s.queueDepth()).toBe(queueBefore);
  });

  it("rejects a route switch while a turn is active without mutating route, history, or usage", async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const seenRoutes: string[] = [];
    const runner: TurnRunner = (async (turnRoute) => {
      seenRoutes.push(turnRoute.routeId);
      markStarted();
      await gate;
      return {
        text: "done",
        modelId: turnRoute.modelId,
        routeId: turnRoute.routeId,
        apiFamily: turnRoute.apiFamily ?? "openai-chat-completions",
        toolCallCount: 0,
        toolEvents: []
      } satisfies AgentTurnResult;
    }) as TurnRunner;
    const s = makeSession({ runTurn: runner });
    const running = s.prompt("slow turn");
    await started;
    const historyBefore = structuredClone(s.history);
    const statsBefore = s.stats();

    expect(() => s.switchRoute(modelRoute("stub/rejected", "rejected-model"))).toThrow(/running|active|busy/i);
    expect(s.activeRoute).toBe(route);
    expect(s.history).toEqual(historyBefore);
    expect(s.stats()).toEqual(statsBefore);

    release();
    await running;
    expect(seenRoutes).toEqual(["stub/model"]);
  });

  it("keeps a driver route override one-turn-only and returns to the selected route", async () => {
    const selected = modelRoute("stub/selected", "selected-model", { context: { contextWindowTokens: 64_000 } });
    const override = modelRoute("stub/override", "override-model", { context: { contextWindowTokens: 32_000 } });
    const seenRoutes: string[] = [];
    const runner: TurnRunner = (async (turnRoute) => {
      seenRoutes.push(turnRoute.routeId);
      return {
        text: `reply:${turnRoute.routeId}`,
        modelId: turnRoute.modelId,
        routeId: turnRoute.routeId,
        apiFamily: turnRoute.apiFamily ?? "openai-chat-completions",
        toolCallCount: 0,
        toolEvents: []
      } satisfies AgentTurnResult;
    }) as TurnRunner;
    const s = makeSession({ runTurn: runner });
    s.switchRoute(selected);

    await s.driveTurn({ route: override });
    expect(s.activeRoute).toBe(selected);
    expect(s.stats().contextWindowTokens).toBe(64_000);
    await s.prompt("default again");

    expect(seenRoutes).toEqual(["stub/override", "stub/selected"]);
    expect(s.activeRoute).toBe(selected);
  });
});

describe("AgentSession — steering + @-expansion", () => {
  it("steer() injects at the turn boundary; the injection is a system note before the user message", async () => {
    const s = makeSession();
    s.steer("focus on the parser");
    expect(s.queueDepth()).toBe(1);
    let injected = "";
    s.subscribe("steer.injected", (p) => { injected = `${p.kind}:${p.text}`; });
    await s.prompt("continue");
    expect(injected).toBe("steer:focus on the parser");
    const steerIdx = s.history.findIndex((m) => m.content.includes("[steering] focus on the parser"));
    const userIdx = s.history.findIndex((m) => m.content === "continue");
    expect(steerIdx).toBeGreaterThanOrEqual(0);
    expect(steerIdx).toBeLessThan(userIdx);
    expect(s.queueDepth()).toBe(0);
  });

  it("followUp() is drained separately for the driver to run when the agent stops", () => {
    const s = makeSession();
    s.followUp("now write the tests");
    s.steer("and be terse");
    expect(s.takeFollowUps()).toEqual(["now write the tests"]);
    expect(s.queueDepth()).toBe(1); // the steer remains
  });

  it("promptDrainingFollowUps() runs queued follow-ups after the primary prompt", async () => {
    const submitted: string[] = [];
    const runner: TurnRunner = (async (_r, messages) => {
      submitted.push(messages.at(-1)?.content ?? "");
      return { text: "done", modelId: "m", routeId: "stub/model", apiFamily: "openai-chat-completions", toolCallCount: 0, toolEvents: [] };
    }) as TurnRunner;
    const s = makeSession({ runTurn: runner });
    s.followUp("write the tests next");
    await s.promptDrainingFollowUps("ship it");
    expect(submitted).toEqual(["ship it", "write the tests next"]);
  });

  it("prompt() drains ONLY steers — follow_ups stay queued for takeFollowUps()", async () => {
    const s = makeSession({ runTurn: stubRunner({ text: "done" }) });
    s.followUp("write the tests next");
    s.steer("be terse");
    await s.prompt("ship it");
    // Steer was injected into history as a system line; follow-up is still waiting.
    expect(s.history.some((m) => m.role === "system" && m.content.includes("be terse"))).toBe(true);
    expect(s.history.some((m) => m.content.includes("write the tests next"))).toBe(false);
    expect(s.takeFollowUps()).toEqual(["write the tests next"]);
  });

  it("@-expansion inlines file contents into the submitted prompt when the session has a repo", async () => {
    const repoRoot = join(tmpdir(), `guru-as-${process.pid}-${dirs.length}`);
    dirs.push(repoRoot);
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(join(repoRoot, "note.txt"), "SENTINEL-CONTENT", "utf8");
    let seen = "";
    const runner: TurnRunner = (async (_r, messages) => {
      seen = messages[messages.length - 1]?.content ?? "";
      return { text: "ok", modelId: "m", routeId: "stub/model", apiFamily: "openai-chat-completions", toolCallCount: 0, toolEvents: [] };
    }) as TurnRunner;
    const s = makeSession({ session: session(repoRoot), runTurn: runner });
    await s.prompt("look at @note.txt");
    expect(seen).toContain("SENTINEL-CONTENT");
  });
});

describe("AgentSession — garage suitUp/park", () => {
  it("suitUp creates a new suit when none is parked, then park stores it with observed tools", async () => {
    const directory = join(tmpdir(), `guru-as-mem-${process.pid}-${dirs.length}`);
    dirs.push(directory);
    mkdirSync(directory, { recursive: true });
    const memory = createFileMemoryStore({ directory, now: () => new Date(Date.UTC(2026, 6, 5)) });
    const s = makeSession({ memory, runTurn: stubRunner({ toolEvent: { toolId: "git.pr.run", status: "succeeded" } }) });
    const worn = s.suitUp("finance reconciliation");
    expect(worn.created).toBe(true);
    expect(worn.suit?.slug).toBe("finance-reconciliation");
    await s.prompt("do the work"); // git.pr.run observed used
    const receipt = s.park();
    expect(receipt).not.toBeNull();
    expect(receipt?.stored).toBeGreaterThanOrEqual(1);
  });
});

describe("AgentSession — abort + mid-run steering (§17 scenario 13)", () => {
  const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it("abort() returns false when idle and true when a turn is running — and trips the signal", async () => {
    let seenAborted: boolean | null = null;
    const runner: TurnRunner = (async (_r, _m, options) => {
      await tick(); // yield so the test can abort mid-run
      seenAborted = options.signal?.aborted ?? null;
      return { text: "stopped", modelId: "m", routeId: "stub/model", apiFamily: "openai-chat-completions", toolCallCount: 0, toolEvents: [] };
    }) as TurnRunner;
    const s = makeSession({ runTurn: runner });
    expect(s.abort()).toBe(false); // nothing running yet

    let abortedEvent = 0;
    s.subscribe("aborted", () => { abortedEvent += 1; });
    const p = s.prompt("do a long thing");
    expect(s.abort()).toBe(true); // a turn is in flight → aborts it
    await p;
    expect(seenAborted).toBe(true); // the running turn saw the abort signal
    expect(abortedEvent).toBe(1);
    expect(s.abort()).toBe(false); // turn finished → idle again
  });

  it("steer() DURING a running turn is pulled mid-run (not deferred to the next turn)", async () => {
    let pulled: readonly string[] = [];
    const runner: TurnRunner = (async (_r, _m, options) => {
      await tick(); // the operator steers while we're 'working'
      pulled = options.pullSteering?.() ?? [];
      return { text: "ok", modelId: "m", routeId: "stub/model", apiFamily: "openai-chat-completions", toolCallCount: 0, toolEvents: [] };
    }) as TurnRunner;
    const s = makeSession({ runTurn: runner });
    let injected = "";
    s.subscribe("steer.injected", (e) => { injected = e.text; });

    const p = s.prompt("go");
    s.steer("focus on the parser"); // added AFTER prompt()'s boundary drain → mid-run
    await p;
    expect(pulled).toEqual(["focus on the parser"]); // pulled inside the running turn
    expect(injected).toBe("focus on the parser");
    expect(s.queueDepth()).toBe(0); // drained mid-run, not left for next turn
  });
});

describe("AgentSession — usability-audit regressions (2026-07-09)", () => {
  it("discardPendingSteers drops steers and keeps follow-ups", () => {
    const s = makeSession({ runTurn: stubRunner({ text: "x" }) });
    s.steer("nudge-a");
    s.steer("nudge-b");
    s.followUp("later");
    expect(s.discardPendingSteers()).toEqual(["nudge-a", "nudge-b"]);
    expect(s.pendingSteerCount()).toBe(0);
    expect(s.takeFollowUps()).toEqual(["later"]);
  });

  it("pendingSteerCount counts steers only (excludes follow-ups)", () => {
    const s = makeSession({ runTurn: stubRunner({ text: "x" }) });
    expect(s.pendingSteerCount()).toBe(0);
    s.steer("nudge");
    s.followUp("later");
    expect(s.queueDepth()).toBe(2);
    expect(s.pendingSteerCount()).toBe(1);
    s.takeFollowUps();
    expect(s.pendingSteerCount()).toBe(1);
    expect(s.queueDepth()).toBe(1);
  });

  it("a steer left over from a NO-TOOL turn injects at the top of the NEXT driveTurn (stuck q:N fix)", async () => {
    // pullSteering only fires between tool rounds (agentTurn iteration > 0), so a
    // steer typed during a plain streamed answer used to rot in the queue forever.
    const s = makeSession({ runTurn: stubRunner({ text: "plain answer, zero tool rounds" }) });
    s.steer("actually use TypeScript");
    expect(s.queueDepth()).toBe(1); // stuck after the turn that never pulled it

    const history: ChatTurnMessage[] = [{ role: "user", content: "next turn" }];
    const injected: string[] = [];
    s.subscribe("steer.injected", (e) => injected.push(e.text));
    await s.driveTurn({ getHistory: () => history });
    expect(s.queueDepth()).toBe(0);
    expect(injected).toEqual(["actually use TypeScript"]);
    expect(history.some((m) => m.role === "system" && m.content === "[steering] actually use TypeScript")).toBe(true);
  });

  it("driveTurn's boundary drain leaves follow-ups queued (they run as fresh turns, not context notes)", async () => {
    const s = makeSession({ runTurn: stubRunner({ text: "answer" }) });
    s.followUp("and then do the docs");
    const history = [{ role: "user" as const, content: "turn" }];
    await s.driveTurn({ getHistory: () => history });
    expect(s.queueDepth()).toBe(1); // follow-up untouched by the steer drain
    expect(s.takeFollowUps()).toEqual(["and then do the docs"]);
  });

  it("does NOT push an empty assistant message on an aborted/empty turn (anthropic 400-poison fix)", async () => {
    const history: ChatTurnMessage[] = [{ role: "user", content: "aborted turn" }];
    const s = makeSession({ runTurn: stubRunner({ text: "" }) });
    await s.driveTurn({ getHistory: () => history });
    expect(history.filter((m) => m.role === "assistant")).toHaveLength(0);
    // prompt() path too: user message stays, no empty assistant appended after it
    const s2 = makeSession({ runTurn: stubRunner({ text: "" }) });
    await s2.prompt("hi");
    expect(s2.history.map((m) => m.role)).toEqual(["user"]);
  });
});

describe("AgentSession — manual compaction", () => {
  it("returns disabled without config and leaves the existing history array untouched", async () => {
    const s = makeSession();
    seedCompactableHistory(s);
    const historyRef = s.history;
    const before = structuredClone(s.history);

    await expect(s.compact()).resolves.toEqual({ compacted: false, reason: "disabled" });
    expect(s.history).toBe(historyRef);
    expect(s.history).toEqual(before);
  });

  it("returns nothing-to-compact without calling the summarizer", async () => {
    const requests: SummarizeRequest[] = [];
    const s = makeSession({
      compaction: ENABLED_COMPACTION,
      summarize: async (request) => {
        requests.push(request);
        return "unused";
      }
    });
    s.history.push({ role: "user", content: "short" });
    const historyRef = s.history;
    const before = structuredClone(s.history);

    await expect(s.compact()).resolves.toEqual({ compacted: false, reason: "nothing-to-compact" });
    expect(requests).toHaveLength(0);
    expect(s.history).toBe(historyRef);
    expect(s.history).toEqual(before);
  });

  it("emits one bounded start and one successful end for a real manual compaction", async () => {
    const events: Array<{ readonly event: string; readonly payload: unknown }> = [];
    const requests: SummarizeRequest[] = [];
    const s = makeSession({
      compaction: ENABLED_COMPACTION,
      summarize: async (request) => {
        requests.push(request);
        return "PRIVATE_SUMMARY_TEXT";
      }
    });
    seedCompactableHistory(s);
    const historyLength = s.history.length;
    s.subscribe("compaction.start", (payload) => events.push({ event: "start", payload }));
    s.subscribe("compaction.end", (payload) => events.push({ event: "end", payload }));

    const result = await s.compact("PRIVATE_OPERATOR_INSTRUCTION");

    expect(result).toMatchObject({ compacted: true, summaryCount: 1 });
    expect(requests).toHaveLength(1);
    expect(events).toEqual([
      {
        event: "start",
        payload: {
          reason: "manual",
          beforeTokens: expect.any(Number),
          historyLength
        }
      },
      {
        event: "end",
        payload: {
          compacted: true,
          summaryCount: 1,
          beforeTokens: expect.any(Number),
          afterTokens: expect.any(Number)
        }
      }
    ]);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_OPERATOR_INSTRUCTION");
    expect(JSON.stringify(events)).not.toContain("PRIVATE_SUMMARY_TEXT");
    expect(JSON.stringify(events)).not.toContain("question-0-");
  });

  it("emits a bounded nothing-to-compact terminal event without invoking the summarizer", async () => {
    const events: Array<{ readonly event: string; readonly payload: unknown }> = [];
    const requests: SummarizeRequest[] = [];
    const s = makeSession({
      compaction: ENABLED_COMPACTION,
      summarize: async (request) => {
        requests.push(request);
        return "unused";
      }
    });
    s.history.push({ role: "user", content: "PRIVATE_SHORT_TRANSCRIPT" });
    s.subscribe("compaction.start", (payload) => events.push({ event: "start", payload }));
    s.subscribe("compaction.end", (payload) => events.push({ event: "end", payload }));

    await expect(s.compact()).resolves.toEqual({ compacted: false, reason: "nothing-to-compact" });

    expect(requests).toHaveLength(0);
    expect(events).toEqual([
      {
        event: "start",
        payload: {
          reason: "manual",
          beforeTokens: expect.any(Number),
          historyLength: 1
        }
      },
      { event: "end", payload: { compacted: false, reason: "nothing-to-compact" } }
    ]);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_SHORT_TRANSCRIPT");
  });

  it("emits one redacted failed end, preserves history, and rethrows the original failure", async () => {
    const events: Array<{ readonly event: string; readonly payload: unknown }> = [];
    const expected = new Error("PRIVATE_PROVIDER_FAILURE_MESSAGE");
    let summarizeCalls = 0;
    const s = makeSession({
      compaction: ENABLED_COMPACTION,
      summarize: async () => {
        summarizeCalls += 1;
        throw expected;
      }
    });
    seedCompactableHistory(s);
    const before = structuredClone(s.history);
    s.subscribe("compaction.start", (payload) => events.push({ event: "start", payload }));
    s.subscribe("compaction.end", (payload) => events.push({ event: "end", payload }));

    await expect(s.compact()).rejects.toBe(expected);

    expect(summarizeCalls).toBe(1);
    expect(s.history).toEqual(before);
    expect(events.map(({ event }) => event)).toEqual(["start", "end"]);
    expect(events[1]).toEqual({ event: "end", payload: { compacted: false, reason: "failed" } });
    expect(JSON.stringify(events)).not.toContain("PRIVATE_PROVIDER_FAILURE_MESSAGE");
    expect(JSON.stringify(events)).not.toContain("question-0-");
  });

  it("emits no lifecycle events for disabled or busy requests", async () => {
    const disabledEvents: string[] = [];
    const disabled = makeSession();
    seedCompactableHistory(disabled);
    disabled.subscribe("compaction.start", () => disabledEvents.push("start"));
    disabled.subscribe("compaction.end", () => disabledEvents.push("end"));
    await expect(disabled.compact()).resolves.toEqual({ compacted: false, reason: "disabled" });
    expect(disabledEvents).toEqual([]);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const busyEvents: string[] = [];
    const busy = makeSession({
      compaction: ENABLED_COMPACTION,
      runTurn: (async () => {
        await gate;
        return {
          text: "done",
          modelId: "m",
          routeId: "stub/model",
          apiFamily: "openai-chat-completions",
          toolCallCount: 0,
          toolEvents: []
        } satisfies AgentTurnResult;
      }) as TurnRunner
    });
    busy.subscribe("compaction.start", () => busyEvents.push("start"));
    busy.subscribe("compaction.end", () => busyEvents.push("end"));
    const prompt = busy.prompt("in flight");
    await expect(busy.compact()).resolves.toEqual({ compacted: false, reason: "busy" });
    expect(busyEvents).toEqual([]);
    release();
    await prompt;
  });

  it("compacts in place, forwards custom instructions once, and the next prompt sees the rebuilt history", async () => {
    const requests: SummarizeRequest[] = [];
    const sentToNextPrompt: ChatTurnMessage[][] = [];
    const runner: TurnRunner = (async (_route, messages) => {
      sentToNextPrompt.push([...messages]);
      return {
        text: "next answer",
        modelId: "m",
        routeId: "stub/model",
        apiFamily: "openai-chat-completions",
        toolCallCount: 0,
        toolEvents: []
      };
    }) as TurnRunner;
    const s = makeSession({
      systemPrompt: "SYSTEM",
      compaction: ENABLED_COMPACTION,
      summarize: async (request) => {
        requests.push(request);
        return "summary-one";
      },
      runTurn: runner
    });
    seedCompactableHistory(s);
    const historyRef = s.history;
    const statsBefore = s.stats();

    const result = await s.compact("focus on unresolved work");

    expect(result.compacted).toBe(true);
    if (!result.compacted) throw new Error("expected compaction");
    expect(result.summaryCount).toBe(1);
    expect(result.beforeTokens).toBeGreaterThan(result.afterTokens);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.customInstructions).toBe("focus on unresolved work");
    expect(s.history).toBe(historyRef);
    expect(s.history[0]).toEqual({ role: "system", content: "SYSTEM" });
    expect(s.history.some((message) => message.content.includes("summary-one"))).toBe(true);
    expect(s.history.some((message) => message.content.includes("question-0-"))).toBe(false);
    expect(s.stats()).toMatchObject({
      turns: statsBefore.turns,
      inputTokens: statsBefore.inputTokens,
      outputTokens: statsBefore.outputTokens
    });

    await s.prompt("continue after compaction");
    expect(sentToNextPrompt).toHaveLength(1);
    expect(sentToNextPrompt[0]?.some((message) => message.content.includes("summary-one"))).toBe(true);
    expect(sentToNextPrompt[0]?.some((message) => message.content.includes("question-0-"))).toBe(false);
    expect(sentToNextPrompt[0]?.at(-1)?.content).toBe("continue after compaction");
  });

  it("compacts user-first history without dropping the first user message from the summary input", async () => {
    const requests: SummarizeRequest[] = [];
    const s = makeSession({
      compaction: ENABLED_COMPACTION,
      summarize: async (request) => {
        requests.push(request);
        return "user-first summary";
      }
    });
    seedCompactableHistory(s);

    const result = await s.compact();

    expect(result.compacted).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.transcriptBlock).toContain("question-0-");
    expect(s.history[0]?.role).toBe("system");
    expect(s.history[0]?.content).toContain("user-first summary");
  });

  it("retains the previous summary and increments the count on a second compaction", async () => {
    const requests: SummarizeRequest[] = [];
    let summaryNumber = 0;
    const s = makeSession({
      compaction: ENABLED_COMPACTION,
      summarize: async (request) => {
        requests.push(request);
        summaryNumber += 1;
        return `summary-${summaryNumber}`;
      }
    });
    seedCompactableHistory(s);
    const first = await s.compact();
    expect(first).toMatchObject({ compacted: true, summaryCount: 1 });
    s.history.push(
      { role: "user", content: `new-question-0-${"q".repeat(220)}` },
      { role: "assistant", content: `new-answer-0-${"a".repeat(220)}` },
      { role: "user", content: `new-question-1-${"q".repeat(220)}` },
      { role: "assistant", content: `new-answer-1-${"a".repeat(220)}` }
    );

    const second = await s.compact();

    expect(second).toMatchObject({ compacted: true, summaryCount: 2 });
    expect(requests.at(-1)?.previousSummary).toBe("summary-1");
    expect(s.history.filter((message) => message.content.includes("[compaction summary]"))).toHaveLength(1);
    expect(s.history.some((message) => message.content.includes("summary-2"))).toBe(true);
  });

  it("throws summarizer failures and preserves history exactly", async () => {
    const expected = new Error("summary route failed");
    const s = makeSession({
      compaction: ENABLED_COMPACTION,
      summarize: async () => {
        throw expected;
      }
    });
    seedCompactableHistory(s);
    const historyRef = s.history;
    const before = structuredClone(s.history);

    await expect(s.compact()).rejects.toBe(expected);
    expect(s.history).toBe(historyRef);
    expect(s.history).toEqual(before);
    await expect(s.compact()).rejects.toBe(expected);
  });

  it("returns busy while a prompt is in flight without changing that turn's history", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: TurnRunner = (async () => {
      await gate;
      return {
        text: "done",
        modelId: "m",
        routeId: "stub/model",
        apiFamily: "openai-chat-completions",
        toolCallCount: 0,
        toolEvents: []
      };
    }) as TurnRunner;
    const s = makeSession({ compaction: ENABLED_COMPACTION, summarize: async () => "summary", runTurn: runner });
    seedCompactableHistory(s);
    const prompt = s.prompt("currently running");
    const beforeCompactAttempt = structuredClone(s.history);

    await expect(s.compact()).resolves.toEqual({ compacted: false, reason: "busy" });
    expect(s.history).toEqual(beforeCompactAttempt);

    release();
    await prompt;
  });

  it("rejects prompts and a second compaction while the first compaction is running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const s = makeSession({
      compaction: ENABLED_COMPACTION,
      summarize: async () => {
        await gate;
        return "summary";
      }
    });
    seedCompactableHistory(s);
    const before = structuredClone(s.history);
    const first = s.compact();

    await expect(s.compact()).resolves.toEqual({ compacted: false, reason: "busy" });
    await expect(s.prompt("must not be appended")).rejects.toThrow(/compaction is already running/);
    expect(s.history).toEqual(before);

    release();
    await expect(first).resolves.toMatchObject({ compacted: true, summaryCount: 1 });
  });

  it("uses a tool-free production summarizer without advancing ordinary turn usage", async () => {
    const calls: Array<{ messages: readonly ChatTurnMessage[]; tools: readonly unknown[]; approved: boolean }> = [];
    const runner: TurnRunner = (async (_route, messages, options) => {
      calls.push({ messages: [...messages], tools: options.tools, approved: await options.approveTool("read", {}) });
      return {
        text: "model-produced summary",
        modelId: "m",
        routeId: "stub/model",
        apiFamily: "openai-chat-completions",
        usage: { inputTokens: 900, outputTokens: 100, lastRequestInputTokens: 900 },
        toolCallCount: 0,
        toolEvents: []
      };
    }) as TurnRunner;
    const s = makeSession({ compaction: ENABLED_COMPACTION, runTurn: runner });
    seedCompactableHistory(s);
    const statsBefore = s.stats();

    const result = await s.compact();

    expect(result.compacted).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tools).toEqual([]);
    expect(calls[0]?.approved).toBe(false);
    expect(calls[0]?.messages[0]?.role).toBe("system");
    expect(s.stats()).toMatchObject({
      turns: statsBefore.turns,
      inputTokens: statsBefore.inputTokens,
      outputTokens: statsBefore.outputTokens,
      lastInputTokens: statsBefore.lastInputTokens
    });
    expect(s.history.some((message) => message.content.includes("model-produced summary"))).toBe(true);
  });
});

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentSession, type AgentSessionDeps, type TurnRunner } from "../../src/session/agentSession.js";
import { createFileMemoryStore } from "../../src/memory/store.js";
import type { AgentTurnResult } from "../../src/model/agentTurn.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const route = { routeId: "stub/model", apiFamily: "openai-chat-completions", modelId: "m", capabilities: { supportsTools: true }, context: { contextWindowTokens: 128_000 } } as never;
const session = (repoRoot?: string) => ({ id: "s1", repo: repoRoot ? { repoRoot } : null, tools: [] }) as never;
const EMPTY_MANDATE = { grants: [], denies: [] } as never;

/** A stub turn runner: echoes a fixed reply, optionally streams tokens + a tool event. */
function stubRunner(over: { text?: string; tokens?: string[]; toolEvent?: { toolId: string; status: "succeeded" | "failed" }; captureApprove?: (toolId: string, allowed: boolean) => void } = {}): TurnRunner {
  return (async (_route, _messages, options) => {
    for (const chunk of over.tokens ?? []) options.onToken?.(chunk);
    if (over.toolEvent) {
      const allowed = await options.approveTool(over.toolEvent.toolId, { path: "x" });
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

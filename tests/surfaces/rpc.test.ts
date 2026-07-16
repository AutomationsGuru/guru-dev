import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { dispatchRpc, frameChunk, runRpcMode, wireRpcEvents, RpcRequestSchema, type RpcContext } from "../../src/surfaces/rpc.js";
import { createRpcSessionGraph, type RpcForkSessionFactory } from "../../src/surfaces/rpcSessionGraph.js";
import { AgentSession, type AgentSessionDeps, type TurnRunner } from "../../src/session/agentSession.js";
import { CompactionConfigSchema } from "../../src/compaction/schemas.js";
import type { SummarizeRequest } from "../../src/compaction/engine.js";
import { loadHarnessConfig } from "../../src/config/loadConfig.js";
import { sanitizeToolOutput } from "../../src/safety/outputSanitizer.js";
import { clearRegisteredSecretValues } from "../../src/safety/secretSafety.js";
import { createFileMemoryStore } from "../../src/memory/store.js";
import type { AgentTurnResult } from "../../src/model/agentTurn.js";
import { createHarnessRuntime } from "../../src/runtime/session.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  clearRegisteredSecretValues();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const route = { routeId: "stub/model", apiFamily: "openai-chat-completions", modelId: "m", capabilities: { supportsTools: true }, context: { contextWindowTokens: 128_000 } } as never;
function stubRunner(over: { text?: string; tokens?: string[] } = {}): TurnRunner {
  return (async (_r, _m, options) => {
    for (const chunk of over.tokens ?? []) options.onToken?.(chunk);
    const result: AgentTurnResult = { text: over.text ?? "ok", modelId: "m", routeId: "stub/model", apiFamily: "openai-chat-completions", toolCallCount: 0, toolEvents: [] };
    return result;
  }) as TurnRunner;
}
function makeSession(
  runTurn: TurnRunner = stubRunner(),
  memory?: ReturnType<typeof createFileMemoryStore>,
  overrides: Partial<AgentSessionDeps> = {}
): AgentSession {
  return new AgentSession({
    runtime: { executeTool: async () => ({ toolId: "read", status: "succeeded", startedAt: "t", endedAt: "t", durationMs: 0 }) } as never,
    route,
    session: { id: "s1", repo: null, tools: [] } as never,
    sessionTools: [],
    mandate: { grants: [], denies: [] } as never,
    ...(memory ? { memory } : {}),
    runTurn,
    ...overrides
  });
}

const enabledCompaction = CompactionConfigSchema.parse({
  enabled: true,
  reserveTokens: 64,
  keepRecentTokens: 24,
  summaryMaxTokens: 128
});

function seedCompactableHistory(target: AgentSession): void {
  for (let index = 0; index < 2; index += 1) {
    target.history.push(
      { role: "user", content: `PRIVATE_QUESTION_${index}_${"q".repeat(220)}` },
      { role: "assistant", content: `PRIVATE_ANSWER_${index}_${"a".repeat(220)}` }
    );
  }
}

function parseRpcOutput(chunks: readonly string[]): Array<Record<string, unknown>> {
  return chunks
    .join("")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForRpcResponse(chunks: readonly string[], id: number): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = parseRpcOutput(chunks).find((message) => message.id === id);
    if (response) return response;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`RPC response ${id} was not emitted.`);
}

const LSEP = String.fromCharCode(0x2028); // U+2028 LINE SEPARATOR

describe("RPC framing (StringDecoder, NOT readline)", () => {
  it("splits on newline and holds a partial trailing line in the buffer", () => {
    const state = { buffer: "" };
    const dec = new StringDecoder("utf8");
    expect(frameChunk(state, '{"a":1}\n{"b":2}\n{"partial"', dec)).toEqual(['{"a":1}', '{"b":2}']);
    expect(state.buffer).toBe('{"partial"');
    expect(frameChunk(state, ':3}\n', dec)).toEqual(['{"partial":3}']);
  });

  it("ACCEPTANCE: a raw U+2028 inside a payload does NOT frame (the readline bug)", () => {
    const state = { buffer: "" };
    const dec = new StringDecoder("utf8");
    // A client sends a RAW U+2028 inside the JSON string — readline would split here; we must not.
    const line = `{"method":"prompt","params":{"text":"before${LSEP}after"}}`;
    const lines = frameChunk(state, `${line}\n`, dec);
    expect(lines).toHaveLength(1); // framed only on \n
    expect((lines[0] as string).includes(LSEP)).toBe(true); // the raw char survived intact
    expect(JSON.parse(lines[0] as string).params.text).toBe(`before${LSEP}after`);
  });
});

describe("RPC dispatch — on the unified AgentSession engine", () => {
  const ctx = (session: AgentSession, emit: RpcContext["emit"] = () => {}): RpcContext => ({ session, emit });

  it("prompt runs the engine turn and returns the text", async () => {
    const res = await dispatchRpc(RpcRequestSchema.parse({ id: 1, method: "prompt", params: { text: "hi" } }), ctx(makeSession(stubRunner({ text: "engine reply" }))));
    expect(res).toMatchObject({ id: 1, ok: true, result: { text: "engine reply" } });
  });

  it("prompt drains queued follow-ups as fresh turns when the primary turn stops", async () => {
    const submitted: string[] = [];
    const runner = (async (_r, messages) => {
      const text = messages.at(-1)?.content ?? "";
      submitted.push(text);
      return {
        text: `ok:${text}`,
        modelId: "m",
        routeId: "stub/model",
        apiFamily: "openai-chat-completions",
        toolCallCount: 0,
        toolEvents: []
      } satisfies AgentTurnResult;
    }) as TurnRunner;
    const session = makeSession(runner);
    session.followUp("then write tests");
    const res = await dispatchRpc(RpcRequestSchema.parse({ id: 2, method: "prompt", params: { text: "ship it" } }), ctx(session));
    expect(submitted).toEqual(["ship it", "then write tests"]);
    expect(res).toMatchObject({ id: 2, ok: true, result: { text: "ok:then write tests" } });
  });

  it("steer / state / models / unknown method", async () => {
    const s = makeSession();
    expect(await dispatchRpc(RpcRequestSchema.parse({ method: "steer", params: { text: "focus" } }), ctx(s))).toMatchObject({ ok: true, result: { queued: 1 } });
    expect(await dispatchRpc(RpcRequestSchema.parse({ method: "state" }), ctx(s))).toMatchObject({ ok: true, result: { turns: 0 } });
    expect(await dispatchRpc(RpcRequestSchema.parse({ method: "models" }), { session: s, emit: () => {}, routes: [route] })).toMatchObject({ ok: true });
    expect(await dispatchRpc(RpcRequestSchema.parse({ method: "nope" }), ctx(s))).toMatchObject({ ok: false });
  });

  it("suit_up / park drive the garage headlessly (scenario 13)", async () => {
    const directory = join(tmpdir(), `guru-rpc-${process.pid}-${dirs.length}`);
    dirs.push(directory);
    mkdirSync(directory, { recursive: true });
    const memory = createFileMemoryStore({ directory, now: () => new Date(Date.UTC(2026, 6, 5)) });
    const s = makeSession(stubRunner(), memory);
    const worn = await dispatchRpc(RpcRequestSchema.parse({ method: "suit_up", params: { description: "finance work" } }), ctx(s));
    expect(worn).toMatchObject({ ok: true, result: { created: true, suit: "finance-work" } });
    const parked = await dispatchRpc(RpcRequestSchema.parse({ method: "park" }), ctx(s));
    expect(parked).toMatchObject({ ok: true });
  });

  it("compaction forwards instructions once and the next prompt consumes the compacted history", async () => {
    const sentHistories: Array<readonly { readonly role: string; readonly content: string }[]> = [];
    const summaryRequests: SummarizeRequest[] = [];
    const runner = (async (_route, messages) => {
      sentHistories.push(messages.map((message) => ({ ...message })));
      return {
        text: "continued",
        modelId: "m",
        routeId: "stub/model",
        apiFamily: "openai-chat-completions",
        toolCallCount: 0,
        toolEvents: []
      } satisfies AgentTurnResult;
    }) as TurnRunner;
    const session = makeSession(runner, undefined, {
      systemPrompt: "system contract",
      compaction: enabledCompaction,
      summarize: async (request) => {
        summaryRequests.push(request);
        return "folded old context";
      }
    });
    session.history.push(
      { role: "user", content: `old question ${"x".repeat(160)}` },
      { role: "assistant", content: `old answer ${"y".repeat(160)}` },
      { role: "user", content: "recent question" },
      { role: "assistant", content: "recent answer" }
    );

    const compacted = await dispatchRpc(
      RpcRequestSchema.parse({ id: 40, method: "compaction", params: { instructions: "retain decisions" } }),
      ctx(session)
    );
    const prompted = await dispatchRpc(
      RpcRequestSchema.parse({ id: 41, method: "prompt", params: { text: "continue now" } }),
      ctx(session)
    );

    expect(compacted).toMatchObject({
      id: 40,
      ok: true,
      result: {
        compacted: true,
        summaryCount: 1,
        beforeTokens: expect.any(Number),
        afterTokens: expect.any(Number)
      }
    });
    expect(prompted).toMatchObject({ id: 41, ok: true, result: { text: "continued" } });
    expect(summaryRequests).toHaveLength(1);
    expect(summaryRequests[0]?.customInstructions).toBe("retain decisions");
    expect(sentHistories).toHaveLength(1);
    expect(sentHistories[0]?.some((message) => message.content.includes("folded old context"))).toBe(true);
    expect(sentHistories[0]?.some((message) => message.content === "continue now")).toBe(true);
    expect(sentHistories[0]?.some((message) => message.content.startsWith("old question"))).toBe(false);
  });

  it("compaction reports a disabled no-change without invoking the summarizer", async () => {
    const summarize = vi.fn(async () => "unused");
    const session = makeSession(stubRunner(), undefined, {
      compaction: { ...enabledCompaction, enabled: false },
      summarize
    });
    session.history.push({ role: "user", content: "one" }, { role: "assistant", content: "two" });

    const response = await dispatchRpc(RpcRequestSchema.parse({ id: 42, method: "compaction" }), ctx(session));

    expect(response).toEqual({ id: 42, ok: true, result: { compacted: false, reason: "disabled" } });
    expect(summarize).not.toHaveBeenCalled();
  });

  it("compaction during an active prompt returns busy instead of racing the turn", async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = (async () => {
      markStarted?.();
      await gate;
      return {
        text: "done",
        modelId: "m",
        routeId: "stub/model",
        apiFamily: "openai-chat-completions",
        toolCallCount: 0,
        toolEvents: []
      } satisfies AgentTurnResult;
    }) as TurnRunner;
    const session = makeSession(runner, undefined, {
      compaction: enabledCompaction,
      summarize: async () => "summary"
    });
    const prompt = session.prompt("slow prompt");
    await started;

    const response = await dispatchRpc(RpcRequestSchema.parse({ id: 43, method: "compaction" }), ctx(session));

    expect(response).toEqual({ id: 43, ok: true, result: { compacted: false, reason: "busy" } });
    release?.();
    await prompt;
  });

  it("compaction targets the active graph session after a fork", async () => {
    const rootSummarize = vi.fn(async () => "root summary");
    const childSummarize = vi.fn(async () => "child summary");
    const root = makeSession(stubRunner(), undefined, {
      compaction: enabledCompaction,
      summarize: rootSummarize
    });
    root.history.push({ role: "user", content: "branch point" });
    const child = makeSession(stubRunner(), undefined, {
      compaction: enabledCompaction,
      summarize: childSummarize
    });
    const graph = createRpcSessionGraph({
      rootSessionId: "root",
      rootSession: root,
      createForkSession: async () => ({ sessionId: "child", session: child })
    });
    await graph.fork({ throughHistoryIndex: 0 });
    seedCompactableHistory(child);

    const response = await dispatchRpc(
      RpcRequestSchema.parse({ id: 44, method: "compaction" }),
      { session: root, graph, emit: () => {} }
    );

    expect(response).toMatchObject({ id: 44, ok: true, result: { compacted: true } });
    expect(rootSummarize).not.toHaveBeenCalled();
    expect(childSummarize).toHaveBeenCalled();
  });

  it("routes forked prompts through the active session and exposes metadata only", async () => {
    const calls: string[] = [];
    const runner = (label: string) => (async (_route, messages) => {
      const text = messages.at(-1)?.content ?? "";
      calls.push(`${label}:${text}`);
      return {
        text: `${label}:${text}`,
        modelId: "m",
        routeId: "stub/model",
        apiFamily: "openai-chat-completions",
        toolCallCount: 0,
        toolEvents: []
      } satisfies AgentTurnResult;
    }) as TurnRunner;
    const root = makeSession(runner("root"));
    root.history.push({ role: "user", content: "private branch point" });
    const child = makeSession(runner("child"));
    const graph = createRpcSessionGraph({
      rootSessionId: "root",
      rootSession: root,
      createForkSession: async () => ({ sessionId: "child", session: child })
    });
    const graphContext: RpcContext = { session: root, graph, emit: () => {} };

    await expect(dispatchRpc(RpcRequestSchema.parse({
      id: 1,
      method: "fork",
      params: { throughHistoryIndex: 0 }
    }), graphContext)).resolves.toMatchObject({
      id: 1,
      ok: true,
      result: { sessionId: "child", parentSessionId: "root", copiedHistoryLength: 1 }
    });
    await dispatchRpc(RpcRequestSchema.parse({ id: 2, method: "prompt", params: { text: "child turn" } }), graphContext);
    await expect(dispatchRpc(RpcRequestSchema.parse({
      id: 3,
      method: "switch_session",
      params: { sessionId: "root" }
    }), graphContext)).resolves.toMatchObject({ id: 3, ok: true, result: { sessionId: "root" } });
    await dispatchRpc(RpcRequestSchema.parse({ id: 4, method: "prompt", params: { text: "root turn" } }), graphContext);
    const tree = await dispatchRpc(RpcRequestSchema.parse({ id: 5, method: "get_tree" }), graphContext);

    expect(calls).toEqual(["child:child turn", "root:root turn"]);
    expect(tree).toMatchObject({ id: 5, ok: true, result: { activeSessionId: "root" } });
    expect(JSON.stringify(tree)).not.toContain("private branch point");
    expect(JSON.stringify(tree)).not.toContain("child turn");
    expect(JSON.stringify(tree)).not.toContain("root turn");
  });

  it("rejects fork and switch while the active prompt is running", async () => {
    let releasePrompt: (() => void) | undefined;
    const promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const runner = (async () => {
      await promptGate;
      return {
        text: "done",
        modelId: "m",
        routeId: "stub/model",
        apiFamily: "openai-chat-completions",
        toolCallCount: 0,
        toolEvents: []
      } satisfies AgentTurnResult;
    }) as TurnRunner;
    const root = makeSession(runner);
    const graph = createRpcSessionGraph({
      rootSessionId: "root",
      rootSession: root,
      createForkSession: async () => ({ sessionId: "child", session: makeSession() })
    });
    const graphContext: RpcContext = { session: root, graph, emit: () => {} };
    const prompt = dispatchRpc(RpcRequestSchema.parse({ id: 1, method: "prompt", params: { text: "slow" } }), graphContext);
    await new Promise((resolve) => setImmediate(resolve));

    await expect(dispatchRpc(RpcRequestSchema.parse({
      id: 2,
      method: "fork",
      params: { throughHistoryIndex: 0 }
    }), graphContext)).resolves.toMatchObject({ ok: false, error: "RPC session graph: parent session has a running turn." });
    await expect(dispatchRpc(RpcRequestSchema.parse({
      id: 3,
      method: "switch_session",
      params: { sessionId: "root" }
    }), graphContext)).resolves.toMatchObject({ ok: false, error: "RPC session graph: active session has a running turn." });
    releasePrompt?.();
    await expect(prompt).resolves.toMatchObject({ ok: true });
  });
});

describe("runRpcMode — request ordering", () => {
  it("advertises compaction exactly once without reordering existing ready methods", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (chunk) => chunks.push(String(chunk)));
    input.end();

    await runRpcMode({ session: makeSession(), input, output });

    const ready = parseRpcOutput(chunks).find((message) => message.event === "ready");
    expect(ready?.methods).toEqual([
      "prompt",
      "steer",
      "follow_up",
      "abort",
      "state",
      "suit_up",
      "park",
      "models",
      "compaction",
      "get_tree",
      "fork",
      "switch_session"
    ]);
    expect((ready?.methods as string[] | undefined)?.filter((method) => method === "compaction")).toHaveLength(1);
  });

  it("passes active disabled compaction config through graph bootstrap sessions", async () => {
    const loaded = loadHarnessConfig({ cwd: process.cwd() });
    const loadConfig = vi.fn(() => ({
      ...loaded,
      config: {
        ...loaded.config,
        compaction: { ...loaded.config.compaction, enabled: false }
      }
    }));
    const runtime = {
      startSession: vi.fn(async () => ({ id: "rpc-config-session", repo: null, tools: [] })),
      getSessionTools: vi.fn(() => []),
      closeSession: vi.fn(async () => {}),
      close: vi.fn(async () => {})
    } as unknown as ReturnType<typeof createHarnessRuntime>;
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (chunk) => chunks.push(String(chunk)));
    const run = runRpcMode({ input, output, createRuntime: () => runtime, loadConfig });
    input.write(`${JSON.stringify({ id: 50, method: "compaction" })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    input.end();

    await run;

    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(parseRpcOutput(chunks).find((message) => message.id === 50)).toEqual({
      id: 50,
      ok: true,
      result: { compacted: false, reason: "disabled" }
    });
  });

  it("closes the runtime it bootstraps when input ends", async () => {
    const runtime = createHarnessRuntime();
    const closeRuntime = runtime.close.bind(runtime);
    let closeCalls = 0;
    runtime.close = async () => {
      closeCalls += 1;
      await closeRuntime();
    };
    const input = new PassThrough();
    const output = new PassThrough();
    input.end();

    await runRpcMode({ input, output, createRuntime: () => runtime });

    expect(closeCalls).toBe(1);
    await expect(runtime.startSession()).rejects.toThrow("Harness runtime is closed");
  });

  it("processes follow_up immediately while a prompt is still running", async () => {
    let releasePrompt: (() => void) | undefined;
    const promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const runner = (async (_r, messages) => {
      const text = messages.at(-1)?.content ?? "";
      if (text === "slow") {
        await promptGate;
      }
      return {
        text: `ok:${text}`,
        modelId: "m",
        routeId: "stub/model",
        apiFamily: "openai-chat-completions",
        toolCallCount: 0,
        toolEvents: []
      } satisfies AgentTurnResult;
    }) as TurnRunner;
    const session = makeSession(runner);
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on("data", (chunk) => {
      lines.push(String(chunk));
    });
    const run = runRpcMode({ session, input, output });
    input.write(`${JSON.stringify({ id: 1, method: "prompt", params: { text: "slow" } })}\n`);
    input.write(`${JSON.stringify({ id: 2, method: "follow_up", params: { text: "after stop" } })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines.some((line) => line.includes('"queued"'))).toBe(true);
    releasePrompt?.();
    input.end();
    await run;
    const responses = lines.map((line) => JSON.parse(line.trim()) as { id?: number; ok?: boolean });
    expect(responses.find((response) => response.id === 2)).toMatchObject({ ok: true });
    const finalPrompt = responses.find((response) => response.id === 1);
    expect(finalPrompt).toMatchObject({ ok: true, result: { text: "ok:after stop" } });
  });

  it("advertises and runs graph methods with active-event rewiring and clean shutdown", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const root = makeSession(stubRunner({ text: "root", tokens: ["root-token"] }));
    root.history.push({ role: "user", content: "branch point" });
    const child = makeSession(stubRunner({ text: "child", tokens: ["child-token"] }));
    const createForkSession: RpcForkSessionFactory = async () => ({ sessionId: "child", session: child });
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (chunk) => chunks.push(String(chunk)));
    const run = runRpcMode({
      session: root,
      rootSessionId: "root",
      createForkSession,
      input,
      output
    });
    await new Promise((resolve) => setImmediate(resolve));
    const ready = parseRpcOutput(chunks).find((message) => message.event === "ready");
    const methods = ready?.methods as string[];
    for (const method of ["get_tree", "fork", "switch_session"]) {
      expect(methods.filter((candidate) => candidate === method)).toHaveLength(1);
    }

    input.write(`${JSON.stringify({ id: 1, method: "fork", params: { throughHistoryIndex: 0 } })}\n`);
    await expect(waitForRpcResponse(chunks, 1)).resolves.toMatchObject({ ok: true });
    input.write(`${JSON.stringify({ id: 2, method: "prompt", params: { text: "child prompt" } })}\n`);
    await expect(waitForRpcResponse(chunks, 2)).resolves.toMatchObject({ ok: true, result: { text: "child" } });
    input.write(`${JSON.stringify({ id: 3, method: "switch_session", params: { sessionId: "root" } })}\n`);
    await expect(waitForRpcResponse(chunks, 3)).resolves.toMatchObject({ ok: true });
    input.write(`${JSON.stringify({ id: 4, method: "switch_session", params: { sessionId: "root" } })}\n`);
    await expect(waitForRpcResponse(chunks, 4)).resolves.toMatchObject({ ok: true });
    input.write(`${JSON.stringify({ id: 5, method: "prompt", params: { text: "root prompt" } })}\n`);
    await expect(waitForRpcResponse(chunks, 5)).resolves.toMatchObject({ ok: true, result: { text: "root" } });
    input.write(`${JSON.stringify({ id: 6, method: "get_tree" })}\n`);
    const tree = await waitForRpcResponse(chunks, 6);
    expect(JSON.stringify(tree)).not.toContain("branch point");
    expect(JSON.stringify(tree)).not.toContain("child prompt");
    input.end();
    await run;

    const messages = parseRpcOutput(chunks);
    expect(messages.filter((message) => message.event === "token" && message.chunk === "child-token")).toHaveLength(1);
    expect(messages.filter((message) => message.event === "token" && message.chunk === "root-token")).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    const countAfterClose = messages.length;
    await root.prompt("after close");
    await child.prompt("after close");
    expect(parseRpcOutput(chunks)).toHaveLength(countAfterClose);
  });

  it("returns a truthful bounded error when an injected session has no fork factory", async () => {
    const root = makeSession();
    root.history.push({ role: "user", content: "branch" });
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (chunk) => chunks.push(String(chunk)));
    const run = runRpcMode({ session: root, input, output });
    input.write(`${JSON.stringify({ id: 1, method: "fork", params: { throughHistoryIndex: 0 } })}\n`);

    await expect(waitForRpcResponse(chunks, 1)).resolves.toMatchObject({
      ok: false,
      error: "RPC session graph: forking is unsupported without a fork-session factory."
    });
    input.end();
    await run;
  });

  it("waits for an in-flight fork before input-close shutdown", async () => {
    const root = makeSession();
    root.history.push({ role: "user", content: "branch" });
    const child = makeSession();
    let releaseFactory: (() => void) | undefined;
    const factoryGate = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (chunk) => chunks.push(String(chunk)));
    const run = runRpcMode({
      session: root,
      createForkSession: async () => {
        await factoryGate;
        return { sessionId: "child", session: child };
      },
      input,
      output
    });
    input.write(`${JSON.stringify({ id: 1, method: "fork", params: { throughHistoryIndex: 0 } })}\n`);
    input.end();
    let settled = false;
    void run.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    releaseFactory?.();
    await run;
    expect(await waitForRpcResponse(chunks, 1)).toMatchObject({ ok: true });
  });
});

describe("RPC events — engine stream + secret_sanitized (scenario 9)", () => {
  it("streams the engine's typed events during a prompt", async () => {
    const events: string[] = [];
    const s = makeSession(stubRunner({ text: "done", tokens: ["a", "b"] }));
    const unwire = wireRpcEvents(s, (m) => { if (m.type === "event") events.push(String(m.event)); });
    await s.prompt("go");
    unwire();
    expect(events).toContain("turn.start");
    expect(events).toContain("token");
    expect(events).toContain("turn.stop");
    expect(events).toContain("done.packet");
  });

  it("maps successful compaction lifecycle events before the response with bounded payloads", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const summaryRequests: SummarizeRequest[] = [];
    const session = makeSession(stubRunner(), undefined, {
      compaction: enabledCompaction,
      summarize: async (request) => {
        summaryRequests.push(request);
        return "PRIVATE_RPC_SUMMARY";
      }
    });
    seedCompactableHistory(session);
    const emit = (message: Record<string, unknown>): void => {
      emitted.push(message);
    };
    const unwire = wireRpcEvents(session, emit);

    const response = await dispatchRpc(
      RpcRequestSchema.parse({ id: 70, method: "compaction", params: { instructions: "PRIVATE_RPC_INSTRUCTION" } }),
      { session, emit }
    );
    emitted.push({ type: "response", ...response });
    unwire();

    expect(summaryRequests).toHaveLength(2);
    expect(emitted.map((message) => message.type === "event" ? message.event : "response")).toEqual([
      "compaction_start",
      "compaction_end",
      "response"
    ]);
    expect(emitted[0]).toEqual({
      type: "event",
      event: "compaction_start",
      reason: "manual",
      beforeTokens: expect.any(Number),
      historyLength: 4
    });
    expect(emitted[1]).toEqual({
      type: "event",
      event: "compaction_end",
      compacted: true,
      summaryCount: 1,
      beforeTokens: expect.any(Number),
      afterTokens: expect.any(Number)
    });
    const lifecycleJson = JSON.stringify(emitted.slice(0, 2));
    expect(lifecycleJson).not.toContain("PRIVATE_RPC_INSTRUCTION");
    expect(lifecycleJson).not.toContain("PRIVATE_RPC_SUMMARY");
    expect(lifecycleJson).not.toContain("PRIVATE_QUESTION");
  });

  it("maps a redacted failed compaction end before preserving the RPC error response", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const session = makeSession(stubRunner(), undefined, {
      compaction: enabledCompaction,
      summarize: async () => {
        throw new Error("PRIVATE_RPC_PROVIDER_FAILURE");
      }
    });
    seedCompactableHistory(session);
    const emit = (message: Record<string, unknown>): void => {
      emitted.push(message);
    };
    const unwire = wireRpcEvents(session, emit);

    const response = await dispatchRpc(RpcRequestSchema.parse({ id: 71, method: "compaction" }), { session, emit });
    emitted.push({ type: "response", ...response });
    unwire();

    expect(emitted.map((message) => message.type === "event" ? message.event : "response")).toEqual([
      "compaction_start",
      "compaction_end",
      "response"
    ]);
    expect(emitted[1]).toEqual({
      type: "event",
      event: "compaction_end",
      compacted: false,
      reason: "failed"
    });
    expect(response).toEqual({ id: 71, ok: false, error: "PRIVATE_RPC_PROVIDER_FAILURE" });
    expect(JSON.stringify(emitted.slice(0, 2))).not.toContain("PRIVATE_RPC_PROVIDER_FAILURE");
  });

  it("unsubscribes both compaction lifecycle mappings without listener leakage", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const session = makeSession(stubRunner(), undefined, {
      compaction: enabledCompaction,
      summarize: async () => "summary"
    });
    seedCompactableHistory(session);
    const unwire = wireRpcEvents(session, (message) => emitted.push(message));
    unwire();

    await expect(session.compact()).resolves.toMatchObject({ compacted: true });

    expect(emitted).toEqual([]);
  });

  it("ACCEPTANCE: sanitizing a tool output fires secret_sanitized with a PATTERN NAME and NO value", () => {
    const emitted: Array<Record<string, unknown>> = [];
    const s = makeSession();
    const unwire = wireRpcEvents(s, (m) => emitted.push(m));
    const cleaned = sanitizeToolOutput({ stdout: "OPENAI_API_KEY=sk-abcdefghijklmnop1234ZZ done" });
    unwire();
    const event = emitted.find((m) => m.event === "secret_sanitized");
    expect(event).toBeDefined();
    expect(event?.patterns).toContain("openai-key");
    // The value is redacted from the output AND never present in the event.
    expect(JSON.stringify(cleaned)).not.toContain("sk-abcdefghijklmnop1234");
    expect(JSON.stringify(event)).not.toContain("sk-abcdefghijklmnop1234");
  });
});

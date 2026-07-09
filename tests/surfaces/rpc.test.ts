import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { dispatchRpc, frameChunk, runRpcMode, wireRpcEvents, RpcRequestSchema, type RpcContext } from "../../src/surfaces/rpc.js";
import { AgentSession, type TurnRunner } from "../../src/session/agentSession.js";
import { sanitizeToolOutput } from "../../src/safety/outputSanitizer.js";
import { clearRegisteredSecretValues } from "../../src/safety/secretSafety.js";
import { createFileMemoryStore } from "../../src/memory/store.js";
import type { AgentTurnResult } from "../../src/model/agentTurn.js";

const dirs: string[] = [];
afterEach(() => {
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
function makeSession(runTurn: TurnRunner = stubRunner(), memory?: ReturnType<typeof createFileMemoryStore>): AgentSession {
  return new AgentSession({
    runtime: { executeTool: async () => ({ toolId: "read", status: "succeeded", startedAt: "t", endedAt: "t", durationMs: 0 }) } as never,
    route,
    session: { id: "s1", repo: null, tools: [] } as never,
    sessionTools: [],
    mandate: { grants: [], denies: [] } as never,
    ...(memory ? { memory } : {}),
    runTurn
  });
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
});

describe("runRpcMode — request ordering", () => {
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

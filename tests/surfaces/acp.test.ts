import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACP_JSON_RPC_VERSION,
  ACP_PROTOCOL_VERSION,
  createAcpSessionAdapter,
  parseAcpJsonRpcRequest,
  type AcpSessionAdapterDeps
} from '../../src/surfaces/acp.js';
import { AgentSession, type AgentSessionDeps, type TurnRunner } from '../../src/session/agentSession.js';
import type { AgentToolEvent, AgentTurnResult } from '../../src/model/agentTurn.js';
import { ProviderRouteDescriptorSchema, type ProviderRouteDescriptor } from '../../src/providers/schemas.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function modelRoute(routeId: string, modelId: string): ProviderRouteDescriptor {
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
    context: { contextWindowTokens: 128_000 }
  });
}

const route = modelRoute("stub/model", "m");

function turnResult(text: string): AgentTurnResult {
  return {
    text,
    modelId: "m",
    routeId: "stub/model",
    apiFamily: "openai-chat-completions",
    toolCallCount: 0,
    toolEvents: []
  };
}

function stubRunner(over: { text?: string; tokens?: string[]; toolEvents?: AgentToolEvent[] } = {}): TurnRunner {
  return (async (_turnRoute, _messages, options) => {
    for (const event of over.toolEvents ?? []) options.onToolEvent?.(event);
    for (const chunk of over.tokens ?? []) options.onToken?.(chunk);
    return turnResult(over.text ?? "ok");
  }) as TurnRunner;
}

function makeSession(runTurn: TurnRunner = stubRunner(), overrides: Partial<AgentSessionDeps> = {}): AgentSession {
  return new AgentSession({
    runtime: { executeTool: async () => ({ toolId: "read", status: "succeeded", startedAt: "t", endedAt: "t", durationMs: 0 }) } as never,
    route,
    session: { id: "s1", repo: null, tools: [] } as never,
    sessionTools: [],
    mandate: { grants: [], denies: [] } as never,
    runTurn,
    ...overrides
  });
}

const CWD = "/home/codex/worktrees/acp-test";

function makeAdapter(
  session: AgentSession,
  over: Partial<AcpSessionAdapterDeps> = {}
): {
  adapter: ReturnType<typeof createAcpSessionAdapter>;
  notifications: Array<Record<string, unknown>>;
} {
  const notifications: Array<Record<string, unknown>> = [];
  const adapter = createAcpSessionAdapter({
    session,
    sessionId: "s1",
    cwd: CWD,
    emit: (message) => notifications.push(message),
    ...over
  });
  return { adapter, notifications };
}

function initializeParams(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { protocolVersion: 1, clientCapabilities: {}, ...over };
}

describe("ACP JSON-RPC 2.0 envelope detection", () => {
  it("accepts an ACP envelope with an integer id and preserves it", () => {
    const parsed = parseAcpJsonRpcRequest({ jsonrpc: "2.0", id: 7, method: "initialize", params: {} });
    expect(parsed).toEqual({ jsonrpc: "2.0", id: 7, method: "initialize", params: {} });
  });

  it("accepts an ACP envelope with a string id", () => {
    const parsed = parseAcpJsonRpcRequest({ jsonrpc: "2.0", id: "req-1", method: "session/new" });
    expect(parsed?.id).toBe("req-1");
  });

  it("rejects a legacy Guru request (no jsonrpc member) so it falls to legacy dispatch", () => {
    expect(parseAcpJsonRpcRequest({ id: 1, method: "prompt", params: { text: "hi" } })).toBeNull();
  });

  it("rejects a jsonrpc envelope without a method name", () => {
    expect(parseAcpJsonRpcRequest({ jsonrpc: "2.0", id: 1 })).toBeNull();
    expect(parseAcpJsonRpcRequest("not an object")).toBeNull();
    expect(parseAcpJsonRpcRequest(null)).toBeNull();
  });
});

describe("ACP initialize", () => {
  it("negotiates protocol version 1 with truthful bounded capabilities and stable agentInfo", async () => {
    const { adapter } = makeAdapter(makeSession(), { agentName: "GuruHarness", agentVersion: "9.9.9-test" });
    const request = parseAcpJsonRpcRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: initializeParams() });

    const response = await adapter.handleRequest(request!);

    expect(response).toEqual({
      jsonrpc: ACP_JSON_RPC_VERSION,
      id: 1,
      result: {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: false }
        },
        agentInfo: { name: "GuruHarness", version: "9.9.9-test" },
        authMethods: []
      }
    });
    // No invented capabilities: no MCP, terminal, or filesystem claims anywhere.
    const serialized = JSON.stringify(response);
    for (const invented of ["mcp", "terminal", "fs", "loadSession\":true", "image\":true", "audio\":true"]) {
      expect(serialized).not.toContain(invented);
    }
  });

  it("preserves a string request id exactly", async () => {
    const { adapter } = makeAdapter(makeSession());
    const request = parseAcpJsonRpcRequest({ jsonrpc: "2.0", id: "init-abc", method: "initialize", params: initializeParams() });

    const response = await adapter.handleRequest(request!);

    expect(JSON.stringify(response)).toContain('"id":"init-abc"');
  });

  it("rejects malformed initialize params with -32602 and calls no model", async () => {
    let modelCalls = 0;
    const session = makeSession((async () => {
      modelCalls += 1;
      return turnResult("unexpected");
    }) as TurnRunner);
    const { adapter } = makeAdapter(session);
    const historyBefore = structuredClone(session.history);

    for (const params of [
      {},
      { protocolVersion: "1", clientCapabilities: {} },
      { protocolVersion: 1 },
      { protocolVersion: 1, clientCapabilities: {}, unexpected: true }
    ]) {
      const request = parseAcpJsonRpcRequest({ jsonrpc: "2.0", id: 2, method: "initialize", params });
      const response = await adapter.handleRequest(request!);
      expect(response).toMatchObject({ jsonrpc: "2.0", id: 2, error: { code: -32602 } });
    }
    expect(modelCalls).toBe(0);
    expect(session.history).toEqual(historyBefore);
  });
});

describe("ACP session/new", () => {
  it("returns the already active session identity for an absolute matching cwd and an empty MCP list", async () => {
    const session = makeSession();
    const { adapter } = makeAdapter(session);
    const request = parseAcpJsonRpcRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "session/new",
      params: { cwd: CWD, mcpServers: [] }
    });

    const response = await adapter.handleRequest(request!);

    expect(response).toEqual({ jsonrpc: "2.0", id: 3, result: { sessionId: "s1" } });
    // It must not create or clear anything.
    expect(session.history).toEqual([]);
  });

  it("rejects a relative or foreign cwd without mutating session state", async () => {
    const session = makeSession();
    session.history.push({ role: "user", content: "keep me" });
    const { adapter } = makeAdapter(session);

    for (const cwd of ["relative/path", "/somewhere/else"]) {
      const request = parseAcpJsonRpcRequest({ jsonrpc: "2.0", id: 4, method: "session/new", params: { cwd, mcpServers: [] } });
      const response = await adapter.handleRequest(request!);
      expect(response).toMatchObject({ jsonrpc: "2.0", id: 4, error: { code: -32602 } });
    }
    expect(session.history).toEqual([{ role: "user", content: "keep me" }]);
  });

  it("rejects any MCP server because this subset advertises no MCP capability", async () => {
    const { adapter } = makeAdapter(makeSession());
    const request = parseAcpJsonRpcRequest({
      jsonrpc: "2.0",
      id: 5,
      method: "session/new",
      params: { cwd: CWD, mcpServers: [{ name: "fs", command: "npx", args: ["server"] }] }
    });

    const response = await adapter.handleRequest(request!);

    expect(response).toMatchObject({ jsonrpc: "2.0", id: 5, error: { code: -32602 } });
    expect(String((response as { error: { message: string } }).error.message)).toMatch(/mcp/i);
  });

  it("rejects missing mcpServers and unknown params keys", async () => {
    const { adapter } = makeAdapter(makeSession());
    for (const params of [{ cwd: CWD }, { cwd: CWD, mcpServers: [], extra: 1 }]) {
      const request = parseAcpJsonRpcRequest({ jsonrpc: "2.0", id: 6, method: "session/new", params });
      expect(await adapter.handleRequest(request!)).toMatchObject({ error: { code: -32602 } });
    }
  });
});

describe("ACP session/prompt", () => {
  it("concatenates ordered text content blocks and drives promptDrainingFollowUps", async () => {
    const submitted: string[] = [];
    const runner = (async (_r, messages) => {
      submitted.push(messages.at(-1)?.content ?? "");
      return turnResult("done");
    }) as TurnRunner;
    const session = makeSession(runner);
    const { adapter } = makeAdapter(session);
    const request = parseAcpJsonRpcRequest({
      jsonrpc: "2.0",
      id: 7,
      method: "session/prompt",
      params: {
        sessionId: "s1",
        prompt: [
          { type: "text", text: "Hello, " },
          { type: "text", text: "world." }
        ]
      }
    });

    const response = await adapter.handleRequest(request!);

    expect(submitted).toEqual(["Hello, world."]);
    expect(response).toEqual({ jsonrpc: "2.0", id: 7, result: { stopReason: "end_turn" } });
  });

  it("rejects an unknown session id without calling a model or mutating state", async () => {
    let modelCalls = 0;
    const session = makeSession((async () => {
      modelCalls += 1;
      return turnResult("unexpected");
    }) as TurnRunner);
    const { adapter } = makeAdapter(session);
    const request = parseAcpJsonRpcRequest({
      jsonrpc: "2.0",
      id: 8,
      method: "session/prompt",
      params: { sessionId: "not-the-session", prompt: [{ type: "text", text: "hi" }] }
    });

    const response = await adapter.handleRequest(request!);

    expect(response).toMatchObject({ jsonrpc: "2.0", id: 8, error: { code: -32602 } });
    expect(String((response as { error: { message: string } }).error.message)).toMatch(/session/i);
    expect(modelCalls).toBe(0);
    expect(session.history).toEqual([]);
  });

  it("rejects unsupported content block types without calling a model", async () => {
    let modelCalls = 0;
    const session = makeSession((async () => {
      modelCalls += 1;
      return turnResult("unexpected");
    }) as TurnRunner);
    const { adapter } = makeAdapter(session);
    for (const block of [
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "audio", data: "AAAA", mimeType: "audio/wav" },
      { type: "resource", resource: { uri: "file:///x" } }
    ]) {
      const request = parseAcpJsonRpcRequest({
        jsonrpc: "2.0",
        id: 9,
        method: "session/prompt",
        params: { sessionId: "s1", prompt: [block] }
      });
      const response = await adapter.handleRequest(request!);
      expect(response).toMatchObject({ jsonrpc: "2.0", id: 9, error: { code: -32602 } });
    }
    expect(modelCalls).toBe(0);
    expect(session.history).toEqual([]);
  });

  it("rejects an empty prompt and malformed prompt params", async () => {
    let modelCalls = 0;
    const session = makeSession((async () => {
      modelCalls += 1;
      return turnResult("unexpected");
    }) as TurnRunner);
    const { adapter } = makeAdapter(session);
    for (const params of [
      { sessionId: "s1", prompt: [] },
      { sessionId: "s1" },
      { sessionId: "s1", prompt: "plain string" },
      { sessionId: "s1", prompt: [{ type: "text" }] }
    ]) {
      const request = parseAcpJsonRpcRequest({ jsonrpc: "2.0", id: 10, method: "session/prompt", params });
      expect(await adapter.handleRequest(request!)).toMatchObject({ jsonrpc: "2.0", id: 10, error: { code: -32602 } });
    }
    expect(modelCalls).toBe(0);
    expect(session.history).toEqual([]);
  });

  it("surfaces a turn failure as a JSON-RPC error, not a thrown adapter exception", async () => {
    const session = makeSession((async () => {
      throw new Error("turn exploded");
    }) as TurnRunner);
    const { adapter } = makeAdapter(session);
    const request = parseAcpJsonRpcRequest({
      jsonrpc: "2.0",
      id: 11,
      method: "session/prompt",
      params: { sessionId: "s1", prompt: [{ type: "text", text: "go" }] }
    });

    const response = await adapter.handleRequest(request!);

    expect(response).toMatchObject({ jsonrpc: "2.0", id: 11, error: { message: "turn exploded" } });
  });
});

describe("ACP session/update translation", () => {
  it("translates token events to agent_message_chunk notifications with the exact chunk, exactly once", async () => {
    const session = makeSession(stubRunner({ tokens: ["Hello", ", world"] }));
    const { adapter, notifications } = makeAdapter(session);
    const unwire = adapter.wireEvents(session);

    await session.prompt("go");
    unwire();

    expect(notifications).toHaveLength(2);
    for (const [index, chunk] of ["Hello", ", world"].entries()) {
      expect(notifications[index]).toMatchObject({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: chunk }
          }
        }
      });
      expect(typeof (notifications[index]?.params as { update: { messageId?: string } }).update.messageId).toBe("string");
    }
    // One turn → one stable message id across its chunks.
    const first = (notifications[0]?.params as { update: { messageId?: string } }).update.messageId;
    const second = (notifications[1]?.params as { update: { messageId?: string } }).update.messageId;
    expect(first).toBe(second);
  });

  it("emits one tool_call at the observed final status for a lone observation — never invented phases", async () => {
    const session = makeSession(stubRunner({ toolEvents: [{ toolId: "read", status: "succeeded" }] }));
    const { adapter, notifications } = makeAdapter(session);
    const unwire = adapter.wireEvents(session);

    await session.prompt("go");
    unwire();

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: expect.any(String),
          title: "read",
          kind: "read",
          status: "completed"
        }
      }
    });
  });

  it("emits tool_call_update only for a later distinct real observation of the same derived id, with changed fields only", async () => {
    const session = makeSession(stubRunner({
      toolEvents: [
        { toolId: "bash", status: "blocked", detail: "mandate denied" },
        { toolId: "bash", status: "failed", detail: "exit 1" }
      ]
    }));
    const { adapter, notifications } = makeAdapter(session);
    const unwire = adapter.wireEvents(session);

    await session.prompt("go");
    unwire();

    expect(notifications).toHaveLength(2);
    const first = notifications[0]?.params as { update: Record<string, unknown> };
    const second = notifications[1]?.params as { update: Record<string, unknown> };
    expect(first.update).toMatchObject({ sessionUpdate: "tool_call", title: "bash", kind: "execute", status: "failed" });
    expect(second.update).toEqual({ sessionUpdate: "tool_call_update", toolCallId: first.update.toolCallId, status: "failed" });
  });

  it("maps tool kinds truthfully and never invents result, plan, thought, cost, location, or credential fields", async () => {
    const session = makeSession(stubRunner({
      toolEvents: [
        { toolId: "grep", status: "succeeded", inputPreview: "needle", outputPreview: "src/a.ts:1: needle" },
        { toolId: "edit", status: "failed", detail: "conflict" },
        { toolId: "custom_tool", status: "succeeded" }
      ]
    }));
    const { adapter, notifications } = makeAdapter(session);
    const unwire = adapter.wireEvents(session);

    await session.prompt("go");
    unwire();

    const kinds = notifications.map((n) => (n.params as { update: { kind: string } }).update.kind);
    expect(kinds).toEqual(["search", "edit", "other"]);
    const serialized = JSON.stringify(notifications);
    for (const banned of ["rawInput", "rawOutput", "outputPreview", "inputPreview", "needle", "credential", "cost", "locations", "plan", "thought"]) {
      expect(serialized).not.toContain(banned);
    }
  });

  it("derives opaque ACP-local toolCallIds without presenting them as provider ids", async () => {
    const session = makeSession(stubRunner({ toolEvents: [{ toolId: "read", status: "succeeded" }] }));
    const { adapter, notifications } = makeAdapter(session);
    const unwire = adapter.wireEvents(session);

    await session.prompt("go");
    unwire();

    const update = (notifications[0]?.params as { update: { toolCallId: string } }).update;
    expect(update.toolCallId).toMatch(/^acp-tool-/);
  });

  it("unwires cleanly: no notifications after unwire, no listener leak", async () => {
    const session = makeSession(stubRunner({ tokens: ["late"] }));
    const { adapter, notifications } = makeAdapter(session);
    const unwire = adapter.wireEvents(session);
    unwire();

    await session.prompt("go");

    expect(notifications).toEqual([]);
  });
});

describe("ACP adapter method boundary", () => {
  it("returns null for ACP methods outside the implemented subset so the transport can answer -32601", async () => {
    const { adapter } = makeAdapter(makeSession());
    for (const method of ["session/resume", "session/load", "session/cancel", "fs/read_text_file", "terminal/create"]) {
      const request = parseAcpJsonRpcRequest({ jsonrpc: "2.0", id: 12, method, params: {} });
      await expect(adapter.handleRequest(request!)).resolves.toBeNull();
    }
  });
});

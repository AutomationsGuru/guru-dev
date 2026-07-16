import { describe, expect, it, vi } from "vitest";

import { createRpcSessionGraph, type RpcForkSessionFactory } from "../../src/surfaces/rpcSessionGraph.js";
import { AgentSession, type TurnRunner } from "../../src/session/agentSession.js";
import type { AgentTurnResult } from "../../src/model/agentTurn.js";

const route = {
  routeId: "stub/model",
  apiFamily: "openai-chat-completions",
  modelId: "m",
  capabilities: { supportsTools: true },
  context: { contextWindowTokens: 128_000 }
} as never;

function makeSession(reply = "ok"): AgentSession {
  const runTurn = (async () => ({
    text: reply,
    modelId: "m",
    routeId: "stub/model",
    apiFamily: "openai-chat-completions",
    toolCallCount: 0,
    toolEvents: []
  } satisfies AgentTurnResult)) as TurnRunner;
  return new AgentSession({
    runtime: {
      executeTool: async () => ({
        toolId: "read",
        status: "succeeded",
        startedAt: "t",
        endedAt: "t",
        durationMs: 0
      })
    } as never,
    route,
    session: { id: "harness", repo: null, tools: [] } as never,
    sessionTools: [],
    mandate: { grants: [], denies: [] } as never,
    runTurn
  });
}

describe("RPC session graph", () => {
  it("registers one active root and exposes metadata without transcript content", () => {
    const root = makeSession();
    root.history.push({ role: "user", content: "private root prompt" });
    const graph = createRpcSessionGraph({ rootSessionId: "root", rootSession: root });

    expect(graph.tree()).toEqual({
      activeSessionId: "root",
      nodes: [
        {
          sessionId: "root",
          parentSessionId: null,
          forkHistoryIndex: null,
          historyLength: 1,
          childSessionIds: [],
          active: true
        }
      ]
    });
    expect(JSON.stringify(graph.tree())).not.toContain("private root prompt");
    expect(graph.activeSession).toBe(root);
  });

  it("forks through a user entry by value, activates the child, and leaves the parent isolated", async () => {
    const root = makeSession();
    root.history.push(
      { role: "system", content: "system" },
      { role: "user", content: "branch here" },
      { role: "assistant", content: "parent reply" }
    );
    const child = makeSession();
    const createForkSession: RpcForkSessionFactory = vi.fn(async () => ({
      sessionId: "child",
      session: child
    }));
    const graph = createRpcSessionGraph({ rootSessionId: "root", rootSession: root, createForkSession });

    await expect(graph.fork({ parentSessionId: "root", throughHistoryIndex: 1 })).resolves.toEqual({
      sessionId: "child",
      parentSessionId: "root",
      copiedHistoryLength: 2
    });

    expect(child.history).toEqual(root.history.slice(0, 2));
    expect(child.history).not.toBe(root.history);
    expect(child.history[0]).not.toBe(root.history[0]);
    child.history[0] = { role: "system", content: "changed only in child" };
    child.history.push({ role: "assistant", content: "child reply" });
    expect(root.history).toHaveLength(3);
    expect(root.history[0]?.content).toBe("system");
    expect(graph.activeSession).toBe(child);
    expect(graph.tree()).toMatchObject({
      activeSessionId: "child",
      nodes: [
        { sessionId: "root", childSessionIds: ["child"], active: false },
        {
          sessionId: "child",
          parentSessionId: "root",
          forkHistoryIndex: 1,
          historyLength: 3,
          active: true
        }
      ]
    });
  });

  it("rejects invalid parents and history indexes before calling the factory", async () => {
    const root = makeSession();
    root.history.push(
      { role: "system", content: "system" },
      { role: "user", content: "valid" },
      { role: "assistant", content: "reply" }
    );
    const createForkSession = vi.fn(async () => ({ sessionId: "child", session: makeSession() }));
    const graph = createRpcSessionGraph({ rootSessionId: "root", rootSession: root, createForkSession });

    await expect(graph.fork({ parentSessionId: "missing", throughHistoryIndex: 1 })).rejects.toThrow(
      "RPC session graph: unknown parent session."
    );
    for (const throughHistoryIndex of [-1, 1.5, 9]) {
      await expect(graph.fork({ parentSessionId: "root", throughHistoryIndex })).rejects.toThrow(
        "RPC session graph: throughHistoryIndex must identify an existing user message."
      );
    }
    await expect(graph.fork({ parentSessionId: "root", throughHistoryIndex: 0 })).rejects.toThrow(
      "RPC session graph: throughHistoryIndex must identify an existing user message."
    );
    await expect(graph.fork({ parentSessionId: "root", throughHistoryIndex: 2 })).rejects.toThrow(
      "RPC session graph: throughHistoryIndex must identify an existing user message."
    );
    expect(createForkSession).not.toHaveBeenCalled();
    expect(graph.tree().nodes).toHaveLength(1);
  });

  it("reports unsupported and factory failure without changing graph state", async () => {
    const root = makeSession();
    root.history.push({ role: "user", content: "fork" });
    const unsupported = createRpcSessionGraph({ rootSessionId: "root", rootSession: root });

    await expect(unsupported.fork({ throughHistoryIndex: 0 })).rejects.toThrow(
      "RPC session graph: forking is unsupported without a fork-session factory."
    );

    const graph = createRpcSessionGraph({
      rootSessionId: "root",
      rootSession: root,
      createForkSession: async () => {
        throw new Error("provider credential should not leak");
      }
    });
    await expect(graph.fork({ throughHistoryIndex: 0 })).rejects.toThrow(
      "RPC session graph: fork session factory failed."
    );
    expect(graph.tree()).toMatchObject({ activeSessionId: "root", nodes: [{ sessionId: "root" }] });
    expect(JSON.stringify(graph.tree())).not.toContain("credential");
  });

  it("closes a created session on duplicate id or non-distinct session registration failure", async () => {
    const root = makeSession();
    root.history.push({ role: "user", content: "fork" });
    const closeDuplicate = vi.fn(async () => {});
    const duplicate = createRpcSessionGraph({
      rootSessionId: "root",
      rootSession: root,
      createForkSession: async () => ({ sessionId: "root", session: makeSession(), close: closeDuplicate })
    });

    await expect(duplicate.fork({ throughHistoryIndex: 0 })).rejects.toThrow(
      "RPC session graph: fork session id is already registered."
    );
    expect(closeDuplicate).toHaveBeenCalledOnce();
    expect(duplicate.tree().nodes).toHaveLength(1);

    const closeSame = vi.fn(async () => {});
    const same = createRpcSessionGraph({
      rootSessionId: "root",
      rootSession: root,
      createForkSession: async () => ({ sessionId: "other", session: root, close: closeSame })
    });
    await expect(same.fork({ throughHistoryIndex: 0 })).rejects.toThrow(
      "RPC session graph: fork factory must return a distinct session."
    );
    expect(closeSame).toHaveBeenCalledOnce();
    expect(same.tree().nodes).toHaveLength(1);
  });

  it("rolls back when a created session cannot accept the copied history", async () => {
    const root = makeSession();
    root.history.push({ role: "user", content: "fork" });
    const child = makeSession();
    Object.freeze(child.history);
    const close = vi.fn(async () => {});
    const graph = createRpcSessionGraph({
      rootSessionId: "root",
      rootSession: root,
      createForkSession: async () => ({ sessionId: "child", session: child, close })
    });

    await expect(graph.fork({ throughHistoryIndex: 0 })).rejects.toThrow(
      "RPC session graph: fork session registration failed."
    );
    expect(close).toHaveBeenCalledOnce();
    expect(graph.tree()).toMatchObject({ activeSessionId: "root", nodes: [{ sessionId: "root" }] });
  });

  it("caps the graph at 64 nodes without creating an overflow session", async () => {
    const root = makeSession();
    root.history.push({ role: "user", content: "fork" });
    let next = 0;
    const createForkSession = vi.fn(async () => ({
      sessionId: `child-${++next}`,
      session: makeSession()
    }));
    const graph = createRpcSessionGraph({ rootSessionId: "root", rootSession: root, createForkSession });

    for (let index = 0; index < 63; index += 1) {
      await graph.fork({ parentSessionId: "root", throughHistoryIndex: 0 });
    }
    expect(graph.tree().nodes).toHaveLength(64);
    await expect(graph.fork({ parentSessionId: "root", throughHistoryIndex: 0 })).rejects.toThrow(
      "RPC session graph: session limit reached."
    );
    expect(createForkSession).toHaveBeenCalledTimes(63);
  });

  it("blocks fork and switch during turns, then switches exactly once per real active change", async () => {
    const root = makeSession();
    root.history.push({ role: "user", content: "root prompt" });
    const child = makeSession();
    const graph = createRpcSessionGraph({
      rootSessionId: "root",
      rootSession: root,
      createForkSession: async () => ({ sessionId: "child", session: child })
    });
    await graph.fork({ throughHistoryIndex: 0 });
    const activeChanges: string[] = [];
    const unsubscribe = graph.subscribeActiveSession((sessionId) => activeChanges.push(sessionId));
    let releaseTurn: (() => void) | undefined;
    const turn = graph.withActiveTurn(
      () => new Promise<void>((resolve) => {
        releaseTurn = resolve;
      })
    );

    expect(() => graph.switchSession("root")).toThrow("RPC session graph: active session has a running turn.");
    await expect(graph.fork({ parentSessionId: "child", throughHistoryIndex: 0 })).rejects.toThrow(
      "RPC session graph: parent session has a running turn."
    );
    await expect(graph.fork({ parentSessionId: "root", throughHistoryIndex: 0 })).rejects.toThrow(
      "RPC session graph: active session has a running turn."
    );
    releaseTurn?.();
    await turn;

    expect(graph.switchSession("root")).toEqual({ sessionId: "root" });
    expect(graph.switchSession("root")).toEqual({ sessionId: "root" });
    expect(activeChanges).toEqual(["root"]);
    expect(() => graph.switchSession("missing")).toThrow("RPC session graph: unknown session.");
    unsubscribe();
  });
});

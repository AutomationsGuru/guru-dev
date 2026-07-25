import { createSessionEventBus, wireAgentSessionToBus, type AgentSessionEventSource } from '../../src/session/eventBus.js';
import type { AgentSessionEvent, AgentSessionEvents } from '../../src/session/agentSession.js';

interface MockAgentSession extends AgentSessionEventSource {
  emit<E extends AgentSessionEvent>(event: E, payload: AgentSessionEvents[E]): void;
}

function createMockSession(): MockAgentSession {
  const listeners = new Map<AgentSessionEvent, Set<(...payload: any[]) => void>>();

  return {
    subscribe<E extends AgentSessionEvent>(event: E, listener: (payload: AgentSessionEvents[E]) => void): () => void {
      const existing = listeners.get(event);
      if (existing) {
        existing.add(listener as any);
      } else {
        listeners.set(event, new Set([listener as any]));
      }
      return () => listeners.get(event)?.delete(listener as any);
    },
    emit<E extends AgentSessionEvent>(event: E, payload: AgentSessionEvents[E]): void {
      const existing = listeners.get(event);
      if (existing) {
        for (const listener of existing) {
          (listener as any)(payload);
        }
      }
    }
  };
}

describe("createSessionEventBus", () => {
  it("delivers typed events in subscriber order", () => {
    const bus = createSessionEventBus();
    const received: Array<{ type: string; payload: unknown }> = [];

    bus.subscribe("tool_end", (payload) => received.push({ type: "tool_end", payload }));
    bus.subscribe("compact", (payload) => received.push({ type: "compact", payload }));
    bus.subscribe("error", (payload) => received.push({ type: "error", payload }));

    bus.emit("tool_end", { toolId: "read", output: "hello" });
    bus.emit("compact", { reason: "manual", beforeTokens: 100 });
    bus.emit("error", { message: "boom" });
    bus.emit("tool_end", { toolId: "bash", output: "done" });

    expect(received).toEqual([
      { type: "tool_end", payload: { toolId: "read", output: "hello" } },
      { type: "compact", payload: { reason: "manual", beforeTokens: 100 } },
      { type: "error", payload: { message: "boom" } },
      { type: "tool_end", payload: { toolId: "bash", output: "done" } }
    ]);
  });

  it("unsubscribe stops further delivery for that listener", () => {
    const bus = createSessionEventBus();
    const received: unknown[] = [];

    const unsubscribe = bus.subscribe("tool_start", (payload) => received.push(payload));
    bus.emit("tool_start", { toolId: "edit", input: { path: "a" } });
    unsubscribe();
    bus.emit("tool_start", { toolId: "write", input: { path: "b" } });

    expect(received).toEqual([{ toolId: "edit", input: { path: "a" } }]);
  });

  it("preserves typed payload structure per event type", () => {
    const bus = createSessionEventBus();
    const received: { toolId: string; input?: unknown }[] = [];

    bus.subscribe("tool_start", (payload) => received.push(payload));
    bus.emit("tool_start", { toolId: "grep", input: { pattern: "foo" } });

    expect(received).toEqual([{ toolId: "grep", input: { pattern: "foo" } }]);
  });
});

describe("wireAgentSessionToBus", () => {
  it("maps AgentSession tool.observation to typed tool_end events in order", () => {
    const session = createMockSession();
    const bus = createSessionEventBus();
    wireAgentSessionToBus(session, bus);

    const received: unknown[] = [];
    bus.subscribe("tool_end", (payload) => received.push(payload));

    session.emit("tool.observation", {
      toolId: "read",
      status: "succeeded",
      detail: "file content"
    } as AgentSessionEvents["tool.observation"]);
    session.emit("tool.observation", {
      toolId: "bash",
      status: "failed",
      detail: "exit 1"
    } as AgentSessionEvents["tool.observation"]);
    // A blocked observation should not produce a tool_end event in this mapping.
    session.emit("tool.observation", {
      toolId: "write",
      status: "blocked"
    } as AgentSessionEvents["tool.observation"]);

    expect(received).toEqual([
      { toolId: "read", output: "file content" },
      { toolId: "bash", output: "exit 1", error: { message: "exit 1" } }
    ]);
  });

  it("maps AgentSession compaction events to typed compact", () => {
    const session = createMockSession();
    const bus = createSessionEventBus();
    wireAgentSessionToBus(session, bus);

    const received: unknown[] = [];
    bus.subscribe("compact", (payload) => received.push(payload));

    session.emit("compaction.start", {
      reason: "manual",
      beforeTokens: 1_200,
      historyLength: 50
    } as AgentSessionEvents["compaction.start"]);
    session.emit("compaction.end", {
      compacted: true,
      summaryCount: 1,
      beforeTokens: 1_200,
      afterTokens: 300
    } as AgentSessionEvents["compaction.end"]);
    session.emit("compaction.end", {
      compacted: false,
      reason: "nothing-to-compact"
    } as AgentSessionEvents["compaction.end"]);

    expect(received).toEqual([
      { reason: "manual", beforeTokens: 1_200 },
      { reason: "manual", beforeTokens: 1_200, afterTokens: 300 }
    ]);
  });
});

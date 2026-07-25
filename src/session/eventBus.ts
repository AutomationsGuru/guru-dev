/**
 * Session event adapter — a typed dispatcher that maps the AgentSession's native
 * events into the stable SessionEvent vocabulary declared in eventTypes.ts.
 *
 * The adapter is owned per subscriber surface: a caller creates a new adapter with
 * createSessionEventBus(), subscribes its own listeners, and (optionally) wires it
 * to a native AgentSession using wireAgentSessionToBus(). The resulting adapter is
 * local, not a global singleton, and does not introduce a second independent runtime
 * bus outside the AgentSession seams already present in the tree.
 */

import type { AgentSessionEvent, AgentSessionEvents } from "./agentSession.js";
import type { SessionEventType, SessionEventMap, SessionEventListener } from "./eventTypes.js";

export interface SessionEventBus {
  subscribe<T extends SessionEventType>(event: T, listener: SessionEventListener<T>): () => void;
  unsubscribe<T extends SessionEventType>(event: T, listener: SessionEventListener<T>): void;
  emit<T extends SessionEventType>(event: T, payload: SessionEventMap[T]): void;
}

export interface AgentSessionEventSource {
  subscribe<E extends AgentSessionEvent>(event: E, listener: (payload: AgentSessionEvents[E]) => void): () => void;
}

export function createSessionEventBus(): SessionEventBus {
  const listeners = new Map<SessionEventType, Set<SessionEventListener<SessionEventType>>>();

  const bus: SessionEventBus = {
    subscribe<T extends SessionEventType>(event: T, listener: SessionEventListener<T>): () => void {
      const existing = listeners.get(event);
      if (existing) {
        existing.add(listener as SessionEventListener<SessionEventType>);
      } else {
        listeners.set(event, new Set([listener as SessionEventListener<SessionEventType>]));
      }
      return () => bus.unsubscribe(event, listener);
    },
    unsubscribe<T extends SessionEventType>(event: T, listener: SessionEventListener<T>): void {
      listeners.get(event)?.delete(listener as SessionEventListener<SessionEventType>);
    },
    emit<T extends SessionEventType>(event: T, payload: SessionEventMap[T]): void {
      const existing = listeners.get(event);
      if (existing) {
        for (const listener of existing) {
          (listener as SessionEventListener<T>)(payload);
        }
      }
    }
  };

  return bus;
}

/**
 * Wire an existing AgentSession into a typed session bus. Native events are mapped
 * as follows:
 *
 * - `tool.observation` with status "succeeded" -> `tool_end` (output = detail).
 * - `tool.observation` with status "failed"     -> `tool_end` (error = detail).
 * - `compaction.start`                           -> `compact` (beforeTokens only).
 * - `compaction.end` with compacted true         -> `compact` (beforeTokens, afterTokens).
 *
 * `tool_start` and `error` are not currently emitted by AgentSession; they live in
 * the typed vocabulary for surfaces that will emit them locally or for a future
 * workspace event bus integration.
 */
export function wireAgentSessionToBus(session: AgentSessionEventSource, bus: SessionEventBus): void {
  session.subscribe("tool.observation", (observation) => {
    if (observation.status === "succeeded") {
      bus.emit("tool_end", { toolId: observation.toolId, output: observation.detail });
    } else if (observation.status === "failed") {
      bus.emit("tool_end", {
        toolId: observation.toolId,
        output: observation.detail,
        error: { message: observation.detail ?? "tool failed" }
      });
    }
  });

  session.subscribe("compaction.start", (event) => {
    bus.emit("compact", { reason: "manual", beforeTokens: event.beforeTokens });
  });

  session.subscribe("compaction.end", (event) => {
    if (event.compacted) {
      bus.emit("compact", {
        reason: "manual",
        beforeTokens: event.beforeTokens,
        afterTokens: event.afterTokens
      });
    }
  });
}

/**
 * Typed event vocabulary for session-level subscribers (TUI, RPC, composer tail).
 *
 * This is a type-mapping adapter, not a second runtime bus. The existing
 * AgentSession already emits typed session events (turn.*, token, tool.observation,
 * compaction.*, aborted). This adapter maps those native events into a stable
 * subscriber-facing vocabulary so that callers do not depend on the internal
 * AgentSession event name spelling.
 */

export type SessionEventType = "tool_start" | "tool_end" | "compact" | "error";

export type SessionEventMap = {
  /** A tool execution has begun on the session. */
  tool_start: { readonly toolId: string; readonly input?: unknown };
  /** A tool execution has completed (or failed/blocked) on the session. */
  tool_end: {
    readonly toolId: string;
    readonly output?: unknown;
    readonly error?: { readonly message: string };
  };
  /** A compaction cycle produced a new summary (or was attempted). */
  compact: {
    readonly reason: "manual" | "auto";
    readonly beforeTokens: number;
    readonly afterTokens?: number;
  };
  /** A session-level error occurred. */
  error: { readonly message: string; readonly cause?: unknown };
};

export type SessionEventListener<T extends SessionEventType> = (payload: SessionEventMap[T]) => void;

export type SessionEventPayload<T extends SessionEventType> = SessionEventMap[T];

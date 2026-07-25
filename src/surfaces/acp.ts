import { z } from "zod";

import type { AgentSession } from "../session/agentSession.js";
import type { AgentToolEvent } from "../model/agentTurn.js";

/**
 * ACP compatibility adapter (G831) — an explicitly named, bounded subset of the
 * Agent Client Protocol (ACP v1) translated onto Guru's existing AgentSession.
 *
 * This is NOT full ACP conformance: it implements `initialize`, `session/new`,
 * `session/prompt`, and `session/update` notifications (agent message chunks +
 * truthful tool lifecycle) over the existing LF-delimited JSONL transport. It
 * adds no HTTP/SSE, no multi-session persistence, no MCP, no plan/thought
 * chunks, and no provider-specific extensions. Every emitted field must be
 * backed by a real Guru observation — the adapter never invents content,
 * results, costs, locations, or credential material.
 */

export const ACP_JSON_RPC_VERSION = "2.0" as const;
export const ACP_PROTOCOL_VERSION = 1 as const;

const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_INTERNAL_ERROR = -32603;
export const ACP_METHOD_NOT_FOUND = JSON_RPC_METHOD_NOT_FOUND;
export const ACP_INVALID_REQUEST = JSON_RPC_INVALID_REQUEST;

export type AcpRequestId = string | number;

/** A parsed ACP JSON-RPC 2.0 request envelope (id preserved exactly). */
export interface AcpJsonRpcRequest {
  readonly jsonrpc: typeof ACP_JSON_RPC_VERSION;
  readonly id?: AcpRequestId | undefined;
  readonly method: string;
  readonly params?: Record<string, unknown> | undefined;
}

export type AcpEmit = (message: Record<string, unknown>) => void;

const AcpEnvelopeSchema = z
  .object({
    jsonrpc: z.literal(ACP_JSON_RPC_VERSION),
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

const InitializeParamsSchema = z
  .object({
    protocolVersion: z.number(),
    clientCapabilities: z.record(z.string(), z.unknown())
  })
  .strict();

const SessionNewParamsSchema = z
  .object({
    cwd: z.string().min(1),
    mcpServers: z.array(z.unknown())
  })
  .strict();

const TextContentBlockSchema = z
  .object({
    type: z.literal("text"),
    text: z.string()
  })
  .strict();

const SessionPromptParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    prompt: z.array(z.object({ type: z.string() }).loose()).min(1)
  })
  .strict();

/**
 * Detect and parse an ACP JSON-RPC 2.0 envelope. Returns null for anything
 * that is not an ACP envelope (including legacy Guru RPC requests, which carry
 * no `jsonrpc` member) so the caller can route those to legacy dispatch.
 */
export function parseAcpJsonRpcRequest(raw: unknown): AcpJsonRpcRequest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const parsed = AcpEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data;
}

/** True when the raw value looks like an ACP envelope but fails strict parsing. */
export function isMalformedAcpEnvelope(raw: unknown): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    (raw as Record<string, unknown>).jsonrpc === ACP_JSON_RPC_VERSION &&
    parseAcpJsonRpcRequest(raw) === null
  );
}

export interface AcpSessionAdapterDeps {
  /** The active Guru session this ACP session binds to (identity only — never recreated). */
  readonly session: AgentSession;
  /** The session identity the transport already owns (graph/root id). */
  readonly sessionId: string;
  /** The active repository/cwd this transport was started in. */
  readonly cwd: string;
  readonly emit: AcpEmit;
  readonly agentName?: string;
  readonly agentVersion?: string;
}

export interface AcpSessionAdapter {
  /**
   * Handle one ACP request. Returns the JSON-RPC response object, or null when
   * the method is outside the implemented subset (the transport answers -32601).
   */
  handleRequest(request: AcpJsonRpcRequest): Promise<Record<string, unknown> | null>;
  /** Subscribe ACP update translation to a session's typed events. */
  wireEvents(session: AgentSession): () => void;
}

const TOOL_KIND_MAP: Readonly<Record<string, string>> = {
  read: "read",
  edit: "edit",
  write: "edit",
  bash: "execute",
  grep: "search",
  glob: "search",
  ls: "search",
  fetch: "fetch"
};

function mapToolKind(toolId: string): string {
  return TOOL_KIND_MAP[toolId] ?? "other";
}

function invalidParams(id: AcpRequestId | undefined, message: string): Record<string, unknown> {
  return {
    jsonrpc: ACP_JSON_RPC_VERSION,
    ...(id !== undefined ? { id } : { id: null }),
    error: { code: JSON_RPC_INVALID_PARAMS, message }
  };
}

function internalError(id: AcpRequestId | undefined, message: string): Record<string, unknown> {
  return {
    jsonrpc: ACP_JSON_RPC_VERSION,
    ...(id !== undefined ? { id } : { id: null }),
    error: { code: JSON_RPC_INTERNAL_ERROR, message }
  };
}

export function createAcpSessionAdapter(deps: AcpSessionAdapterDeps): AcpSessionAdapter {
  const agentName = deps.agentName ?? "GuruHarness";
  const agentVersion = deps.agentVersion ?? "unknown";
  // Turn-scoped counters keep derived ids stable, opaque, and ACP-local.
  let turnCounter = 0;
  let currentMessageId: string | null = null;
  let toolSequence = 0;
  let lastTool: { readonly toolId: string; readonly toolCallId: string } | null = null;

  const emitUpdate = (update: Record<string, unknown>): void => {
    deps.emit({
      jsonrpc: ACP_JSON_RPC_VERSION,
      method: "session/update",
      params: { sessionId: deps.sessionId, update }
    });
  };

  const onTurnStart = (): void => {
    turnCounter += 1;
    currentMessageId = `acp-msg-${turnCounter}`;
    toolSequence = 0;
    lastTool = null;
  };

  const onToken = (payload: { readonly chunk: string }): void => {
    emitUpdate({
      sessionUpdate: "agent_message_chunk",
      ...(currentMessageId !== null ? { messageId: currentMessageId } : {}),
      content: { type: "text", text: payload.chunk }
    });
  };

  const onToolObservation = (event: AgentToolEvent): void => {
    toolSequence += 1;
    const observedStatus = event.status === "succeeded" ? "completed" : "failed";
    if (lastTool !== null && lastTool.toolId === event.toolId) {
      // A later, distinct real observation of the same derived call: report only
      // the observed changed field. The Guru stream carries outcomes only, so a
      // repeated observation of the same tool is progress on that one call, never
      // an invented pending/in-progress phase.
      emitUpdate({ sessionUpdate: "tool_call_update", toolCallId: lastTool.toolCallId, status: observedStatus });
      return;
    }
    // ACP-local opaque id — derived from the real session/tool observation
    // sequence, never presented as a provider-supplied id.
    const toolCallId = `acp-tool-${turnCounter}-${toolSequence}`;
    lastTool = { toolId: event.toolId, toolCallId };
    emitUpdate({
      sessionUpdate: "tool_call",
      toolCallId,
      title: event.toolId,
      kind: mapToolKind(event.toolId),
      status: observedStatus
    });
  };

  return {
    async handleRequest(request) {
      switch (request.method) {
        case "initialize": {
          const params = InitializeParamsSchema.safeParse(request.params ?? {});
          if (!params.success) {
            return invalidParams(request.id, "initialize: requires numeric protocolVersion and clientCapabilities.");
          }
          return {
            jsonrpc: ACP_JSON_RPC_VERSION,
            id: request.id ?? null,
            result: {
              protocolVersion: ACP_PROTOCOL_VERSION,
              agentCapabilities: {
                loadSession: false,
                promptCapabilities: { image: false, audio: false, embeddedContext: false }
              },
              agentInfo: { name: agentName, version: agentVersion },
              authMethods: []
            }
          };
        }
        case "session/new": {
          const params = SessionNewParamsSchema.safeParse(request.params ?? {});
          if (!params.success) {
            return invalidParams(request.id, "session/new: requires cwd and mcpServers.");
          }
          if (!params.data.cwd.startsWith("/") || params.data.cwd !== deps.cwd) {
            return invalidParams(request.id, "session/new: this subset accepts only the active repository cwd.");
          }
          if (params.data.mcpServers.length > 0) {
            return invalidParams(request.id, "session/new: MCP servers are unsupported; this subset advertises no MCP capability.");
          }
          // Bind to the already-active Guru session: never create a new runtime,
          // change cwd, connect a server, or clear history.
          return {
            jsonrpc: ACP_JSON_RPC_VERSION,
            id: request.id ?? null,
            result: { sessionId: deps.sessionId }
          };
        }
        case "session/prompt": {
          const params = SessionPromptParamsSchema.safeParse(request.params ?? {});
          if (!params.success) {
            return invalidParams(request.id, "session/prompt: requires sessionId and a non-empty prompt content block array.");
          }
          if (params.data.sessionId !== deps.sessionId) {
            return invalidParams(request.id, `session/prompt: unknown session '${params.data.sessionId}'.`);
          }
          const texts: string[] = [];
          for (const block of params.data.prompt) {
            const text = TextContentBlockSchema.safeParse(block);
            if (!text.success) {
              return invalidParams(request.id, `session/prompt: unsupported content block type '${block.type}'.`);
            }
            texts.push(text.data.text);
          }
          try {
            await deps.session.promptDrainingFollowUps(texts.join(""));
          } catch (error) {
            return internalError(request.id, error instanceof Error ? error.message : String(error));
          }
          return {
            jsonrpc: ACP_JSON_RPC_VERSION,
            id: request.id ?? null,
            result: { stopReason: "end_turn" }
          };
        }
        default:
          return null;
      }
    },
    wireEvents(session) {
      const unsubs = [
        session.subscribe("turn.start", onTurnStart),
        session.subscribe("token", onToken),
        session.subscribe("tool.observation", onToolObservation)
      ];
      return () => {
        for (const unsub of unsubs) unsub();
      };
    }
  };
}

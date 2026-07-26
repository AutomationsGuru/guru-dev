import { z } from "zod";

/**
 * Multi-agent OAI serve stub.
 * Routes OpenAI-compatible chat completion requests to a fleet member
 * via header (x-agent-id) or body field (agent_id / agentId).
 *
 * Stub only — no cloud auth, no telemetry, hard limits respected.
 */

export const AgentRouteRequestSchema = z.object({
  headers: z.record(z.union([z.string(), z.array(z.string()), z.undefined()])),
  body: z.record(z.unknown()).optional(),
});

export type AgentRouteRequest = z.infer<typeof AgentRouteRequestSchema>;

export interface RouteSuccess {
  readonly agentId: string;
}

export interface RouteError {
  readonly status: 400;
  readonly error: string;
}

const KNOWN_AGENT_PREFIX = "agent-";

export function route(request: AgentRouteRequest): RouteSuccess | RouteError {
  const parsed = AgentRouteRequestSchema.safeParse(request);
  if (!parsed.success) {
    return { status: 400, error: "invalid request shape" };
  }

  const headers = parsed.data.headers;
  const body = parsed.data.body ?? {};

  // Prefer header, then body fields (support common casings)
  const rawAgentId =
    headers["x-agent-id"] ??
    headers["X-Agent-Id"] ??
    (body as any)?.agent_id ??
    (body as any)?.agentId ??
    (body as any)?.agentID;

  const agentId =
    Array.isArray(rawAgentId) ? rawAgentId[0] : rawAgentId;

  if (typeof agentId !== "string" || agentId.length === 0) {
    return {
      status: 400,
      error: "agent routing required via x-agent-id header or agent_id body field",
    };
  }

  // Stub validation: unknown agent → 400 (fleet member not registered)
  if (!agentId.startsWith(KNOWN_AGENT_PREFIX)) {
    return {
      status: 400,
      error: `unknown agent: ${agentId}`,
    };
  }

  return { agentId };
}

export function isRouteError(result: RouteSuccess | RouteError): result is RouteError {
  return "status" in result && result.status === 400;
}

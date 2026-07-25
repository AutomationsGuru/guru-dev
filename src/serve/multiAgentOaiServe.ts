import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";

/**
 * Multi-agent OAI serve stub (IDEA-F274-OAI-SERVE-01).
 *
 * Exposes a minimal OpenAI-compatible /v1/chat/completions endpoint
 * that routes via header or body field to a known fleet member (agentId).
 * Unknown agents → 400. Stub responses only; no real model calls.
 *
 * Owned exclusively by this module per build plan. Matches node:http
 * patterns from surfaces/api.ts and oauth login handlers.
 */

export interface MultiAgentOaiServeOptions {
  agents: Record<string, { id: string; model?: string }>;
}

export interface RouteRequest {
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
}

const AgentIdSchema = z.string().min(1);

export function routeToAgentId(req: RouteRequest): string | null {
  const headers = req.headers ?? {};
  // Prefer X-Agent-Id (case-insensitive lookup)
  const agentHeader =
    (headers["x-agent-id"] as string) ||
    (headers["X-Agent-Id"] as string) ||
    (headers["X-AGENT-ID"] as string);
  if (agentHeader) {
    const parsed = AgentIdSchema.safeParse(agentHeader);
    if (parsed.success) return parsed.data;
  }

  // Fallback to body fields for routing
  const body = req.body as Record<string, unknown> | undefined;
  if (body) {
    if (typeof body.agent === "string") {
      const parsed = AgentIdSchema.safeParse(body.agent);
      if (parsed.success) return parsed.data;
    }
    const routing = body.routing as Record<string, unknown> | undefined;
    if (routing && typeof routing.agentId === "string") {
      const parsed = AgentIdSchema.safeParse(routing.agentId);
      if (parsed.success) return parsed.data;
    }
  }
  return null;
}

function sendJson(res: ServerResponse, status: number, obj: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(obj));
}

export function createMultiAgentOaiServe(options: MultiAgentOaiServeOptions) {
  const { agents } = options;

  // Returns a node:http request handler (matches surfaces/api.ts + oauth login patterns)
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    // Read full request body (POST JSON) before routing decision
    const bodyStr = await new Promise<string>((resolve, reject) => {
      let data = "";
      req.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });

    let body: unknown = {};
    try {
      body = bodyStr ? JSON.parse(bodyStr) : {};
    } catch {
      sendJson(res, 400, { error: "invalid json" });
      return;
    }

    const agentId = routeToAgentId({ headers: req.headers as any, body });
    if (!agentId) {
      sendJson(res, 400, { error: "missing agent routing" });
      return;
    }
    if (!agents[agentId]) {
      sendJson(res, 400, { error: `unknown agent: ${agentId}` });
      return;
    }

    // Fleet member stub response (200, OpenAI chat.completions shape)
    const stub = {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: agents[agentId]?.model ?? "stub",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: `Stub response from agent ${agentId}`,
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    sendJson(res, 200, stub);
  };
}

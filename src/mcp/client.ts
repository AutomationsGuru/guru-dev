import { z } from "zod";

import { connectStdioJsonRpc, type JsonRpcConnection, type JsonRpcStdioOptions } from "./jsonRpcStdio.js";
import {
  McpToolDescriptorSchema,
  type McpServerConfig,
  type McpServerStatus,
  type McpToolDescriptor
} from "./schemas.js";

/**
 * MCP client (spec 2025-03-26, stdio transport) — the concrete half of the
 * never-stuck ATTACH move: connect to whatever MCP server the environment
 * offers, handshake, discover its tools, call them. v1 is stdio-only; http/sse
 * report not-implemented through readiness rather than failing at call time.
 *
 * Secret constitution: readiness checks env PRESENCE only (names, never values);
 * env values flow to the child process and nowhere else.
 */

export const MCP_PROTOCOL_VERSION = "2025-03-26";

const InitializeResultSchema = z
  .object({
    protocolVersion: z.string(),
    serverInfo: z.object({ name: z.string(), version: z.string().optional() }).partial().optional(),
    capabilities: z.record(z.string(), z.unknown()).optional()
  })
  .loose();

const ToolsListResultSchema = z
  .object({
    tools: z.array(
      z
        .object({
          name: z.string().min(1),
          title: z.string().optional(),
          description: z.string().optional(),
          inputSchema: z.record(z.string(), z.unknown()).optional()
        })
        .loose()
    ),
    nextCursor: z.string().optional()
  })
  .loose();

const ContentPartSchema = z
  .object({
    type: z.string(),
    text: z.string().optional()
  })
  .loose();

const ToolsCallResultSchema = z
  .object({
    content: z.array(ContentPartSchema).default([]),
    structuredContent: z.unknown().optional(),
    isError: z.boolean().default(false)
  })
  .loose();

export interface McpToolCallOutput {
  /** Concatenated text content parts (the common case). */
  readonly text: string;
  readonly structuredContent?: unknown;
  readonly isError: boolean;
}

export interface McpClient {
  readonly serverId: string;
  readonly serverInfo: { readonly name?: string; readonly version?: string; readonly protocolVersion: string };
  listTools(options?: { timeoutMs?: number }): Promise<readonly McpToolDescriptor[]>;
  callTool(name: string, args: Record<string, unknown>, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<McpToolCallOutput>;
  close(): Promise<void>;
  /** Bounded, secret-scrubbed stderr tail for diagnostics. */
  stderrTail(): string;
}

export interface ConnectMcpServerOptions {
  readonly config: McpServerConfig;
  readonly env?: NodeJS.ProcessEnv;
  readonly clientInfo?: { readonly name: string; readonly version: string };
  /** Injectable transport factory — the seam tests stub. */
  readonly connect?: (options: JsonRpcStdioOptions) => JsonRpcConnection;
}

/** Presence-only readiness: names checked, values never read into any output. */
export function checkMcpReadiness(config: McpServerConfig, env: NodeJS.ProcessEnv = process.env): McpServerStatus {
  const base = { serverId: config.id, transport: config.transport, missingEnvNames: [] as string[] };
  if (!config.enabled) {
    return { ...base, status: "disabled", summary: `${config.id} is disabled by config.` };
  }
  if (config.transport !== "stdio") {
    return { ...base, status: "not-implemented", summary: `${config.id}: ${config.transport} transport is not implemented yet (stdio only).` };
  }
  if (!config.command) {
    return { ...base, status: "missing-command", summary: `${config.id} has no launch command configured.` };
  }
  const missing = config.requiredEnvNames.filter((name) => (env[name] ?? "").length === 0);
  if (missing.length > 0) {
    return { ...base, status: "missing-env", missingEnvNames: missing, summary: `${config.id} is missing env: ${missing.join(", ")}.` };
  }
  return { ...base, status: "ready", summary: `${config.id} is ready (stdio).` };
}

const MAX_TOOL_PAGES = 16;

export async function connectMcpServer(options: ConnectMcpServerOptions): Promise<McpClient> {
  const { config } = options;
  const readiness = checkMcpReadiness(config, options.env ?? process.env);
  if (readiness.status !== "ready") {
    throw new Error(`Cannot connect ${config.id}: ${readiness.summary}`);
  }

  const connect = options.connect ?? connectStdioJsonRpc;
  const connection = connect({
    command: config.command!,
    args: config.args,
    env: options.env ?? process.env,
    defaultTimeoutMs: config.timeoutMs
  });

  let initialized: z.infer<typeof InitializeResultSchema>;
  try {
    const raw = await connection.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: options.clientInfo ?? { name: "guruharness", version: "1.x" }
    });
    initialized = InitializeResultSchema.parse(raw);
    connection.notify("notifications/initialized");
  } catch (error) {
    await connection.close();
    throw error;
  }

  return {
    serverId: config.id,
    serverInfo: {
      ...(initialized.serverInfo?.name !== undefined ? { name: initialized.serverInfo.name } : {}),
      ...(initialized.serverInfo?.version !== undefined ? { version: initialized.serverInfo.version } : {}),
      protocolVersion: initialized.protocolVersion
    },
    async listTools(listOptions) {
      const tools: McpToolDescriptor[] = [];
      let cursor: string | undefined;
      // Bounded pagination — a server that loops its cursor cannot spin us forever.
      for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
        const raw = await connection.request(
          "tools/list",
          cursor !== undefined ? { cursor } : {},
          listOptions?.timeoutMs !== undefined ? { timeoutMs: listOptions.timeoutMs } : {}
        );
        const parsed = ToolsListResultSchema.parse(raw);
        for (const tool of parsed.tools) {
          tools.push(
            McpToolDescriptorSchema.parse({
              serverId: config.id,
              name: tool.name,
              ...(tool.title !== undefined ? { title: tool.title } : {}),
              ...(tool.description !== undefined ? { description: tool.description } : {}),
              ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {})
            })
          );
        }
        if (!parsed.nextCursor) {
          break;
        }
        cursor = parsed.nextCursor;
      }
      return tools;
    },
    async callTool(name, args, callOptions) {
      const raw = await connection.request(
        "tools/call",
        { name, arguments: args },
        {
          ...(callOptions?.timeoutMs !== undefined ? { timeoutMs: callOptions.timeoutMs } : {}),
          ...(callOptions?.signal !== undefined ? { signal: callOptions.signal } : {})
        }
      );
      const parsed = ToolsCallResultSchema.parse(raw);
      const text = parsed.content
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
      return {
        text,
        ...(parsed.structuredContent !== undefined ? { structuredContent: parsed.structuredContent } : {}),
        isError: parsed.isError
      };
    },
    close: () => connection.close(),
    stderrTail: () => connection.stderrTail()
  };
}

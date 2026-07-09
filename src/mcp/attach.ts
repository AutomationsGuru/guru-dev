import type { ToolDefinition } from "../tools/registry.js";
import { checkMcpReadiness, connectMcpServer, type McpClient } from "./client.js";
import { discoverMcpTools } from "./toolBridge.js";
import type { McpServerConfig, McpServerStatus } from "./schemas.js";

/**
 * One-call ATTACH: take the config's mcpServers, connect every READY stdio
 * server, discover + bridge its tools. Non-ready servers degrade to an honest
 * status (never a throw) — a missing key or a dead binary must not take the
 * boot down; the operator sees WHY each server is out via statuses.
 *
 * Consumers: runtime session assembly (register `tools` on the registry or via
 * ExtensionApi.registerTool), the /tools surface (show `statuses`), and the
 * never-stuck resolver's ATTACH move.
 */

export interface McpAttachment {
  readonly clients: readonly McpClient[];
  readonly tools: readonly ToolDefinition[];
  readonly statuses: readonly McpServerStatus[];
  /** Close every connected client (session teardown). */
  closeAll(): Promise<void>;
}

export interface AttachMcpOptions {
  readonly servers: readonly McpServerConfig[];
  readonly env?: NodeJS.ProcessEnv;
  readonly clientInfo?: { readonly name: string; readonly version: string };
}

export async function attachConfiguredMcpServers(options: AttachMcpOptions): Promise<McpAttachment> {
  const env = options.env ?? process.env;
  const clients: McpClient[] = [];
  const tools: ToolDefinition[] = [];
  const statuses: McpServerStatus[] = [];

  for (const config of options.servers) {
    const readiness = checkMcpReadiness(config, env);
    if (readiness.status !== "ready") {
      statuses.push(readiness);
      continue;
    }
    try {
      const client = await connectMcpServer({
        config,
        env,
        ...(options.clientInfo ? { clientInfo: options.clientInfo } : {})
      });
      try {
        const bridged = await discoverMcpTools({ client, callTimeoutMs: config.timeoutMs });
        clients.push(client);
        tools.push(...bridged);
        statuses.push({
          serverId: config.id,
          status: "ready",
          transport: config.transport,
          missingEnvNames: [],
          toolCount: bridged.length,
          summary: `${config.id} attached: ${bridged.length} tool(s).`
        });
      } catch (error) {
        // Connect succeeded but discovery failed — close the orphaned client.
        await client.close();
        throw error;
      }
    } catch (error) {
      statuses.push({
        serverId: config.id,
        status: "error",
        transport: config.transport,
        missingEnvNames: [],
        summary: `${config.id} failed to attach: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  return {
    clients,
    tools,
    statuses,
    async closeAll() {
      await Promise.allSettled(clients.map((client) => client.close()));
    }
  };
}

import { z } from "zod";

import {
  getMcpAttachmentRecordedAt,
  getMcpAttachmentStatuses
} from "../../mcp/statusStore.js";
import { McpServerStatusSchema } from "../../mcp/schemas.js";
import type { ToolDefinition } from "../registry.js";

/**
 * First-class MCP bridge status — operators + models see which configured
 * servers attached, which are missing env/command, and tool counts.
 */

const McpStatusInputSchema = z.object({}).strict();

const McpStatusOutputSchema = z
  .object({
    servers: z.array(McpServerStatusSchema),
    recordedAt: z.string().optional(),
    summary: z.string()
  })
  .strict();

export type McpStatusOutput = z.infer<typeof McpStatusOutputSchema>;

function summarize(servers: readonly z.infer<typeof McpServerStatusSchema>[]): string {
  if (servers.length === 0) {
    return "No MCP attach run recorded yet (no mcpServers configured, or attach not invoked).";
  }
  const ready = servers.filter((s) => s.status === "ready").length;
  const tools = servers.reduce((n, s) => n + (s.toolCount ?? 0), 0);
  const other = servers.length - ready;
  return `${servers.length} MCP server(s): ${ready} ready (${tools} tool(s)), ${other} not ready.`;
}

export function createMcpStatusTools(): readonly ToolDefinition[] {
  const tool: ToolDefinition<typeof McpStatusInputSchema, typeof McpStatusOutputSchema> = {
    id: "mcp_bridge_status",
    title: "MCP bridge status",
    description:
      "Report the last MCP attach results: which servers are ready/missing-env/error and how many tools each contributed. Read-only.",
    inputSchema: McpStatusInputSchema,
    outputSchema: McpStatusOutputSchema,
    async execute() {
      const servers = [...getMcpAttachmentStatuses()];
      const recordedAt = getMcpAttachmentRecordedAt();
      return {
        servers,
        ...(recordedAt ? { recordedAt } : {}),
        summary: summarize(servers)
      };
    }
  };
  return [tool];
}

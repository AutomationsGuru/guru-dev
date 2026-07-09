import { z } from "zod";

import type { ToolDefinition } from "../tools/registry.js";
import type { McpClient } from "./client.js";
import { McpRiskLevelSchema, type McpRiskLevel, type McpToolDescriptor } from "./schemas.js";

/**
 * MCP → tool-registry bridge (the ATTACH move made usable): every tool a
 * connected MCP server advertises becomes a first-class registry tool with id
 * `mcp.<serverId>.<toolName>`. Bridged tools flow through the same registry
 * choke point as builtins, so the render-layer secret sanitizer and the
 * mandate policy see them by construction — an attached capability obeys the
 * same constitution as a built one.
 *
 * Input validation stays server-side (MCP servers own their JSON Schemas);
 * the bridge passes arguments through as an open record. The advertised
 * schema is surfaced in the tool description so the model can read it.
 */

const BridgeInputSchema = z.object({ arguments: z.record(z.string(), z.unknown()).default({}) }).strict();

const BridgeOutputSchema = z
  .object({
    serverId: z.string(),
    toolName: z.string(),
    status: z.enum(["succeeded", "failed"]),
    text: z.string(),
    structuredContent: z.unknown().optional(),
    riskLevel: McpRiskLevelSchema
  })
  .strict();

export type McpBridgeOutput = z.infer<typeof BridgeOutputSchema>;

export interface McpToolBridgeOptions {
  readonly client: McpClient;
  /** Per-tool risk overrides (tool name → risk); default read-only. */
  readonly riskLevels?: Readonly<Record<string, McpRiskLevel>>;
  readonly callTimeoutMs?: number;
}

/** `mcp.<serverId>.<toolName>` with the raw name slug-safed for registry ids. */
export function mcpToolId(serverId: string, toolName: string): string {
  return `mcp.${serverId}.${toolName.replace(/[^A-Za-z0-9._-]+/gu, "-")}`;
}

function describe(descriptor: McpToolDescriptor): string {
  const parts = [descriptor.description ?? descriptor.title ?? descriptor.name];
  if (descriptor.inputSchema) {
    parts.push(`Arguments (JSON Schema): ${JSON.stringify(descriptor.inputSchema)}`);
  }
  return parts.join("\n");
}

function bridgeOne(options: McpToolBridgeOptions, descriptor: McpToolDescriptor): ToolDefinition<typeof BridgeInputSchema, typeof BridgeOutputSchema> {
  const riskLevel = options.riskLevels?.[descriptor.name] ?? descriptor.riskLevel;
  return {
    id: mcpToolId(descriptor.serverId, descriptor.name),
    title: descriptor.title ?? `${descriptor.serverId}: ${descriptor.name}`,
    description: describe(descriptor),
    inputSchema: BridgeInputSchema,
    outputSchema: BridgeOutputSchema,
    async execute(input, context) {
      const result = await options.client.callTool(descriptor.name, input.arguments, {
        ...(options.callTimeoutMs !== undefined ? { timeoutMs: options.callTimeoutMs } : {}),
        ...(context.signal !== undefined ? { signal: context.signal } : {})
      });
      return {
        serverId: descriptor.serverId,
        toolName: descriptor.name,
        status: result.isError ? "failed" : "succeeded",
        text: result.text,
        ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
        riskLevel
      };
    }
  };
}

/** Discover the server's tools and wrap each as a registry ToolDefinition. */
export async function discoverMcpTools(options: McpToolBridgeOptions): Promise<readonly ToolDefinition[]> {
  const descriptors = await options.client.listTools();
  return descriptors.map((descriptor) => bridgeOne(options, descriptor));
}

/**
 * Factory shape for the frozen extension seam: pre-discovered tools become an
 * `ExtensionApi.registerTool({ factory })` payload with no further await.
 */
export function makeMcpToolFactory(tools: readonly ToolDefinition[]): () => readonly ToolDefinition[] {
  return () => tools;
}

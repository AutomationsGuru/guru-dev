import { z } from "zod";

import { executeRegisteredTool, type ToolDefinition, type ToolRegistry } from "../tools/registry.js";

const SEARCH_TOOL_ID = "search_tool";
const USE_TOOL_ID = "use_tool";
const MAX_QUERY_LENGTH = 200;
const MAX_SEARCH_RESULTS = 25;
const DEFAULT_SEARCH_RESULTS = 10;

const SearchToolInputSchema = z
  .object({
    query: z.string().trim().min(1).max(MAX_QUERY_LENGTH),
    limit: z.number().int().min(1).max(MAX_SEARCH_RESULTS).default(DEFAULT_SEARCH_RESULTS)
  })
  .strict();

const PublicToolMetadataSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string()
  })
  .strict();

const SearchToolOutputSchema = z
  .object({
    query: z.string(),
    tools: z.array(PublicToolMetadataSchema)
  })
  .strict();

const ToolObservationSchema = z
  .object({
    toolId: z.string(),
    status: z.enum(["succeeded", "failed"]),
    startedAt: z.string(),
    endedAt: z.string(),
    durationMs: z.number().nonnegative(),
    output: z.unknown().optional(),
    error: z.string().optional()
  })
  .strict();

function compareToolIds(left: ToolDefinition, right: ToolDefinition): number {
  if (left.id < right.id) {
    return -1;
  }
  if (left.id > right.id) {
    return 1;
  }
  return 0;
}

function isMatchingMcpTool(tool: ToolDefinition, query: string): boolean {
  if (!tool.id.startsWith("mcp.")) {
    return false;
  }

  const searchable = `${tool.id}\n${tool.title}\n${tool.description}`.toLowerCase();
  return searchable.includes(query);
}

function createUseToolInputSchema(registry: ToolRegistry) {
  const ExactMcpToolIdSchema = z.string().min(1).superRefine((toolId, context) => {
    if (toolId === SEARCH_TOOL_ID || toolId === USE_TOOL_ID) {
      context.addIssue({ code: "custom", message: `${USE_TOOL_ID} cannot dispatch itself.` });
      return;
    }

    if (!/^mcp\.[A-Za-z0-9._-]+$/u.test(toolId)) {
      context.addIssue({ code: "custom", message: "Expected an exact registered mcp.* tool id." });
      return;
    }

    if (!registry.get(toolId)) {
      context.addIssue({ code: "custom", message: `Unknown registered MCP tool id: ${toolId}` });
    }
  });

  return z
    .object({
      toolId: ExactMcpToolIdSchema,
      arguments: z.record(z.string(), z.unknown())
    })
    .strict();
}

export function createMcpMetaDispatchTools(registry: ToolRegistry): readonly ToolDefinition[] {
  const searchTool: ToolDefinition<typeof SearchToolInputSchema, typeof SearchToolOutputSchema> = {
    id: SEARCH_TOOL_ID,
    title: "Search MCP tools",
    description: "Search registered MCP tools by id, title, or description without executing them.",
    inputSchema: SearchToolInputSchema,
    outputSchema: SearchToolOutputSchema,
    execute(input) {
      const normalizedQuery = input.query.toLowerCase();
      const tools = [...registry.list()]
        .sort(compareToolIds)
        .filter((tool) => isMatchingMcpTool(tool, normalizedQuery))
        .slice(0, input.limit)
        .map((tool) => ({ id: tool.id, title: tool.title, description: tool.description }));

      return { query: input.query, tools };
    }
  };

  const UseToolInputSchema = createUseToolInputSchema(registry);
  const useTool: ToolDefinition<typeof UseToolInputSchema, typeof ToolObservationSchema> = {
    id: USE_TOOL_ID,
    title: "Use MCP tool",
    description: "Execute an exact registered mcp.* tool id through the shared registry validation and sanitization path.",
    inputSchema: UseToolInputSchema,
    outputSchema: ToolObservationSchema,
    execute(input, context) {
      return executeRegisteredTool(registry, input.toolId, { arguments: input.arguments }, context);
    }
  };

  return [searchTool, useTool];
}

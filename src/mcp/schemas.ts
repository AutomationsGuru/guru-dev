import { z } from "zod";

/**
 * Server ids are open slugs, not a closed enum — the ATTACH move means grafting
 * onto WHATEVER MCP server the environment offers, including ones this codebase
 * has never heard of. (Widened 2026-07-09 from the original nine-server enum;
 * the schema module had zero consumers, so no call sites changed shape.)
 */
export const McpServerIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9._-]{0,63}$/u, "Expected a lowercase slug (a-z, 0-9, dot, dash, underscore; max 64 chars).");
export type McpServerId = z.infer<typeof McpServerIdSchema>;

export const McpTransportSchema = z.enum(["stdio", "http", "sse"]);
export type McpTransport = z.infer<typeof McpTransportSchema>;

export const McpRiskLevelSchema = z.enum(["read-only", "mutation", "production-impacting", "destructive"]);
export type McpRiskLevel = z.infer<typeof McpRiskLevelSchema>;

export const EnvNameSchema = z.string().trim().regex(/^[A-Z][A-Z0-9_]*$/, "Expected an environment variable name, not a value.");

export const McpServerConfigSchema = z
  .object({
    id: McpServerIdSchema,
    enabled: z.boolean().default(true),
    transport: McpTransportSchema,
    command: z.string().trim().min(1).optional(),
    args: z.array(z.string()).default([]),
    url: z.string().trim().url().optional(),
    requiredEnvNames: z.array(EnvNameSchema).default([]),
    category: z.string().trim().min(1),
    timeoutMs: z.number().int().positive().default(30000),
    notes: z.string().trim().min(1).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.transport === "stdio" && !value.command) {
      ctx.addIssue({ code: "custom", path: ["command"], message: "stdio MCP servers require a command name." });
    }

    if ((value.transport === "http" || value.transport === "sse") && !value.url) {
      ctx.addIssue({ code: "custom", path: ["url"], message: "HTTP/SSE MCP servers require a URL." });
    }
  });
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const McpReadinessStatusSchema = z.enum(["ready", "disabled", "missing-env", "missing-command", "offline", "error", "not-implemented"]);
export type McpReadinessStatus = z.infer<typeof McpReadinessStatusSchema>;

export const McpServerStatusSchema = z
  .object({
    serverId: McpServerIdSchema,
    status: McpReadinessStatusSchema,
    transport: McpTransportSchema,
    missingEnvNames: z.array(EnvNameSchema).default([]),
    toolCount: z.number().int().nonnegative().optional(),
    summary: z.string().trim().min(1)
  })
  .strict();
export type McpServerStatus = z.infer<typeof McpServerStatusSchema>;

export const McpToolDescriptorSchema = z
  .object({
    serverId: McpServerIdSchema,
    name: z.string().trim().min(1),
    title: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    inputSchema: z.record(z.string(), z.unknown()).optional(),
    riskLevel: McpRiskLevelSchema.default("read-only")
  })
  .strict();
export type McpToolDescriptor = z.infer<typeof McpToolDescriptorSchema>;

export const McpListToolsRequestSchema = z
  .object({
    serverId: McpServerIdSchema,
    timeoutMs: z.number().int().positive().optional()
  })
  .strict();
export type McpListToolsRequest = z.infer<typeof McpListToolsRequestSchema>;

export const McpListToolsResultSchema = z
  .object({
    serverId: McpServerIdSchema,
    tools: z.array(McpToolDescriptorSchema),
    summary: z.string().trim().min(1)
  })
  .strict();
export type McpListToolsResult = z.infer<typeof McpListToolsResultSchema>;

export const McpCallToolRequestSchema = z
  .object({
    serverId: McpServerIdSchema,
    toolName: z.string().trim().min(1),
    arguments: z.record(z.string(), z.unknown()).default({}),
    riskLevel: McpRiskLevelSchema.default("read-only"),
    dryRun: z.boolean().default(true),
    userApproved: z.boolean().default(false),
    timeoutMs: z.number().int().positive().optional()
  })
  .strict();
export type McpCallToolRequest = z.infer<typeof McpCallToolRequestSchema>;

export const McpCallToolResultSchema = z
  .object({
    serverId: McpServerIdSchema,
    toolName: z.string().trim().min(1),
    status: z.enum(["succeeded", "failed", "blocked", "dry-run"]),
    output: z.unknown().optional(),
    summary: z.string().trim().min(1),
    redacted: z.boolean().default(false)
  })
  .strict();
export type McpCallToolResult = z.infer<typeof McpCallToolResultSchema>;

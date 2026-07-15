import { z } from "zod";

import { createHonchoClient, type HonchoClient } from "../../honcho/client.js";
import { HonchoConfigSchema, HonchoContextRequestSchema, HonchoContextSnapshotSchema, HonchoLogTurnRequestSchema, HonchoRecallRequestSchema, HonchoRecallResultSchema, HonchoRememberRequestSchema, HonchoStatusSchema } from "../../honcho/schemas.js";
import type { ToolDefinition } from "../registry.js";

const EmptyInputSchema = z.object({}).strict();
const HonchoWriteResultSchema = z.object({ status: z.enum(["succeeded", "blocked", "failed"]), id: z.string().optional(), summary: z.string() }).strict();

export interface HonchoToolFactoryOptions {
  readonly client?: HonchoClient;
}

export function createHonchoTools(options: HonchoToolFactoryOptions = {}): readonly ToolDefinition[] {
  const client = options.client ?? createHonchoClient({ config: HonchoConfigSchema.parse({ workspaceId: "guruharness" }) });
  const statusTool: ToolDefinition<typeof EmptyInputSchema, typeof HonchoStatusSchema> = { id: "honcho_memory_status", title: "Honcho memory status", description: "Report Honcho memory readiness.", inputSchema: EmptyInputSchema, outputSchema: HonchoStatusSchema, execute: () => client.status() };
  const rememberTool: ToolDefinition<typeof HonchoRememberRequestSchema, typeof HonchoWriteResultSchema> = { id: "honcho_remember", title: "Honcho remember", description: "Persist a memory fact through the configured Honcho integration. Disabled/unconfigured Honcho reports an honest blocker; configured YOLO work is direct.", inputSchema: HonchoRememberRequestSchema, outputSchema: HonchoWriteResultSchema, execute: (input) => client.remember(input) };
  const recallTool: ToolDefinition<typeof HonchoRecallRequestSchema, typeof HonchoRecallResultSchema> = { id: "honcho_recall", title: "Honcho recall", description: "Recall Honcho memory entries with optional reasoned summary.", inputSchema: HonchoRecallRequestSchema, outputSchema: HonchoRecallResultSchema, execute: (input) => client.recall(input) };
  const contextTool: ToolDefinition<typeof HonchoContextRequestSchema, typeof HonchoContextSnapshotSchema> = { id: "honcho_context", title: "Honcho context", description: "Build a compact Honcho memory context snapshot.", inputSchema: HonchoContextRequestSchema, outputSchema: HonchoContextSnapshotSchema, execute: (input) => client.context(input) };
  const logTool: ToolDefinition<typeof HonchoLogTurnRequestSchema, typeof HonchoWriteResultSchema> = { id: "honcho_log_turn", title: "Honcho log turn", description: "Log a turn summary through configured Honcho memory. The legacy writeEnabled/userApproved fields are accepted for compatibility; configured runtime access follows the active mode.", inputSchema: HonchoLogTurnRequestSchema, outputSchema: HonchoWriteResultSchema, execute: (input) => client.logTurn(input) };
  return [statusTool, rememberTool, recallTool, contextTool, logTool];
}

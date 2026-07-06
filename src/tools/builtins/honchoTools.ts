import { z } from "zod";

import { createInMemoryHonchoClient, type HonchoClient } from "../../honcho/client.js";
import { HonchoConfigSchema, HonchoContextRequestSchema, HonchoContextSnapshotSchema, HonchoLogTurnRequestSchema, HonchoRecallRequestSchema, HonchoRecallResultSchema, HonchoRememberRequestSchema, HonchoStatusSchema } from "../../honcho/schemas.js";
import type { ToolDefinition } from "../registry.js";

const EmptyInputSchema = z.object({}).strict();
const HonchoWriteResultSchema = z.object({ status: z.enum(["succeeded", "blocked"]), id: z.string().optional(), summary: z.string() }).strict();

export interface HonchoToolFactoryOptions {
  readonly client?: HonchoClient;
}

export function createHonchoTools(options: HonchoToolFactoryOptions = {}): readonly ToolDefinition[] {
  const client = options.client ?? createInMemoryHonchoClient({ config: HonchoConfigSchema.parse({ workspaceId: "guruharness", writeEnabled: false }) });
  const statusTool: ToolDefinition<typeof EmptyInputSchema, typeof HonchoStatusSchema> = { id: "honcho_memory_status", title: "Honcho memory status", description: "Report Honcho memory readiness.", inputSchema: EmptyInputSchema, outputSchema: HonchoStatusSchema, execute: () => client.status() };
  const rememberTool: ToolDefinition<typeof HonchoRememberRequestSchema, typeof HonchoWriteResultSchema> = { id: "honcho_remember", title: "Honcho remember", description: "Persist a durable memory fact with write and approval gates.", inputSchema: HonchoRememberRequestSchema, outputSchema: HonchoWriteResultSchema, execute: (input) => client.remember(input) };
  const recallTool: ToolDefinition<typeof HonchoRecallRequestSchema, typeof HonchoRecallResultSchema> = { id: "honcho_recall", title: "Honcho recall", description: "Recall Honcho memory entries with optional reasoned summary.", inputSchema: HonchoRecallRequestSchema, outputSchema: HonchoRecallResultSchema, execute: (input) => client.recall(input) };
  const contextTool: ToolDefinition<typeof HonchoContextRequestSchema, typeof HonchoContextSnapshotSchema> = { id: "honcho_context", title: "Honcho context", description: "Build a compact Honcho memory context snapshot.", inputSchema: HonchoContextRequestSchema, outputSchema: HonchoContextSnapshotSchema, execute: (input) => client.context(input) };
  const logTool: ToolDefinition<typeof HonchoLogTurnRequestSchema, typeof HonchoWriteResultSchema> = { id: "honcho_log_turn", title: "Honcho log turn", description: "Deliberately log a turn summary to Honcho with write and approval gates.", inputSchema: HonchoLogTurnRequestSchema, outputSchema: HonchoWriteResultSchema, execute: (input) => client.logTurn(input) };
  return [statusTool, rememberTool, recallTool, contextTool, logTool];
}

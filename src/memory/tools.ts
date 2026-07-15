import { z } from "zod";

import {
  MemoryDoctorReportSchema,
  MemoryForgetInputSchema,
  MemoryGetInputSchema,
  MemoryGetResultSchema,
  MemoryRememberInputSchema,
  MemorySearchInputSchema,
  MemorySearchResultSchema,
  MemoryStoreStatusSchema,
  MemoryWriteResultSchema
} from "./schemas.js";
import type { ToolDefinition } from "../tools/registry.js";
import type { MemoryFactStore } from "./provider.js";

const EmptyInputSchema = z.object({}).strict();

/**
 * Memory tools — self-registered through the extension host (no api.ts change).
 * memory_search + memory_get are read-only (chat-safe without approval);
 * memory_remember + memory_forget are writes and ride the normal approval gate.
 */
export interface MemoryToolFactoryOptions {
  readonly store: MemoryFactStore;
}

export function createMemoryTools(options: MemoryToolFactoryOptions): readonly ToolDefinition[] {
  const { store } = options;

  const rememberTool: ToolDefinition<typeof MemoryRememberInputSchema, typeof MemoryWriteResultSchema> = {
    id: "memory_remember",
    title: "Remember a durable fact",
    description:
      "Persist a durable memory fact that survives restarts and is injected into future boots. The configured backend is Markdown or PostgreSQL; never store secret values. Same-topic facts should be UPDATED (pass the existing name), not duplicated.",
    inputSchema: MemoryRememberInputSchema,
    outputSchema: MemoryWriteResultSchema,
    execute: (input) => store.remember(input)
  };

  const searchTool: ToolDefinition<typeof MemorySearchInputSchema, typeof MemorySearchResultSchema> = {
    id: "memory_search",
    title: "Search memory",
    description: "Search the configured memory backend by name/title/gist. Returns hits to read with memory_get.",
    inputSchema: MemorySearchInputSchema,
    outputSchema: MemorySearchResultSchema,
    execute: (input) => store.search(input)
  };

  const getTool: ToolDefinition<typeof MemoryGetInputSchema, typeof MemoryGetResultSchema> = {
    id: "memory_get",
    title: "Read a memory fact",
    description: "Read a memory fact's full body + links/backlinks. Carries a staleness banner — verify old facts before asserting them.",
    inputSchema: MemoryGetInputSchema,
    outputSchema: MemoryGetResultSchema,
    execute: (input) => store.get(input.name)
  };

  const forgetTool: ToolDefinition<typeof MemoryForgetInputSchema, typeof MemoryWriteResultSchema> = {
    id: "memory_forget",
    title: "Forget a memory fact",
    description: "Soft-delete a memory fact with an audit reason. Markdown uses .trash/; PostgreSQL retains a soft-delete record.",
    inputSchema: MemoryForgetInputSchema,
    outputSchema: MemoryWriteResultSchema,
    execute: (input) => store.forget(input)
  };

  const doctorTool: ToolDefinition<typeof EmptyInputSchema, typeof MemoryDoctorReportSchema> = {
    id: "memory_doctor",
    title: "Memory doctor",
    description: "Check the configured memory backend. Markdown rebuilds its derived index; PostgreSQL verifies its fact table and reports dangling links.",
    inputSchema: EmptyInputSchema,
    outputSchema: MemoryDoctorReportSchema,
    execute: () => store.doctor()
  };

  const statusTool: ToolDefinition<typeof EmptyInputSchema, typeof MemoryStoreStatusSchema> = {
    id: "memory_status",
    title: "Memory storage status",
    description: "Report the active Markdown or PostgreSQL fact-memory backend and any missing configuration.",
    inputSchema: EmptyInputSchema,
    outputSchema: MemoryStoreStatusSchema,
    execute: () => store.status()
  };

  return [statusTool, rememberTool, searchTool, getTool, forgetTool, doctorTool];
}

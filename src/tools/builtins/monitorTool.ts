import { z } from "zod";

import type { ToolDefinition } from "../registry.js";

const MonitorLineSchema = z
  .object({
    cursor: z.number().int().positive(),
    stream: z.enum(["stdout", "stderr"]),
    text: z.string()
  })
  .strict();

export const MonitorToolInputSchema = z
  .object({
    TaskId: z.string().min(1).describe("The existing background task ID to observe."),
    AfterCursor: z.number().int().nonnegative().optional().describe("Exclusive line cursor to resume after. Defaults to 0."),
    MaxLines: z.number().int().min(1).max(200).optional().describe("Maximum returned lines. Defaults to 50 and cannot exceed 200.")
  })
  .strict();

export const MonitorToolOutputSchema = z
  .object({
    taskId: z.string(),
    state: z.enum(["running", "completed", "failed", "killed"]),
    lines: z.array(MonitorLineSchema),
    nextCursor: z.number().int().nonnegative(),
    truncated: z.boolean(),
    oldestCursor: z.number().int().positive().nullable()
  })
  .strict();

export type MonitorToolOutput = z.infer<typeof MonitorToolOutputSchema>;

export interface MonitorToolOptions {
  readonly onMonitor?: (
    taskId: string,
    afterCursor: number,
    maxLines: number
  ) => Promise<MonitorToolOutput> | MonitorToolOutput;
}

export function createMonitorTool(
  options: MonitorToolOptions = {}
): ToolDefinition<typeof MonitorToolInputSchema, typeof MonitorToolOutputSchema> {
  return {
    id: "monitor",
    title: "Monitor Background Task",
    description: "Read a bounded page of stdout/stderr lines from an existing background task without changing the process.",
    inputSchema: MonitorToolInputSchema,
    outputSchema: MonitorToolOutputSchema,
    async execute(input) {
      if (!options.onMonitor) {
        throw new Error("monitor tool is not supported in this runtime environment (no monitor backend).");
      }
      return options.onMonitor(input.TaskId, input.AfterCursor ?? 0, input.MaxLines ?? 50);
    }
  };
}

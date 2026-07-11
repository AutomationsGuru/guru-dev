import { z } from "zod";
import type { ToolDefinition } from "../registry.js";

export const ManageTaskToolInputSchema = z
  .object({
    Action: z.enum(["list", "kill", "status", "send_input"]).describe("The action to perform."),
    TaskId: z.string().optional().describe("The task ID to manage. Required when Action is 'kill', 'status', or 'send_input'."),
    Input: z.string().optional().describe("The input to send to the task. Required when Action is 'send_input'.")
  })
  .strict();

export const ManageTaskToolOutputSchema = z.object({
  result: z.unknown().describe("Result of the task management action.")
});

export interface ManageTaskToolOptions {
  /** Callback to manage background tasks. */
  readonly onManage?: (action: string, taskId?: string, input?: string) => Promise<unknown>;
}

export function createManageTaskTool(options: ManageTaskToolOptions = {}): ToolDefinition<typeof ManageTaskToolInputSchema, typeof ManageTaskToolOutputSchema> {
  return {
    id: "manage_task",
    title: "Manage Task",
    description: "Manage background tasks. Use this tool to list running tasks or interact with tasks that were sent to the background.",
    inputSchema: ManageTaskToolInputSchema,
    outputSchema: ManageTaskToolOutputSchema,
    async execute(input) {
      if (!options.onManage) {
        throw new Error("manage_task tool is not supported in this runtime environment (no task manager backend).");
      }
      if (input.Action !== "list" && !input.TaskId) {
        throw new Error("TaskId is required for this action.");
      }
      if (input.Action === "send_input" && !input.Input) {
        throw new Error("Input is required for send_input action.");
      }
      const result = await options.onManage(input.Action, input.TaskId, input.Input);
      return { result };
    }
  };
}

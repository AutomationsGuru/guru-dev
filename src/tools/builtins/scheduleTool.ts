import { z } from "zod";
import type { ToolDefinition } from "../registry.js";

export const ScheduleToolInputSchema = z
  .object({
    Prompt: z.string().min(1).describe("The message content to include in the notification when the timer fires or cron triggers. This is sent to the agent as a high-priority message."),
    DurationSeconds: z.string().optional().describe("The number of seconds to wait. Use for one-shot timers. Mutually exclusive with CronExpression."),
    CronExpression: z.string().optional().describe("A standard cron expression (5 fields). Use for recurring schedules. Mutually exclusive with DurationSeconds."),
    MaxIterations: z.string().optional().describe("Maximum number of times the cron schedule will fire before stopping. Only applicable when CronExpression is set."),
    TimerCondition: z.string().optional().describe("Optional early termination condition for one-shot timers ('never', 'any', or a specific sender ID).")
  })
  .strict()
  .refine(data => (data.DurationSeconds !== undefined) !== (data.CronExpression !== undefined), {
    message: "Must specify exactly one of DurationSeconds or CronExpression."
  });

export const ScheduleToolOutputSchema = z.object({
  taskId: z.string().describe("The unique ID of the scheduled task. Can be used with manage_task to cancel.")
});

export interface ScheduleToolOptions {
  /** Callback to actually schedule the timer/cron in the underlying runtime. */
  readonly onSchedule?: (input: Omit<z.infer<typeof ScheduleToolInputSchema>, "">) => Promise<string>;
}

export function createScheduleTool(options: ScheduleToolOptions = {}): ToolDefinition<typeof ScheduleToolInputSchema, typeof ScheduleToolOutputSchema> {
  return {
    id: "schedule",
    title: "Schedule Timer/Cron",
    description: "Schedule a one-shot timer or a recurring cron job that sends notifications in the background.",
    inputSchema: ScheduleToolInputSchema,
    outputSchema: ScheduleToolOutputSchema,
    async execute(input) {
      if (!options.onSchedule) {
        throw new Error("schedule tool is not supported in this runtime environment (no scheduler backend).");
      }
      const taskId = await options.onSchedule(input);
      return { taskId };
    }
  };
}

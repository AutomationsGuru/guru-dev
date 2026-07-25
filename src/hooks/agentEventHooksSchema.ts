import { z } from "zod";

export const HookEventTypesSchema = z.enum([
  "fileSaved",
  "promptSubmit",
  "preTool",
  "postTool",
  "taskStart"
]);
export type HookEventType = z.infer<typeof HookEventTypesSchema>;

export const HookEventSchema = z
  .object({
    type: HookEventTypesSchema,
    path: z.string().trim().optional(),
    prompt: z.string().trim().optional(),
    tool: z.string().trim().optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    result: z.unknown().optional(),
    taskId: z.string().trim().optional(),
    subject: z.string().trim().optional()
  })
  .strict();
export type HookEvent = z.infer<typeof HookEventSchema>;

export const ShellActionSchema = z
  .object({
    command: z.string().trim().min(1),
    confirm: z.boolean().default(true)
  })
  .strict();
export type ShellAction = z.infer<typeof ShellActionSchema>;

export const AskAgentActionSchema = z
  .object({
    prompt: z.string().trim().min(1)
  })
  .strict();
export type AskAgentAction = z.infer<typeof AskAgentActionSchema>;

export const HookActionSchema = z
  .object({
    shell: ShellActionSchema.optional(),
    askAgent: AskAgentActionSchema.optional(),
    skip: z.boolean().optional()
  })
  .strict()
  .refine(
    (data) => data.shell !== undefined || data.askAgent !== undefined || data.skip !== undefined,
    {
      message: "At least one of 'shell', 'askAgent', or 'skip' must be defined in hook action",
      path: ["shell"]
    }
  );
export type HookAction = z.infer<typeof HookActionSchema>;

export const AgentEventHookSchema = z
  .object({
    id: z.string().trim().min(1),
    when: HookEventTypesSchema,
    pattern: z.string().trim().optional(),
    enabled: z.boolean().default(true),
    then: HookActionSchema
  })
  .strict();
export type AgentEventHook = z.infer<typeof AgentEventHookSchema>;

export const AgentEventHooksConfigSchema = z
  .object({
    hooks: z.array(AgentEventHookSchema).default([])
  })
  .strict();
export type AgentEventHooksConfig = z.infer<typeof AgentEventHooksConfigSchema>;

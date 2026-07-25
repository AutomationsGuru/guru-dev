import { z } from "zod";

/**
 * Agent work todos schema (IDEA-F116-AGENT-TODOS-01).
 *
 * This provides a structured todo list schema visible to the operator,
 * allowing the agent/operator to track, update, and complete items
 * during an active session.
 */

export const TodoItemStatusSchema = z.enum(["pending", "in_progress", "completed"]);
export type TodoItemStatus = z.infer<typeof TodoItemStatusSchema>;

export const TodoItemSchema = z
  .object({
    id: z.string().trim().min(1),
    text: z.string().trim().min(1),
    status: TodoItemStatusSchema,
    createdAt: z.string().trim().min(1),
    updatedAt: z.string().trim().min(1)
  })
  .strict();
export type TodoItem = z.infer<typeof TodoItemSchema>;

import { z } from "zod";
import type { ToolDefinition } from "../registry.js";

export const SessionTodosToolInputSchema = z
  .object({
    action: z.enum(["list", "add", "complete", "remove"]).describe("Todo action."),
    content: z.string().trim().min(1).optional().describe("Todo text (required for add)."),
    id: z.string().trim().min(1).optional().describe("Todo id (required for complete/remove).")
  })
  .strict();

export const SessionTodosToolOutputSchema = z.object({
  todos: z.array(
    z.object({
      id: z.string(),
      content: z.string(),
      status: z.enum(["pending", "completed"])
    })
  )
});

export type SessionTodo = z.infer<typeof SessionTodosToolOutputSchema>["todos"][number];

/** In-memory session todo list (Cursor TodoWrite parity). Reset on /new. */
const todos: SessionTodo[] = [];
let counter = 0;

export function resetSessionTodos(): void {
  todos.length = 0;
  counter = 0;
}

export function createSessionTodosTool(): ToolDefinition<typeof SessionTodosToolInputSchema, typeof SessionTodosToolOutputSchema> {
  return {
    id: "session_todos",
    title: "Session Todos",
    description:
      "Track the agent's in-session task list (add, complete, remove, list). Persists for this guru session only — use for multi-step work planning.",
    inputSchema: SessionTodosToolInputSchema,
    outputSchema: SessionTodosToolOutputSchema,
    async execute(input) {
      switch (input.action) {
        case "list":
          return { todos: [...todos] };
        case "add": {
          if (!input.content) {
            throw new Error("content is required for add.");
          }
          const item: SessionTodo = { id: `todo-${(counter += 1)}`, content: input.content, status: "pending" };
          todos.push(item);
          return { todos: [...todos] };
        }
        case "complete": {
          if (!input.id) {
            throw new Error("id is required for complete.");
          }
          const item = todos.find((t) => t.id === input.id);
          if (!item) {
            throw new Error(`Unknown todo id: ${input.id}`);
          }
          item.status = "completed";
          return { todos: [...todos] };
        }
        case "remove": {
          if (!input.id) {
            throw new Error("id is required for remove.");
          }
          const index = todos.findIndex((t) => t.id === input.id);
          if (index < 0) {
            throw new Error(`Unknown todo id: ${input.id}`);
          }
          todos.splice(index, 1);
          return { todos: [...todos] };
        }
        default:
          throw new Error(`Unsupported action: ${String(input.action)}`);
      }
    }
  };
}

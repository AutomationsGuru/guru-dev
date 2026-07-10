import { z } from "zod";

import type { ToolDefinition } from "../registry.js";

/**
 * Session task board — the standard coding-harness “todo list” surface.
 * Models use it to track multi-step work (same role as Claude/Grok todo tools).
 * In-memory per process; optional factory reset for tests.
 */

export const TodoStatusSchema = z.enum(["pending", "in_progress", "completed", "cancelled"]);
export type TodoStatus = z.infer<typeof TodoStatusSchema>;

export const TodoItemSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    content: z.string().trim().min(1).max(500),
    status: TodoStatusSchema
  })
  .strict();
export type TodoItem = z.infer<typeof TodoItemSchema>;

const TodoWriteInputSchema = z
  .object({
    /** When true (default), merge by id into the existing board. When false, replace the whole board. */
    merge: z.boolean().default(true),
    todos: z.array(TodoItemSchema).min(1).max(40)
  })
  .strict();

const TodoListInputSchema = z.object({}).strict();

const TodoBoardOutputSchema = z
  .object({
    todos: z.array(TodoItemSchema),
    summary: z.string(),
    counts: z.object({
      pending: z.number().int().nonnegative(),
      in_progress: z.number().int().nonnegative(),
      completed: z.number().int().nonnegative(),
      cancelled: z.number().int().nonnegative()
    })
  })
  .strict();

export type TodoBoardOutput = z.infer<typeof TodoBoardOutputSchema>;

export interface TodoBoard {
  list(): readonly TodoItem[];
  write(input: z.infer<typeof TodoWriteInputSchema>): TodoBoardOutput;
  snapshot(): TodoBoardOutput;
  clear(): void;
}

function countStatuses(todos: readonly TodoItem[]): TodoBoardOutput["counts"] {
  const counts = { pending: 0, in_progress: 0, completed: 0, cancelled: 0 };
  for (const todo of todos) {
    counts[todo.status] += 1;
  }
  return counts;
}

function summarize(todos: readonly TodoItem[]): string {
  const counts = countStatuses(todos);
  const active = todos.filter((t) => t.status === "in_progress").map((t) => t.id);
  const parts = [
    `${todos.length} task(s)`,
    `${counts.completed} done`,
    `${counts.in_progress} in progress`,
    `${counts.pending} pending`
  ];
  if (active.length > 0) {
    parts.push(`active: ${active.join(", ")}`);
  }
  return parts.join(" · ");
}

function toOutput(todos: readonly TodoItem[]): TodoBoardOutput {
  return {
    todos: [...todos],
    summary: summarize(todos),
    counts: countStatuses(todos)
  };
}

/** Create an isolated board (tests / multi-session later). */
export function createTodoBoard(seed: readonly TodoItem[] = []): TodoBoard {
  let items: TodoItem[] = seed.map((t) => ({ ...t }));

  return {
    list: () => items,
    clear: () => {
      items = [];
    },
    snapshot: () => toOutput(items),
    write(input) {
      if (!input.merge) {
        items = input.todos.map((t) => ({ ...t }));
        return toOutput(items);
      }
      const byId = new Map(items.map((t) => [t.id, t] as const));
      for (const todo of input.todos) {
        byId.set(todo.id, { ...todo });
      }
      items = [...byId.values()];
      // Keep a stable order: incomplete first, then by id.
      items.sort((a, b) => {
        const rank = (s: TodoStatus): number =>
          s === "in_progress" ? 0 : s === "pending" ? 1 : s === "completed" ? 2 : 3;
        const dr = rank(a.status) - rank(b.status);
        return dr !== 0 ? dr : a.id.localeCompare(b.id);
      });
      return toOutput(items);
    }
  };
}

/** Process-shared board used by live guru sessions (one board per process). */
let sharedBoard: TodoBoard = createTodoBoard();

export function getSharedTodoBoard(): TodoBoard {
  return sharedBoard;
}

/** Test seam — swap or reset the shared board. */
export function resetSharedTodoBoard(seed: readonly TodoItem[] = []): TodoBoard {
  sharedBoard = createTodoBoard(seed);
  return sharedBoard;
}

export interface TodoToolFactoryOptions {
  readonly board?: TodoBoard;
}

export function createTodoTools(options: TodoToolFactoryOptions = {}): readonly ToolDefinition[] {
  const board = options.board ?? getSharedTodoBoard();

  const writeTool: ToolDefinition<typeof TodoWriteInputSchema, typeof TodoBoardOutputSchema> = {
    id: "todo_write",
    title: "Update the task board",
    description:
      "Create or update session task items for multi-step work. Use merge:true (default) to upsert by id; merge:false replaces the whole board. Keep at most one task in_progress. Call this when starting complex work and after each meaningful step.",
    inputSchema: TodoWriteInputSchema,
    outputSchema: TodoBoardOutputSchema,
    execute: (input) => board.write(input)
  };

  const listTool: ToolDefinition<typeof TodoListInputSchema, typeof TodoBoardOutputSchema> = {
    id: "todo_list",
    title: "List the task board",
    description: "Read the current session task board (id, content, status) and summary counts.",
    inputSchema: TodoListInputSchema,
    outputSchema: TodoBoardOutputSchema,
    execute: () => board.snapshot()
  };

  return [writeTool, listTool];
}

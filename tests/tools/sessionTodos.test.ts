import { describe, expect, it, beforeEach } from "vitest";

import { createSessionTodosTool, resetSessionTodos } from "../../src/tools/builtins/sessionTodosTool.js";

describe("session_todos tool", () => {
  beforeEach(() => {
    resetSessionTodos();
  });

  it("adds, completes, lists, and removes todos", async () => {
    const tool = createSessionTodosTool();
    const added = await tool.execute({ action: "add", content: "fix TUI" }, {});
    expect(added.todos).toHaveLength(1);
    const id = added.todos[0]?.id;
    expect(id).toMatch(/^todo-/u);

    const listed = await tool.execute({ action: "list" }, {});
    expect(listed.todos[0]?.content).toBe("fix TUI");

    const done = await tool.execute({ action: "complete", id }, {});
    expect(done.todos[0]?.status).toBe("completed");

    const removed = await tool.execute({ action: "remove", id }, {});
    expect(removed.todos).toHaveLength(0);
  });
});

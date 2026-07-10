import { describe, expect, it, beforeEach } from "vitest";

import {
  createTodoBoard,
  createTodoTools,
  resetSharedTodoBoard,
  type TodoBoardOutput
} from "../../src/tools/builtins/todoTools.js";

describe("todo board — session task list", () => {
  beforeEach(() => {
    resetSharedTodoBoard();
  });

  it("merge upserts by id and sorts in-progress first", () => {
    const board = createTodoBoard();
    board.write({
      merge: true,
      todos: [
        { id: "2", content: "second", status: "pending" },
        { id: "1", content: "first", status: "in_progress" }
      ]
    });
    board.write({
      merge: true,
      todos: [{ id: "2", content: "second updated", status: "completed" }]
    });
    const snap = board.snapshot();
    expect(snap.todos.map((t) => t.id)).toEqual(["1", "2"]);
    expect(snap.todos[0]?.status).toBe("in_progress");
    expect(snap.todos[1]?.content).toBe("second updated");
    expect(snap.counts.completed).toBe(1);
    expect(snap.counts.in_progress).toBe(1);
    expect(snap.summary).toContain("active: 1");
  });

  it("merge:false replaces the whole board", () => {
    const board = createTodoBoard([{ id: "old", content: "gone", status: "pending" }]);
    board.write({ merge: false, todos: [{ id: "new", content: "only", status: "pending" }] });
    expect(board.list().map((t) => t.id)).toEqual(["new"]);
  });

  it("createTodoTools drives the real board through tool execute()", async () => {
    const board = createTodoBoard();
    const [writeTool, listTool] = createTodoTools({ board });
    expect(writeTool?.id).toBe("todo_write");
    expect(listTool?.id).toBe("todo_list");
    const written = (await writeTool!.execute(
      {
        merge: true,
        todos: [{ id: "a", content: "ship feature", status: "in_progress" }]
      },
      {}
    )) as TodoBoardOutput;
    expect(written.todos).toHaveLength(1);
    const listed = (await listTool!.execute({}, {})) as TodoBoardOutput;
    expect(listed.todos[0]?.content).toBe("ship feature");
    expect(listed.counts.in_progress).toBe(1);
  });
});

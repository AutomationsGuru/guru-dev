import { bindOutputFile, completeTask } from '../../src/planning/taskOutputFileBind.js';

describe("taskOutputFileBind", () => {
  it("binds an output file path to a task", () => {
    const task = { id: "task-1", title: "Do work" };
    const bound = bindOutputFile(task, "/tmp/out.json");

    expect(bound.id).toBe("task-1");
    expect(bound.title).toBe("Do work");
    expect(bound.outputFile).toBe("/tmp/out.json");
  });

  it("records the outputFile on the completion receipt", () => {
    const task = { id: "task-2", outputFile: "/tmp/result.md" };
    const receipt = completeTask(task, true);

    expect(receipt.taskId).toBe("task-2");
    expect(receipt.ok).toBe(true);
    expect(receipt.outputFile).toBe("/tmp/result.md");
    expect(receipt.timestamp).toBeDefined();
  });

  it("handles tasks without an outputFile", () => {
    const task = { id: "task-3" };
    const receipt = completeTask(task, false);

    expect(receipt.taskId).toBe("task-3");
    expect(receipt.ok).toBe(false);
    expect(receipt.outputFile).toBeUndefined();
  });
});

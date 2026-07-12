import { describe, expect, it, beforeEach } from "vitest";

import {
  manageBackgroundTask,
  resetBackgroundTasks,
  spawnBackgroundTask
} from "../../src/tools/builtins/backgroundTaskRegistry.js";

describe("background task registry", () => {
  beforeEach(() => {
    resetBackgroundTasks();
  });

  it("lists, reports status, and completes a short background task", async () => {
    const id = spawnBackgroundTask(["node", "-e", "console.log('ok')"], process.cwd());
    expect(id).toMatch(/^task-/u);

    const listed = (await manageBackgroundTask("list")) as readonly { id: string }[];
    expect(listed.some((task) => task.id === id)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 250));
    const status = (await manageBackgroundTask("status", id)) as { state: string; stdout: string };
    expect(["completed", "running"]).toContain(status.state);
    if (status.state === "completed") {
      expect(status.stdout).toContain("ok");
    }
  });

  it("kills a long-running task", async () => {
    const id = spawnBackgroundTask(["node", "-e", "setInterval(() => {}, 1000)"], process.cwd());
    const killed = (await manageBackgroundTask("kill", id)) as { state: string };
    expect(killed.state).toBe("killed");
  });
});

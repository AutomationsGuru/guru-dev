import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  manageBackgroundTask,
  resetBackgroundTasks,
  scheduleBackgroundNotification,
  spawnBackgroundTask
} from "../../src/tools/builtins/backgroundTaskRegistry.js";

describe("background task registry", () => {
  beforeEach(() => {
    resetBackgroundTasks();
  });

  afterEach(() => {
    resetBackgroundTasks();
    vi.useRealTimers();
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

  it("schedules one notification, exposes it through manage_task, and completes after delivery", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn(async () => {});

    const id = scheduleBackgroundNotification(2, "review the build", deliver);

    expect(id).toBe("task-1");
    expect(await manageBackgroundTask("list")).toEqual([
      expect.objectContaining({ id, kind: "scheduled", prompt: "review the build", state: "running" })
    ]);
    expect(await manageBackgroundTask("status", id)).toEqual(
      expect.objectContaining({ id, kind: "scheduled", state: "running" })
    );

    await vi.advanceTimersByTimeAsync(1_999);
    expect(deliver).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith("[scheduled] review the build");
    expect(await manageBackgroundTask("status", id)).toEqual(
      expect.objectContaining({ state: "completed", exitCode: 0 })
    );
  });

  it("cancels a scheduled notification through manage_task kill", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn(async () => {});
    const id = scheduleBackgroundNotification(30, "do not deliver", deliver);

    expect(await manageBackgroundTask("kill", id)).toEqual(
      expect.objectContaining({ id, state: "killed" })
    );
    await vi.advanceTimersByTimeAsync(30_000);

    expect(deliver).not.toHaveBeenCalled();
    expect(await manageBackgroundTask("status", id)).toEqual(
      expect.objectContaining({ state: "killed" })
    );
  });

  it("clears scheduled timer handles when the registry resets", async () => {
    vi.useFakeTimers();
    const deliver = vi.fn(async () => {});
    scheduleBackgroundNotification(30, "reset me", deliver);

    resetBackgroundTasks();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(deliver).not.toHaveBeenCalled();
    expect(await manageBackgroundTask("list")).toEqual([]);
  });

  it("marks a scheduled notification failed when delivery rejects", async () => {
    vi.useFakeTimers();
    const id = scheduleBackgroundNotification(1, "fail safely", async () => {
      throw new Error("composer unavailable");
    });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(await manageBackgroundTask("status", id)).toEqual(
      expect.objectContaining({
        state: "failed",
        exitCode: 1,
        stderr: expect.stringContaining("composer unavailable")
      })
    );
  });
});

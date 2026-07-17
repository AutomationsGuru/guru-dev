import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  manageBackgroundTask,
  resetBackgroundTasks,
  scheduleBackgroundNotification,
  spawnBackgroundTask
} from "../../src/tools/builtins/backgroundTaskRegistry.js";

interface TaskStatus {
  readonly id: string;
  readonly command: readonly string[];
  readonly state: "running" | "completed" | "failed" | "killed";
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly endedAt: string | null;
}

async function waitForTerminal(taskId: string): Promise<TaskStatus> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const status = (await manageBackgroundTask("status", taskId)) as TaskStatus;
    if (status.state !== "running") {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Background task ${taskId} did not finish before the test deadline.`);
}

describe("background task registry", () => {
  beforeEach(() => {
    resetBackgroundTasks();
  });

  afterEach(() => {
    resetBackgroundTasks();
    vi.useRealTimers();
  });

  it("lists, reports status, and completes a short background task", async () => {
    const command = [process.execPath, "-e", "console.log('ok')"];
    const id = spawnBackgroundTask(command, process.cwd());
    expect(id).toMatch(/^task-/u);

    const listed = (await manageBackgroundTask("list")) as readonly { id: string }[];
    expect(listed.some((task) => task.id === id)).toBe(true);

    const status = await waitForTerminal(id);
    expect(status).toMatchObject({ state: "completed", exitCode: 0, command });
    expect(status.stdout).toContain("ok");
  });

  it("marks a nonzero exit as failed without losing its exit code", async () => {
    const id = spawnBackgroundTask([process.execPath, "-e", "process.exit(7)"], process.cwd());

    const status = await waitForTerminal(id);

    expect(status.state).toBe("failed");
    expect(status.exitCode).toBe(7);
  });

  it("keeps only bounded stdout and stderr tails", async () => {
    const script = [
      "process.stdout.write('o'.repeat(20000) + 'OUT-END')",
      "process.stderr.write('e'.repeat(20000) + 'ERR-END')"
    ].join(";");
    const id = spawnBackgroundTask([process.execPath, "-e", script], process.cwd());

    const status = await waitForTerminal(id);

    expect(status.state).toBe("completed");
    expect(status.stdout.length).toBeLessThanOrEqual(16_384);
    expect(status.stderr.length).toBeLessThanOrEqual(16_384);
    expect(status.stdout.endsWith("OUT-END")).toBe(true);
    expect(status.stderr.endsWith("ERR-END")).toBe(true);
  });

  it("turns a missing executable into a failed task instead of an unhandled process error", async () => {
    const missing = `guru-command-that-does-not-exist-${Date.now()}`;
    const id = spawnBackgroundTask([missing], process.cwd());

    const status = await waitForTerminal(id);

    expect(status.state).toBe("failed");
    expect(status.exitCode).toBeNull();
    expect(status.stderr).toMatch(/ENOENT|not found/iu);
    expect(status.stderr.length).toBeLessThanOrEqual(16_384);
    expect(status.endedAt).not.toBeNull();
  });

  it("rejects an empty command before creating a task", async () => {
    expect(() => spawnBackgroundTask([], process.cwd())).toThrow(/empty/iu);
    expect(await manageBackgroundTask("list")).toEqual([]);
  });

  it("kills a long-running task", async () => {
    const id = spawnBackgroundTask([process.execPath, "-e", "setInterval(() => {}, 1000)"], process.cwd());

    const killed = (await manageBackgroundTask("kill", id)) as TaskStatus;

    expect(killed.state).toBe("killed");
    expect(killed.endedAt).not.toBeNull();
  });

  it("sends line-delimited input to a running task", async () => {
    const script = "process.stdin.once('data', (chunk) => { process.stdout.write('got:' + chunk.toString()); process.exit(0); })";
    const id = spawnBackgroundTask([process.execPath, "-e", script], process.cwd());

    await manageBackgroundTask("send_input", id, "hello");
    const status = await waitForTerminal(id);

    expect(status.state).toBe("completed");
    expect(status.stdout).toContain("got:hello\n");
  });

  it("reset kills and removes every live task", async () => {
    const id = spawnBackgroundTask([process.execPath, "-e", "setInterval(() => {}, 1000)"], process.cwd());

    resetBackgroundTasks();

    expect(await manageBackgroundTask("list")).toEqual([]);
    await expect(manageBackgroundTask("status", id)).rejects.toThrow(/Unknown task id/iu);
  });

  it("reuses the shared Windows spawn resolver and never enables a shell", () => {
    const source = readFileSync(join(process.cwd(), "src", "tools", "builtins", "backgroundTaskRegistry.ts"), "utf8");

    expect(source).toContain("resolveWindowsGateSpawn(command)");
    expect(source).toMatch(/shell:\s*false/u);
  });

  // Scheduled-task tests (from current base 17153c2)

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

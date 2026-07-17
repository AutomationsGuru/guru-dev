import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  manageBackgroundTask,
  readBackgroundTaskLines,
  resetBackgroundTasks,
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

interface MonitoredLine {
  readonly cursor: number;
  readonly stream: "stdout" | "stderr";
  readonly text: string;
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

  it("pages split UTF-8, multiple lines, interleaved streams, and final partial output exactly once", async () => {
    const script = [
      "process.stdout.write(Buffer.from([0xf0, 0x9f]))",
      "setTimeout(() => process.stdout.write(Buffer.from([0x98, 0x80])), 10)",
      "setTimeout(() => process.stdout.write(' alpha\\nsecond\\n'), 20)",
      "setTimeout(() => process.stderr.write('err'), 30)",
      "setTimeout(() => process.stderr.write('or\\n'), 40)",
      "setTimeout(() => process.stdout.write('final'), 50)"
    ].join(";");
    const id = spawnBackgroundTask([process.execPath, "-e", script, "do-not-disclose"], process.cwd());

    await waitForTerminal(id);
    const first = readBackgroundTaskLines(id, 0, 2);
    const second = readBackgroundTaskLines(id, first.nextCursor, 2);

    expect(first).toMatchObject({
      taskId: id,
      state: "completed",
      truncated: false,
      oldestCursor: 1,
      lines: [
        { cursor: 1, stream: "stdout", text: "😀 alpha" },
        { cursor: 2, stream: "stdout", text: "second" }
      ]
    });
    expect(second.lines).toEqual([
      { cursor: 3, stream: "stderr", text: "error" },
      { cursor: 4, stream: "stdout", text: "final" }
    ] satisfies readonly MonitoredLine[]);
    expect(second.nextCursor).toBe(4);
    expect(readBackgroundTaskLines(id, second.nextCursor, 50).lines).toEqual([]);

    const serialized = JSON.stringify({ first, second });
    expect(serialized).not.toContain("command");
    expect(serialized).not.toContain("cwd");
    expect(serialized).not.toContain("process");
    expect(serialized).not.toContain("do-not-disclose");
  });

  it("bounds retained line events and reports cursor truncation without exceeding the page cap", async () => {
    const id = spawnBackgroundTask(
      [process.execPath, "-e", "for (let i = 0; i < 1005; i += 1) console.log(`line-${i}`)"],
      process.cwd()
    );

    await waitForTerminal(id);
    const truncated = readBackgroundTaskLines(id, 0, 999);

    expect(truncated.truncated).toBe(true);
    expect(truncated.oldestCursor).toBe(6);
    expect(truncated.lines).toHaveLength(200);
    expect(truncated.lines[0]).toEqual({ cursor: 6, stream: "stdout", text: "line-5" });
    expect(readBackgroundTaskLines(id, 5, 1).truncated).toBe(false);
  });

  it("uses the existing bounded unknown-task error for monitor reads", () => {
    expect(() => readBackgroundTaskLines("task-missing")).toThrow("Unknown task id: task-missing");
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
});

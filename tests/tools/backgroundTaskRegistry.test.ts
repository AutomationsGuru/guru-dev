import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  manageBackgroundTask,
  readBackgroundTaskLines,
  resetBackgroundTasks,
  resetSessionBackgroundTasks,
  scheduleBackgroundNotification,
  spawnBackgroundTask
} from '../../src/tools/builtins/backgroundTaskRegistry.js';

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

  describe("task type classification", () => {
    it("reports kind: process for spawned tasks", async () => {
      const id = spawnBackgroundTask([process.execPath, "-e", "console.log('ok')"], process.cwd());
      const status = (await manageBackgroundTask("status", id)) as TaskStatus & { kind?: string };
      expect(status.kind).toBe("process");
    });

    it("reports kind: scheduled for scheduled notifications", async () => {
      const id = scheduleBackgroundNotification(3600, "test-scheduled-kind", async () => {});
      const listed = (await manageBackgroundTask("list")) as readonly ({ id: string; kind?: string })[];
      const found = listed.find((t) => t.id === id);
      expect(found).toBeDefined();
      expect(found!.kind).toBe("scheduled");
    });

    it("always includes kind in list views", async () => {
      spawnBackgroundTask([process.execPath, "-e", "console.log('ok')"], process.cwd());
      const id2 = scheduleBackgroundNotification(7200, "test-always-kind", async () => {});
      const listed = (await manageBackgroundTask("list")) as readonly ({ id: string; kind?: string })[];
      expect(listed.length).toBeGreaterThanOrEqual(2);
      for (const entry of listed) {
        expect(entry).toHaveProperty("kind");
        expect(entry.kind).toMatch(/^(?:process|scheduled)$/u);
      }
    });

    it("reports correct kind per task in a mixed process+scheduled list", async () => {
      const pid = spawnBackgroundTask([process.execPath, "-e", "console.log('ok')"], process.cwd());
      const sid = scheduleBackgroundNotification(7200, "test-mixed", async () => {});
      const listed = (await manageBackgroundTask("list")) as readonly ({ id: string; kind?: string })[];
      const kinds: Record<string, string | undefined> = {};
      for (const entry of listed) {
        kinds[entry.id] = entry.kind;
      }
      expect(kinds[pid]).toBe("process");
      expect(kinds[sid]).toBe("scheduled");
    });

    it("preserves kind after the task completes", async () => {
      const id = spawnBackgroundTask([process.execPath, "-e", "console.log('ok')"], process.cwd());
      const status = await waitForTerminal(id);
      // status is typed as TaskStatus which has no kind, so use a type assertion
      const withKind = status as TaskStatus & { kind?: string };
      expect(withKind.kind).toBe("process");
      expect(withKind.state).toBe("completed");
    });

    it("does not leak kind into monitor line pages", async () => {
      const id = spawnBackgroundTask([process.execPath, "-e", "console.log('ok')"], process.cwd());
      await waitForTerminal(id);
      const page = readBackgroundTaskLines(id, 0, 10);
      const serialized = JSON.stringify(page);
      expect(serialized).not.toContain("kind");
    });
  });

  describe("session isolation", () => {
    it("stores sessionId on tasks when provided", async () => {
      const id = spawnBackgroundTask([process.execPath, "-e", "setInterval(() => {}, 1000)"], process.cwd(), "session-a");
      const status = (await manageBackgroundTask("status", id)) as TaskStatus & { sessionId?: string };
      expect(status.sessionId).toBe("session-a");
    });

    it("omits sessionId from the public view when not provided", async () => {
      const id = spawnBackgroundTask([process.execPath, "-e", "setInterval(() => {}, 1000)"], process.cwd());
      const status = (await manageBackgroundTask("status", id)) as TaskStatus & { sessionId?: string };
      expect(status).not.toHaveProperty("sessionId");
    });

    it("exposes sessionId on scheduled task status view", async () => {
      const id = scheduleBackgroundNotification(3600, "test-session-scheduled", async () => {}, "session-b");
      const status = (await manageBackgroundTask("status", id)) as TaskStatus & { sessionId?: string; kind?: string };
      expect(status.sessionId).toBe("session-b");
      expect(status.kind).toBe("scheduled");
    });

    it("resetSessionBackgroundTasks kills only the given session's tasks", async () => {
      const idA = spawnBackgroundTask([process.execPath, "-e", "setInterval(() => {}, 1000)"], process.cwd(), "session-a");
      const idB = spawnBackgroundTask([process.execPath, "-e", "setInterval(() => {}, 1000)"], process.cwd(), "session-b");
      const idNone = spawnBackgroundTask([process.execPath, "-e", "setInterval(() => {}, 1000)"], process.cwd());

      resetSessionBackgroundTasks("session-a");

      await expect(manageBackgroundTask("status", idA)).rejects.toThrow("Unknown task id");
      const statusB = (await manageBackgroundTask("status", idB)) as TaskStatus;
      expect(statusB.state).toBe("running");
      const statusNone = (await manageBackgroundTask("status", idNone)) as TaskStatus;
      expect(statusNone.state).toBe("running");
    });

    it("resetSessionBackgroundTasks cleans up scheduled tasks too", async () => {
      const id = scheduleBackgroundNotification(3600, "test-cleanup-scheduled", async () => {}, "session-c");
      // Verify it exists
      const before = (await manageBackgroundTask("status", id)) as TaskStatus & { sessionId?: string };
      expect(before.sessionId).toBe("session-c");

      resetSessionBackgroundTasks("session-c");

      // After reset, the task should be gone
      await expect(manageBackgroundTask("status", id)).rejects.toThrow("Unknown task id");
      // And list shouldn't have any session-c tasks
      const listed = (await manageBackgroundTask("list")) as readonly ({ id: string; sessionId?: string })[];
      const sessionC = listed.filter((t) => t.sessionId === "session-c");
      expect(sessionC).toHaveLength(0);
    });

    it("global reset still kills every task regardless of session", async () => {
      const idA = spawnBackgroundTask([process.execPath, "-e", "setInterval(() => {}, 1000)"], process.cwd(), "session-a");
      const idB = spawnBackgroundTask([process.execPath, "-e", "setInterval(() => {}, 1000)"], process.cwd(), "session-b");

      // Verify tasks exist before reset
      const before = (await manageBackgroundTask("list")) as readonly { id: string }[];
      expect(before.length).toBe(2);

      resetBackgroundTasks();

      expect(await manageBackgroundTask("list")).toEqual([]);
      await expect(manageBackgroundTask("status", idA)).rejects.toThrow("Unknown task id");
      await expect(manageBackgroundTask("status", idB)).rejects.toThrow("Unknown task id");
    });

    it("resetSessionBackgroundTasks on a non-existent session is a no-op", async () => {
      const id = spawnBackgroundTask([process.execPath, "-e", "setInterval(() => {}, 1000)"], process.cwd(), "session-a");

      // Should not throw
      expect(() => resetSessionBackgroundTasks("nonexistent")).not.toThrow();

      // The original task should still be running
      const status = (await manageBackgroundTask("status", id)) as TaskStatus;
      expect(status.state).toBe("running");
    });

    it("does not leak sessionId into monitor line pages", async () => {
      const id = spawnBackgroundTask([process.execPath, "-e", "console.log('ok')"], process.cwd(), "session-secret");
      await waitForTerminal(id);
      const page = readBackgroundTaskLines(id, 0, 10);
      const serialized = JSON.stringify(page);
      expect(serialized).not.toContain("sessionId");
      expect(serialized).not.toContain("session-secret");
    });

    it("cleans up completed tasks in the session too", async () => {
      const id = spawnBackgroundTask([process.execPath, "-e", "console.log('ok')"], process.cwd(), "session-d");
      await waitForTerminal(id);

      resetSessionBackgroundTasks("session-d");

      await expect(manageBackgroundTask("status", id)).rejects.toThrow("Unknown task id");
    });

    it("resets all tasks in a session when multiple tasks share the same sessionId", async () => {
      const id1 = spawnBackgroundTask([process.execPath, "-e", "setInterval(() => {}, 1000)"], process.cwd(), "session-multi");
      const id2 = spawnBackgroundTask([process.execPath, "-e", "setInterval(() => {}, 1000)"], process.cwd(), "session-multi");
      const idOther = spawnBackgroundTask([process.execPath, "-e", "setInterval(() => {}, 1000)"], process.cwd(), "session-other");

      resetSessionBackgroundTasks("session-multi");

      await expect(manageBackgroundTask("status", id1)).rejects.toThrow("Unknown task id");
      await expect(manageBackgroundTask("status", id2)).rejects.toThrow("Unknown task id");
      const statusOther = (await manageBackgroundTask("status", idOther)) as TaskStatus;
      expect(statusOther.state).toBe("running");
    });

    it("is a no-op when resetting a session that is already empty", async () => {
      const id = spawnBackgroundTask([process.execPath, "-e", "setInterval(() => {}, 1000)"], process.cwd(), "session-reset-me");

      resetSessionBackgroundTasks("session-reset-me");
      await expect(manageBackgroundTask("status", id)).rejects.toThrow("Unknown task id");

      // Second reset on the now-empty session should not throw
      expect(() => resetSessionBackgroundTasks("session-reset-me")).not.toThrow();
    });

    it("allows reusing a sessionId after the previous tasks were reset", async () => {
      const id1 = spawnBackgroundTask([process.execPath, "-e", "setInterval(() => {}, 1000)"], process.cwd(), "session-reuse");
      resetSessionBackgroundTasks("session-reuse");
      await expect(manageBackgroundTask("status", id1)).rejects.toThrow("Unknown task id");

      const id2 = spawnBackgroundTask([process.execPath, "-e", "console.log('ok')"], process.cwd(), "session-reuse");
      const status2 = (await manageBackgroundTask("status", id2)) as TaskStatus & { sessionId?: string };
      expect(status2.sessionId).toBe("session-reuse");
    });

    it("includes sessionId in the list view", async () => {
      spawnBackgroundTask([process.execPath, "-e", "setInterval(() => {}, 1000)"], process.cwd(), "session-list-a");
      spawnBackgroundTask([process.execPath, "-e", "setInterval(() => {}, 1000)"], process.cwd());

      const listed = (await manageBackgroundTask("list")) as readonly ({ id: string; sessionId?: string })[];
      const withSession = listed.filter((t) => t.sessionId !== undefined);
      expect(withSession.length).toBeGreaterThanOrEqual(1);
      expect(withSession.every((t) => t.sessionId === "session-list-a")).toBe(true);
    });

    it("handles empty string sessionId consistently", async () => {
      // Empty string is a valid string; session isolation should treat it as a real session.
      const id = spawnBackgroundTask([process.execPath, "-e", "setInterval(() => {}, 1000)"], process.cwd(), "");
      const status = (await manageBackgroundTask("status", id)) as TaskStatus & { sessionId?: string };
      // The public view must include the sessionId since it was explicitly provided
      expect(status).toHaveProperty("sessionId");
      expect(status.sessionId).toBe("");
    });
  });
});


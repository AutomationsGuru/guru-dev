import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { resolveWindowsGateSpawn } from "../../review/gates.js";
import { scrubSecretValues } from "../../safety/secretSafety.js";

interface BackgroundTaskRecord {
  readonly id: string;
  readonly kind: "process" | "scheduled";
  readonly command: readonly string[];
  readonly cwd: string;
  readonly prompt?: string;
  state: "running" | "completed" | "failed" | "killed";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  readonly startedAt: string;
  endedAt?: string;
  process?: ChildProcessWithoutNullStreams | undefined;
  timer?: ReturnType<typeof setTimeout> | undefined;
}

const tasks = new Map<string, BackgroundTaskRecord>();
let counter = 0;

const MAX_TAIL = 16_384;

function appendTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= MAX_TAIL ? next : next.slice(-MAX_TAIL);
}

function publicView(task: BackgroundTaskRecord) {
  // Agent-visible choke point: same secret-shape scrub as foreground bash/output paths.
  return {
    id: task.id,
    kind: task.kind,
    command: [...task.command],
    cwd: task.cwd,
    ...(task.prompt !== undefined ? { prompt: scrubSecretValues(task.prompt) } : {}),
    state: task.state,
    exitCode: task.exitCode,
    stdout: scrubSecretValues(task.stdout),
    stderr: scrubSecretValues(task.stderr),
    startedAt: task.startedAt,
    endedAt: task.endedAt ?? null
  };
}

export function resetBackgroundTasks(): void {
  for (const task of tasks.values()) {
    if (task.timer !== undefined) {
      clearTimeout(task.timer);
      delete task.timer;
    }
    if (task.state === "running" && task.process && !task.process.killed) {
      task.process.kill("SIGTERM");
      task.state = "killed";
      task.endedAt = new Date().toISOString();
    }
  }
  tasks.clear();
  counter = 0;
}

export function spawnBackgroundTask(command: readonly string[], cwd: string): string {
  if (!command[0]?.trim()) {
    throw new Error("Background command is empty.");
  }
  const resolved = resolveWindowsGateSpawn(command);
  const id = `task-${(counter += 1)}`;
  const child = spawn(resolved.executable, resolved.args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false
  });
  const record: BackgroundTaskRecord = {
    id,
    kind: "process",
    command,
    cwd,
    state: "running",
    exitCode: null,
    stdout: "",
    stderr: "",
    startedAt: new Date().toISOString(),
    process: child
  };
  let spawnFailed = false;
  child.stdout.on("data", (chunk: Buffer) => {
    record.stdout = appendTail(record.stdout, chunk.toString("utf8"));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    record.stderr = appendTail(record.stderr, chunk.toString("utf8"));
  });
  child.on("error", (error) => {
    spawnFailed = true;
    record.exitCode = null;
    record.state = "failed";
    record.stderr = appendTail(record.stderr, `Background task failed to start: ${error.message}\n`);
    record.endedAt = new Date().toISOString();
    delete record.process;
  });
  child.on("close", (code) => {
    if (spawnFailed) {
      return;
    }
    record.exitCode = code;
    record.state = record.state === "killed" ? "killed" : code === 0 ? "completed" : "failed";
    record.endedAt = new Date().toISOString();
    delete record.process;
  });
  tasks.set(id, record);
  return id;
}

export function scheduleBackgroundNotification(
  delaySeconds: number,
  prompt: string,
  deliver: (message: string) => Promise<void>
): string {
  if (!Number.isFinite(delaySeconds) || delaySeconds <= 0) {
    throw new Error("DurationSeconds must be a positive finite number.");
  }

  const delayMs = delaySeconds * 1_000;
  if (delayMs > 2_147_483_647) {
    throw new Error("DurationSeconds exceeds the maximum in-process timer delay.");
  }

  const id = `task-${(counter += 1)}`;
  const record: BackgroundTaskRecord = {
    id,
    kind: "scheduled",
    command: ["schedule", prompt],
    cwd: process.cwd(),
    prompt,
    state: "running",
    exitCode: null,
    stdout: "",
    stderr: "",
    startedAt: new Date().toISOString()
  };

  const timer = setTimeout(() => {
    delete record.timer;
    void deliver(`[scheduled] ${prompt}`).then(
      () => {
        if (record.state !== "running") {
          return;
        }
        record.state = "completed";
        record.exitCode = 0;
        record.endedAt = new Date().toISOString();
      },
      (error: unknown) => {
        if (record.state !== "running") {
          return;
        }
        record.state = "failed";
        record.exitCode = 1;
        record.stderr = appendTail(
          record.stderr,
          `Scheduled delivery failed: ${error instanceof Error ? error.message : String(error)}`
        );
        record.endedAt = new Date().toISOString();
      }
    );
  }, delayMs);
  timer.unref();
  record.timer = timer;
  tasks.set(id, record);
  return id;
}

export async function manageBackgroundTask(action: string, taskId?: string, input?: string): Promise<unknown> {
  switch (action) {
    case "list":
      return [...tasks.values()].map(publicView);
    case "status": {
      const task = tasks.get(taskId ?? "");
      if (!task) {
        throw new Error(`Unknown task id: ${taskId}`);
      }
      return publicView(task);
    }
    case "kill": {
      const task = tasks.get(taskId ?? "");
      if (!task) {
        throw new Error(`Unknown task id: ${taskId}`);
      }
      if (task.state === "running") {
        if (task.timer !== undefined) {
          clearTimeout(task.timer);
          delete task.timer;
        }
        if (task.process && !task.process.killed) {
          task.process.kill("SIGTERM");
        }
        task.state = "killed";
        task.endedAt = new Date().toISOString();
      }
      return publicView(task);
    }
    case "send_input": {
      const task = tasks.get(taskId ?? "");
      if (!task) {
        throw new Error(`Unknown task id: ${taskId}`);
      }
      if (task.state !== "running" || !task.process?.stdin) {
        throw new Error("Task is not running or does not accept input.");
      }
      task.process.stdin.write(`${input ?? ""}\n`);
      return publicView(task);
    }
    default:
      throw new Error(`Unsupported manage_task action: ${action}`);
  }
}

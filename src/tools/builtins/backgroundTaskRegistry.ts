import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

interface BackgroundTaskRecord {
  readonly id: string;
  readonly command: readonly string[];
  readonly cwd: string;
  state: "running" | "completed" | "failed" | "killed";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  readonly startedAt: string;
  endedAt?: string;
  process?: ChildProcessWithoutNullStreams | undefined;
}

const tasks = new Map<string, BackgroundTaskRecord>();
let counter = 0;

const MAX_TAIL = 16_384;

function appendTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= MAX_TAIL ? next : next.slice(-MAX_TAIL);
}

function publicView(task: BackgroundTaskRecord) {
  return {
    id: task.id,
    command: [...task.command],
    cwd: task.cwd,
    state: task.state,
    exitCode: task.exitCode,
    stdout: task.stdout,
    stderr: task.stderr,
    startedAt: task.startedAt,
    endedAt: task.endedAt ?? null
  };
}

export function resetBackgroundTasks(): void {
  for (const task of tasks.values()) {
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
  const id = `task-${(counter += 1)}`;
  const child = spawn(command[0]!, command.slice(1), {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false
  });
  const record: BackgroundTaskRecord = {
    id,
    command,
    cwd,
    state: "running",
    exitCode: null,
    stdout: "",
    stderr: "",
    startedAt: new Date().toISOString(),
    process: child
  };
  child.stdout.on("data", (chunk: Buffer) => {
    record.stdout = appendTail(record.stdout, chunk.toString("utf8"));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    record.stderr = appendTail(record.stderr, chunk.toString("utf8"));
  });
  child.on("close", (code) => {
    record.exitCode = code;
    record.state = record.state === "killed" ? "killed" : code === 0 ? "completed" : "failed";
    record.endedAt = new Date().toISOString();
    delete record.process;
  });
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
      if (task.state === "running" && task.process && !task.process.killed) {
        task.process.kill("SIGTERM");
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

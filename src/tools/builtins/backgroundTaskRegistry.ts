import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { resolveWindowsGateSpawn } from "../../review/gates.js";
import { scrubSecretValues } from "../../safety/secretSafety.js";

export type BackgroundTaskState = "running" | "completed" | "failed" | "killed";
export type BackgroundTaskLineStream = "stdout" | "stderr";

export interface BackgroundTaskLineEvent {
  readonly cursor: number;
  readonly stream: BackgroundTaskLineStream;
  readonly text: string;
}

export interface BackgroundTaskLinePage {
  readonly taskId: string;
  readonly state: BackgroundTaskState;
  readonly lines: BackgroundTaskLineEvent[];
  readonly nextCursor: number;
  readonly truncated: boolean;
  readonly oldestCursor: number | null;
}

interface BackgroundTaskRecord {
  readonly id: string;
  readonly kind?: "process" | "scheduled";
  readonly command: readonly string[];
  readonly cwd: string;
  readonly prompt?: string;
  state: BackgroundTaskState;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  readonly startedAt: string;
  endedAt?: string;
  process?: ChildProcessWithoutNullStreams | undefined;
  timer?: ReturnType<typeof setTimeout> | undefined;
  readonly lineEvents: BackgroundTaskLineEvent[];
  nextLineCursor: number;
  readonly lineBuffers: Record<BackgroundTaskLineStream, string>;
  readonly lineDecoders: Record<BackgroundTaskLineStream, StringDecoder>;
  lineBuffersFlushed: boolean;
}

const tasks = new Map<string, BackgroundTaskRecord>();
let counter = 0;

const MAX_TAIL = 16_384;
const MAX_RETAINED_LINE_EVENTS = 1_000;
const DEFAULT_MONITOR_LINES = 50;
const MAX_MONITOR_LINES = 200;

function appendTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= MAX_TAIL ? next : next.slice(-MAX_TAIL);
}

function appendLineEvent(task: BackgroundTaskRecord, stream: BackgroundTaskLineStream, text: string): void {
  task.lineEvents.push({
    cursor: (task.nextLineCursor += 1),
    stream,
    text: appendTail("", text)
  });
  if (task.lineEvents.length > MAX_RETAINED_LINE_EVENTS) {
    task.lineEvents.splice(0, task.lineEvents.length - MAX_RETAINED_LINE_EVENTS);
  }
}

function consumeDecodedOutput(task: BackgroundTaskRecord, stream: BackgroundTaskLineStream, decoded: string): void {
  if (decoded.length === 0) {
    return;
  }
  task[stream] = appendTail(task[stream], decoded);
  const combined = task.lineBuffers[stream] + decoded;
  let start = 0;
  let newline = combined.indexOf("\n", start);
  while (newline >= 0) {
    const complete = combined.slice(start, newline);
    appendLineEvent(task, stream, complete.endsWith("\r") ? complete.slice(0, -1) : complete);
    start = newline + 1;
    newline = combined.indexOf("\n", start);
  }
  task.lineBuffers[stream] = appendTail("", combined.slice(start));
}

function consumeOutputChunk(task: BackgroundTaskRecord, stream: BackgroundTaskLineStream, chunk: Buffer): void {
  consumeDecodedOutput(task, stream, task.lineDecoders[stream].write(chunk));
}

function flushLineBuffers(task: BackgroundTaskRecord): void {
  if (task.lineBuffersFlushed) {
    return;
  }
  task.lineBuffersFlushed = true;
  for (const stream of ["stdout", "stderr"] as const) {
    consumeDecodedOutput(task, stream, task.lineDecoders[stream].end());
    const partial = task.lineBuffers[stream];
    if (partial.length > 0) {
      appendLineEvent(task, stream, partial);
      task.lineBuffers[stream] = "";
    }
  }
}

function publicView(task: BackgroundTaskRecord) {
  return {
    id: task.id,
    ...(task.kind !== undefined ? { kind: task.kind } : {}),
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
    command,
    cwd,
    state: "running",
    exitCode: null,
    stdout: "",
    stderr: "",
    startedAt: new Date().toISOString(),
    process: child,
    lineEvents: [],
    nextLineCursor: 0,
    lineBuffers: { stdout: "", stderr: "" },
    lineDecoders: { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") },
    lineBuffersFlushed: false
  };
  let spawnFailed = false;
  child.stdout.on("data", (chunk: Buffer) => {
    consumeOutputChunk(record, "stdout", chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    consumeOutputChunk(record, "stderr", chunk);
  });
  child.on("error", (error) => {
    spawnFailed = true;
    record.exitCode = null;
    record.state = "failed";
    record.stderr = appendTail(record.stderr, `Background task failed to start: ${error.message}\n`);
    flushLineBuffers(record);
    record.endedAt = new Date().toISOString();
    delete record.process;
  });
  child.on("close", (code) => {
    if (spawnFailed) {
      return;
    }
    flushLineBuffers(record);
    record.exitCode = code;
    record.state = record.state === "killed" ? "killed" : code === 0 ? "completed" : "failed";
    record.endedAt = new Date().toISOString();
    delete record.process;
  });
  tasks.set(id, record);
  return id;
}

export function readBackgroundTaskLines(
  taskId: string,
  afterCursor = 0,
  maxLines = DEFAULT_MONITOR_LINES
): BackgroundTaskLinePage {
  const task = tasks.get(taskId);
  if (!task) {
    throw new Error(`Unknown task id: ${taskId}`);
  }
  const normalizedAfter = Number.isFinite(afterCursor) ? Math.max(0, Math.trunc(afterCursor)) : 0;
  const normalizedMax = Number.isFinite(maxLines)
    ? Math.min(MAX_MONITOR_LINES, Math.max(1, Math.trunc(maxLines)))
    : DEFAULT_MONITOR_LINES;
  const oldestCursor = task.lineEvents[0]?.cursor ?? null;
  const lines = task.lineEvents
    .filter((line) => line.cursor > normalizedAfter)
    .slice(0, normalizedMax)
    .map((line) => ({ ...line }));
  return {
    taskId: task.id,
    state: task.state,
    lines,
    nextCursor: lines.at(-1)?.cursor ?? normalizedAfter,
    truncated: oldestCursor !== null && normalizedAfter < oldestCursor - 1,
    oldestCursor
  };
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
    startedAt: new Date().toISOString(),
    lineEvents: [],
    nextLineCursor: 0,
    lineBuffers: { stdout: "", stderr: "" },
    lineDecoders: { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") },
    lineBuffersFlushed: true
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


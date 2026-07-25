/**
 * In-host schedule / timed-wake backend (IDEA-B3-SCHEDULE-WAKE-01).
 *
 * One honest in-process scheduler: one-shot timers and bounded 5-field cron
 * recurrence, delivered through an injected callback (the same shape the
 * interactive `schedule` tool already threads via `interactiveCallbacks`).
 * This is deliberately an in-process backend, not a durable one — it is
 * explicit about that boundary through {@link ScheduleBackendCapabilities}
 * (`supportsPersistence: false`) instead of pretending schedules survive a
 * restart. No external cron daemon and no cloud queue (plan exclusions).
 *
 * Every scheduled task runs inside explicit bounds (VISION §5 "Bound-the-loop"):
 * - maxIterations caps total fires per recurring task (fail closed at the cap);
 * - maxWallClockMs bounds how far into the future a task may be scheduled and
 *   how long it may remain active;
 * - maxFanoutWidth bounds concurrently active scheduled tasks;
 * - delivery concurrency is structurally capped at 1 per task (a fire that
 *   arrives while the previous delivery is in flight is skipped and counted,
 *   never stacked).
 * Token and spend caps are enforced in the consuming loop (the harness owns
 * token accounting); this backend enforces the time/iteration/fanout
 * dimensions through `src/runtime/loopCaps.ts`.
 */

import { LOOP_CAPS_ABSOLUTE_CEILINGS, createLoopCaps, type LoopCaps, type LoopCapsConfig } from "./loopCaps.js";

/** Node's setTimeout cannot represent delays beyond 2^31 - 1 ms (~24.8 days). */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

const MAX_ONE_SHOT_DURATION_SECONDS = Math.floor(MAX_TIMER_DELAY_MS / 1_000);
const MINUTE_MS = 60_000;
/** Cron matching scans minute-by-minute out to this horizon before declaring "never fires". */
const CRON_SCAN_HORIZON_MS = 400 * 24 * 60 * MINUTE_MS;

export interface ScheduleBackendCapabilities {
  readonly kind: "in-process";
  readonly supportsOneShot: boolean;
  readonly supportsCron: boolean;
  /** Always false here: tasks live in process memory and do not survive a restart. */
  readonly supportsPersistence: boolean;
}

export interface OneShotScheduleInput {
  readonly prompt: string;
  readonly durationSeconds: number;
}

export interface CronScheduleInput {
  readonly prompt: string;
  readonly cronExpression: string;
  /** Maximum number of fires before the schedule completes (fail closed at the cap). */
  readonly maxIterations?: number;
}

export type ScheduledTaskState = "pending" | "completed" | "cancelled" | "failed";

export interface ScheduledTaskStatus {
  readonly taskId: string;
  readonly kind: "one-shot" | "cron";
  readonly prompt: string;
  readonly state: ScheduledTaskState;
  readonly createdAt: string;
  readonly nextFireAt: string | null;
  readonly lastFiredAt: string | null;
  readonly iterationsUsed: number;
  readonly maxIterations: number | null;
  /** Fires skipped because the previous delivery was still in flight (concurrency cap 1). */
  readonly skippedFires: number;
  readonly lastDelivered: boolean | null;
  readonly lastError: string | null;
}

export interface ScheduleBackend {
  readonly capabilities: ScheduleBackendCapabilities;
  scheduleOneShot(input: OneShotScheduleInput, deliver: (message: string) => Promise<void>): string;
  scheduleCron(input: CronScheduleInput, deliver: (message: string) => Promise<void>): string;
  /** Cancel a live task. Returns false for unknown ids; true for an already-terminal known task. */
  cancel(taskId: string): boolean;
  status(taskId: string): ScheduledTaskStatus | undefined;
  listStatuses(): readonly ScheduledTaskStatus[];
  /** Cancel every task and reject future registrations. Idempotent. */
  close(): void;
}

export interface InProcessScheduleBackend extends ScheduleBackend {
  readonly caps: LoopCaps;
}

export interface CreateInProcessScheduleBackendOptions {
  /** Extra bounds layered on top of the built-in safety floors. */
  readonly caps?: LoopCapsConfig;
  /** Clock injection for tests; must return milliseconds since the epoch. */
  readonly now?: () => number;
}

interface ScheduledTaskRecord {
  readonly taskId: string;
  readonly kind: "one-shot" | "cron";
  readonly prompt: string;
  readonly cronExpression?: string;
  readonly deliver: (message: string) => Promise<void>;
  readonly createdAtMs: number;
  state: ScheduledTaskState;
  nextFireAtMs: number | null;
  lastFiredAtMs: number | null;
  iterationsUsed: number;
  readonly maxIterations: number | null;
  skippedFires: number;
  lastDelivered: boolean | null;
  lastError: string | null;
  deliveryInFlight: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const FIELD_SPECS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 }
] as const;

const MONTH_NAMES: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

const DAY_NAMES: Readonly<Record<string, number>> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6
};

type CronFieldSpec = (typeof FIELD_SPECS)[number];

interface ParsedCron {
  readonly fields: readonly ReadonlySet<number>[];
}

function parseCronField(raw: string, spec: CronFieldSpec, fieldIndex: number): ReadonlySet<number> {
  if (raw.trim().length === 0) {
    throw new Error(`Invalid cron expression: empty ${spec.name} field.`);
  }

  const values = new Set<number>();
  for (const listPart of raw.split(",")) {
    const stepSplit = listPart.split("/");
    if (stepSplit.length > 2) {
      throw new Error(`Invalid cron expression: malformed step in ${spec.name} field ("${listPart}").`);
    }
    const rangePart = stepSplit[0] ?? "";
    const stepPart = stepSplit[1];

    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) {
        throw new Error(`Invalid cron expression: step in ${spec.name} field must be a positive integer.`);
      }
      step = Number.parseInt(stepPart, 10);
      if (step <= 0) {
        throw new Error(`Invalid cron expression: step in ${spec.name} field must be a positive integer.`);
      }
    }

    const resolveName = (token: string): number | undefined => {
      const lower = token.toLowerCase();
      if (fieldIndex === 3) {
        return MONTH_NAMES[lower];
      }
      if (fieldIndex === 4) {
        return DAY_NAMES[lower];
      }
      return undefined;
    };

    const resolveBound = (token: string): number => {
      const named = resolveName(token);
      if (named !== undefined) {
        return named;
      }
      if (!/^\d+$/.test(token)) {
        throw new Error(`Invalid cron expression: unrecognised value "${token}" in ${spec.name} field.`);
      }
      return Number.parseInt(token, 10);
    };

    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = spec.min;
      hi = spec.max;
    } else if (rangePart.includes("-")) {
      const bounds = rangePart.split("-");
      if (bounds.length !== 2 || bounds[0] === "" || bounds[1] === "") {
        throw new Error(`Invalid cron expression: malformed range in ${spec.name} field ("${rangePart}").`);
      }
      lo = resolveBound(bounds[0] ?? "");
      hi = resolveBound(bounds[1] ?? "");
    } else if (stepPart !== undefined) {
      // "N/step" means N-max/step (standard cron stepped-from semantics).
      lo = resolveBound(rangePart);
      hi = spec.max;
    } else {
      const single = resolveBound(rangePart);
      lo = single;
      hi = single;
    }

    if (lo < spec.min || hi > spec.max) {
      throw new Error(`Invalid cron expression: ${spec.name} value out of range ${spec.min}-${spec.max} ("${listPart}").`);
    }
    if (lo > hi) {
      throw new Error(`Invalid cron expression: ${spec.name} range is reversed ("${listPart}").`);
    }
    for (let value = lo; value <= hi; value += step) {
      values.add(value);
    }
  }

  if (values.size === 0) {
    throw new Error(`Invalid cron expression: ${spec.name} field matches nothing.`);
  }
  return values;
}

function parseCronExpression(expression: string): ParsedCron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: expected exactly 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}.`);
  }
  const fields = parts.map((part, index) => parseCronField(part, FIELD_SPECS[index] ?? FIELD_SPECS[0], index));
  return { fields };
}

function cronMatches(fields: readonly ReadonlySet<number>[], date: Date): boolean {
  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const dayOfMonth = date.getUTCDate();
  const month = date.getUTCMonth() + 1;
  const dayOfWeek = date.getUTCDay();

  const dayOfWeekField = fields[4] ?? new Set<number>();
  const dayOfWeekMatches = dayOfWeekField.has(dayOfWeek) || (dayOfWeek === 0 && dayOfWeekField.has(7));

  return (
    (fields[0]?.has(minute) ?? false) &&
    (fields[1]?.has(hour) ?? false) &&
    (fields[2]?.has(dayOfMonth) ?? false) &&
    (fields[3]?.has(month) ?? false) &&
    dayOfWeekMatches
  );
}

/**
 * Compute the next UTC fire time strictly after `after` for a 5-field cron
 * expression (minute-resolution, UTC). Returns null when the expression can
 * never fire (e.g. February 31). Throws on malformed expressions.
 */
export function nextCronFireTime(expression: string, after: Date): Date | null {
  const parsed = parseCronExpression(expression);
  const afterMs = after.getTime();
  if (!Number.isFinite(afterMs)) {
    throw new Error("Invalid reference date for cron evaluation.");
  }
  let candidate = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const horizon = afterMs + CRON_SCAN_HORIZON_MS;
  while (candidate <= horizon) {
    const date = new Date(candidate);
    if (cronMatches(parsed.fields, date)) {
      return date;
    }
    candidate += MINUTE_MS;
  }
  return null;
}

export function createInProcessScheduleBackend(options: CreateInProcessScheduleBackendOptions = {}): InProcessScheduleBackend {
  const caps = createLoopCaps(options.caps ?? {});
  const now = options.now ?? (() => Date.now());
  const tasks = new Map<string, ScheduledTaskRecord>();
  let counter = 0;
  let closed = false;

  const wallClockLimit = caps.limits.maxWallClockMs ?? LOOP_CAPS_ABSOLUTE_CEILINGS.maxWallClockMs;

  const clearTaskTimer = (task: ScheduledTaskRecord): void => {
    if (task.timer !== undefined) {
      clearTimeout(task.timer);
      task.timer = undefined;
    }
  };

  const toStatus = (task: ScheduledTaskRecord): ScheduledTaskStatus => ({
    taskId: task.taskId,
    kind: task.kind,
    prompt: task.prompt,
    state: task.state,
    createdAt: new Date(task.createdAtMs).toISOString(),
    nextFireAt: task.state === "pending" && task.nextFireAtMs !== null ? new Date(task.nextFireAtMs).toISOString() : null,
    lastFiredAt: task.lastFiredAtMs !== null ? new Date(task.lastFiredAtMs).toISOString() : null,
    iterationsUsed: task.iterationsUsed,
    maxIterations: task.maxIterations,
    skippedFires: task.skippedFires,
    lastDelivered: task.lastDelivered,
    lastError: task.lastError
  });

  const activeCount = (): number =>
    [...tasks.values()].filter((task) => task.state === "pending").length;

  const effectiveIterationLimit = (requested: number | undefined): number => {
    let limit = requested ?? caps.limits.maxIterations ?? LOOP_CAPS_ABSOLUTE_CEILINGS.maxIterations;
    if (requested !== undefined) {
      if (!Number.isInteger(requested) || requested <= 0) {
        throw new Error("maxIterations must be a positive integer; refusing to schedule an unbounded or dead loop.");
      }
    }
    return Math.min(limit, LOOP_CAPS_ABSOLUTE_CEILINGS.maxIterations);
  };

  const assertWithinWallClock = (targetMs: number): void => {
    if (targetMs - now() > wallClockLimit) {
      throw new Error(
        `Schedule exceeds the wall-clock cap: next fire is more than ${wallClockLimit}ms in the future. Fail closed.`
      );
    }
  };

  const assertCanRegister = (): void => {
    if (closed) {
      throw new Error("Schedule backend is closed; refusing to register new tasks.");
    }
    const fanoutLimit = caps.limits.maxFanoutWidth;
    if (fanoutLimit !== undefined && activeCount() >= fanoutLimit) {
      throw new Error(
        `Schedule fanout cap reached: ${activeCount()} active task(s) already at the maxFanoutWidth bound of ${fanoutLimit}. Fail closed.`
      );
    }
  };

  const settleAfterDelivery = (task: ScheduledTaskRecord, delivered: boolean, error: unknown): void => {
    task.deliveryInFlight = false;
    task.lastDelivered = delivered;
    if (!delivered) {
      task.lastError = error instanceof Error ? error.message : String(error);
    }

    if (task.state !== "pending") {
      return;
    }

    if (task.kind === "one-shot") {
      task.state = delivered ? "completed" : "failed";
      task.nextFireAtMs = null;
      return;
    }

    // Cron chains are self-perpetuating from fireTask; the settle only stops
    // the chain when the iteration budget is spent (fail closed at the cap).
    if (task.maxIterations !== null && task.iterationsUsed >= task.maxIterations) {
      clearTaskTimer(task);
      task.state = "completed";
      task.nextFireAtMs = null;
    }
  };

  const fireTask = (task: ScheduledTaskRecord): void => {
    if (closed || task.state !== "pending") {
      return;
    }

    if (now() - task.createdAtMs > wallClockLimit) {
      // Fail closed: a task that outlived the wall-clock bound is completed,
      // never silently kept alive past its envelope.
      task.state = "completed";
      task.nextFireAtMs = null;
      return;
    }

    if (task.kind === "cron" && task.deliveryInFlight) {
      // Concurrency cap is structurally 1 per task: skip this fire, count it,
      // and keep the chain alive for the next boundary.
      task.skippedFires += 1;
      armCronTimer(task);
      return;
    }

    task.iterationsUsed += 1;
    task.lastFiredAtMs = now();
    task.deliveryInFlight = true;
    void task.deliver(task.prompt).then(
      () => settleAfterDelivery(task, true, undefined),
      (error: unknown) => settleAfterDelivery(task, false, error)
    );

    if (task.kind === "cron" && task.state === "pending") {
      // Arm the next absolute boundary immediately so the chain does not drift
      // with delivery latency and survives deliveries that never settle fast.
      armCronTimer(task);
    }
  };

  const armTimer = (task: ScheduledTaskRecord, delayMs: number): void => {
    clearTaskTimer(task);
    task.timer = setTimeout(() => {
      task.timer = undefined;
      fireTask(task);
    }, delayMs);
    task.timer.unref();
  };

  const armCronTimer = (task: ScheduledTaskRecord): void => {
    const expression = task.cronExpression ?? "";
    const next = nextCronFireTime(expression, new Date(now()));
    if (next === null) {
      task.state = "completed";
      task.nextFireAtMs = null;
      return;
    }
    if (next.getTime() - task.createdAtMs > wallClockLimit) {
      task.state = "completed";
      task.nextFireAtMs = null;
      return;
    }
    task.nextFireAtMs = next.getTime();
    // The per-fire envelope check in fireTask terminates the task at the
    // wall-clock bound; registration already refused a first fire outside it.
    armTimer(task, next.getTime() - now());
  };

  const register = (input: {
    kind: "one-shot" | "cron";
    prompt: string;
    deliver: (message: string) => Promise<void>;
    cronExpression?: string;
    maxIterations?: number | undefined;
    firstFireAtMs: number;
  }): string => {
    const taskId = `scheduled-${(counter += 1)}`;
    const record: ScheduledTaskRecord = {
      taskId,
      kind: input.kind,
      prompt: input.prompt,
      ...(input.cronExpression !== undefined ? { cronExpression: input.cronExpression } : {}),
      deliver: input.deliver,
      createdAtMs: now(),
      state: "pending",
      nextFireAtMs: input.firstFireAtMs,
      lastFiredAtMs: null,
      iterationsUsed: 0,
      maxIterations: input.maxIterations ?? null,
      skippedFires: 0,
      lastDelivered: null,
      lastError: null,
      deliveryInFlight: false,
      timer: undefined
    };
    tasks.set(taskId, record);
    if (record.kind === "one-shot") {
      armTimer(record, input.firstFireAtMs - now());
    } else {
      armCronTimer(record);
    }
    return taskId;
  };

  return {
    capabilities: {
      kind: "in-process",
      supportsOneShot: true,
      supportsCron: true,
      supportsPersistence: false
    },
    caps,
    scheduleOneShot(input, deliver) {
      assertCanRegister();
      if (typeof input.durationSeconds !== "number" || !Number.isFinite(input.durationSeconds)) {
        throw new Error("DurationSeconds must be a finite number; refusing to schedule an invalid timer.");
      }
      if (input.durationSeconds <= 0) {
        throw new Error("DurationSeconds must be a positive number of seconds; refusing to schedule an invalid timer.");
      }
      if (input.durationSeconds > MAX_ONE_SHOT_DURATION_SECONDS) {
        throw new Error(`DurationSeconds exceeds the maximum in-process timer delay of ${MAX_ONE_SHOT_DURATION_SECONDS} seconds.`);
      }
      const firstFireAtMs = now() + input.durationSeconds * 1_000;
      assertWithinWallClock(firstFireAtMs);
      return register({ kind: "one-shot", prompt: input.prompt, deliver, firstFireAtMs });
    },
    scheduleCron(input, deliver) {
      assertCanRegister();
      // Validate the expression before registering (throws on malformed input).
      parseCronExpression(input.cronExpression);
      const maxIterations = effectiveIterationLimit(input.maxIterations);
      const next = nextCronFireTime(input.cronExpression, new Date(now()));
      if (next === null) {
        throw new Error(`Cron expression can never fire within the scan horizon: "${input.cronExpression}".`);
      }
      assertWithinWallClock(next.getTime());
      return register({
        kind: "cron",
        prompt: input.prompt,
        deliver,
        cronExpression: input.cronExpression,
        maxIterations,
        firstFireAtMs: next.getTime()
      });
    },
    cancel(taskId) {
      const task = tasks.get(taskId);
      if (!task) {
        return false;
      }
      if (task.state === "pending") {
        clearTaskTimer(task);
        task.state = "cancelled";
        task.nextFireAtMs = null;
      }
      return true;
    },
    status(taskId) {
      const task = tasks.get(taskId);
      return task ? toStatus(task) : undefined;
    },
    listStatuses() {
      return [...tasks.values()].map(toStatus);
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      for (const task of tasks.values()) {
        clearTaskTimer(task);
        if (task.state === "pending") {
          task.state = "cancelled";
          task.nextFireAtMs = null;
        }
      }
    }
  };
}

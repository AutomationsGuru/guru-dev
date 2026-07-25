import {
  MAX_TIMER_DELAY_MS,
  createInProcessScheduleBackend,
  nextCronFireTime,
  type InProcessScheduleBackend,
  type ScheduledTaskStatus
} from "../../src/runtime/scheduleBackend.js";

const MINUTE_MS = 60_000;

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("nextCronFireTime", () => {
  const origin = new Date("2026-07-18T12:34:56.789Z");

  it("should compute the next minute boundary for an every-minute expression", () => {
    expect(nextCronFireTime("* * * * *", origin)?.toISOString()).toBe("2026-07-18T12:35:00.000Z");
  });

  it("should honor numeric fields", () => {
    expect(nextCronFireTime("30 9 * * *", origin)?.toISOString()).toBe("2026-07-19T09:30:00.000Z");
    expect(nextCronFireTime("0 0 1 * *", origin)?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("should honor steps, ranges, lists, and names", () => {
    expect(nextCronFireTime("*/15 * * * *", origin)?.toISOString()).toBe("2026-07-18T12:45:00.000Z");
    expect(nextCronFireTime("0 9-17 * * *", origin)?.toISOString()).toBe("2026-07-18T13:00:00.000Z");
    expect(nextCronFireTime("0 8,18 * * *", origin)?.toISOString()).toBe("2026-07-18T18:00:00.000Z");
    expect(nextCronFireTime("0 12 * * mon", origin)?.toISOString()).toBe("2026-07-20T12:00:00.000Z");
    expect(nextCronFireTime("0 0 1 jan *", origin)?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("should return null when the expression can never fire", () => {
    // Feb 29 exists within the horizon from a leap-year start, so it must resolve.
    expect(nextCronFireTime("0 0 29 2 *", new Date("2028-01-01T00:00:00.000Z"))?.toISOString()).toBe(
      "2028-02-29T00:00:00.000Z"
    );
    expect(nextCronFireTime("0 0 31 2 *", origin)).toBeNull();
  });

  it("should reject malformed expressions", () => {
    expect(() => nextCronFireTime("* * * *", origin)).toThrow(/5 fields/);
    expect(() => nextCronFireTime("* * * * * *", origin)).toThrow(/5 fields/);
    expect(() => nextCronFireTime("61 * * * *", origin)).toThrow();
    expect(() => nextCronFireTime("*/0 * * * *", origin)).toThrow();
    expect(() => nextCronFireTime("bogus * * * *", origin)).toThrow();
    expect(() => nextCronFireTime("5-1 * * * *", origin)).toThrow();
  });
});

describe("createInProcessScheduleBackend", () => {
  let backend: InProcessScheduleBackend;
  let deliveries: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T12:00:00.000Z"));
    deliveries = [];
    backend = createInProcessScheduleBackend();
  });

  afterEach(() => {
    backend.close();
    vi.useRealTimers();
  });

  function recordDelivery(message: string): Promise<void> {
    deliveries.push(message);
    return Promise.resolve();
  }

  it("should advertise honest in-process capabilities", () => {
    expect(backend.capabilities).toEqual({
      kind: "in-process",
      supportsOneShot: true,
      supportsCron: true,
      supportsPersistence: false
    });
  });

  it("should fire a one-shot timer once and complete", async () => {
    const taskId = backend.scheduleOneShot({ prompt: "wake up", durationSeconds: 30 }, recordDelivery);

    expect(taskId).toMatch(/^scheduled-/);
    expect(backend.status(taskId)).toMatchObject({ state: "pending", iterationsUsed: 0, prompt: "wake up" });
    expect(deliveries).toEqual([]);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(deliveries).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(deliveries).toEqual(["wake up"]);
    expect(backend.status(taskId)).toMatchObject({ state: "completed", iterationsUsed: 1, lastDelivered: true });

    await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);
    expect(deliveries).toEqual(["wake up"]);
  });

  it("should reject invalid one-shot durations fail-closed", () => {
    expect(() => backend.scheduleOneShot({ prompt: "x", durationSeconds: 0 }, recordDelivery)).toThrow(/positive/);
    expect(() => backend.scheduleOneShot({ prompt: "x", durationSeconds: -5 }, recordDelivery)).toThrow(/positive/);
    expect(() => backend.scheduleOneShot({ prompt: "x", durationSeconds: Number.NaN }, recordDelivery)).toThrow(/finite/);
    expect(() =>
      backend.scheduleOneShot({ prompt: "x", durationSeconds: (MAX_TIMER_DELAY_MS + 1) / 1_000 }, recordDelivery)
    ).toThrow(/maximum/);
    expect(backend.listStatuses()).toEqual([]);
  });

  it("should run a cron schedule on each matching boundary until cancelled", async () => {
    const taskId = backend.scheduleCron({ prompt: "tick", cronExpression: "* * * * *" }, recordDelivery);

    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(deliveries).toEqual(["tick", "tick"]);
    expect(backend.status(taskId)).toMatchObject({ state: "pending", iterationsUsed: 2 });

    expect(backend.cancel(taskId)).toBe(true);
    expect(backend.status(taskId)).toMatchObject({ state: "cancelled" });

    await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
    expect(deliveries).toEqual(["tick", "tick"]);
  });

  it("should stop a cron schedule when maxIterations is reached (fail closed)", async () => {
    const taskId = backend.scheduleCron(
      { prompt: "bounded", cronExpression: "* * * * *", maxIterations: 2 },
      recordDelivery
    );

    await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);

    expect(deliveries).toEqual(["bounded", "bounded"]);
    expect(backend.status(taskId)).toMatchObject({ state: "completed", iterationsUsed: 2 });
  });

  it("should reject a non-positive maxIterations instead of scheduling an unbounded or dead loop", () => {
    expect(() =>
      backend.scheduleCron({ prompt: "x", cronExpression: "* * * * *", maxIterations: 0 }, recordDelivery)
    ).toThrow(/maxIterations/);
    expect(() =>
      backend.scheduleCron({ prompt: "x", cronExpression: "* * * * *", maxIterations: -3 }, recordDelivery)
    ).toThrow(/maxIterations/);
    expect(backend.listStatuses()).toEqual([]);
  });

  it("should refuse to schedule beyond the wall-clock cap", () => {
    const bounded = createInProcessScheduleBackend({ caps: { maxWallClockMs: 30 * MINUTE_MS } });

    expect(() =>
      bounded.scheduleOneShot({ prompt: "too late", durationSeconds: 31 * 60 }, recordDelivery)
    ).toThrow(/wall-clock/i);
    expect(() =>
      bounded.scheduleCron({ prompt: "too sparse", cronExpression: "0 * * * *" }, recordDelivery)
    ).toThrow(/wall-clock/i);

    const taskId = bounded.scheduleOneShot({ prompt: "in time", durationSeconds: 10 * 60 }, recordDelivery);
    expect(bounded.status(taskId)).toMatchObject({ state: "pending" });
    bounded.close();
  });

  it("should refuse registration once the fanout (active task) cap is reached", () => {
    const bounded = createInProcessScheduleBackend({ caps: { maxFanoutWidth: 2 } });

    bounded.scheduleOneShot({ prompt: "a", durationSeconds: 60 }, recordDelivery);
    bounded.scheduleOneShot({ prompt: "b", durationSeconds: 60 }, recordDelivery);

    expect(() => bounded.scheduleOneShot({ prompt: "c", durationSeconds: 60 }, recordDelivery)).toThrow(/fanout/i);

    bounded.close();
  });

  it("should free a fanout slot when a task reaches a terminal state", async () => {
    const bounded = createInProcessScheduleBackend({ caps: { maxFanoutWidth: 1 } });

    const first = bounded.scheduleOneShot({ prompt: "first", durationSeconds: 60 }, recordDelivery);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(bounded.status(first)).toMatchObject({ state: "completed" });

    const second = bounded.scheduleOneShot({ prompt: "second", durationSeconds: 60 }, recordDelivery);
    expect(bounded.status(second)).toMatchObject({ state: "pending" });

    bounded.close();
  });

  it("should skip a cron fire while the previous delivery is still in flight (concurrency cap 1)", async () => {
    const gate = deferred();
    let calls = 0;
    const slowDeliver = (message: string): Promise<void> => {
      calls += 1;
      deliveries.push(message);
      return gate.promise;
    };

    const taskId = backend.scheduleCron({ prompt: "slow", cronExpression: "* * * * *" }, slowDeliver);

    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(3 * MINUTE_MS);
    expect(calls).toBe(1);
    expect(backend.status(taskId)).toMatchObject({ state: "pending", iterationsUsed: 1, skippedFires: 3 });

    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(calls).toBe(2);
  });

  it("should mark a one-shot task failed when delivery rejects", async () => {
    const failingDeliver = (): Promise<void> => Promise.reject(new Error("channel closed"));
    const taskId = backend.scheduleOneShot({ prompt: "fragile", durationSeconds: 5 }, failingDeliver);

    await vi.advanceTimersByTimeAsync(5_000);

    const status = backend.status(taskId) as ScheduledTaskStatus;
    expect(status).toMatchObject({ state: "failed", iterationsUsed: 1, lastDelivered: false });
    expect(status.lastError).toContain("channel closed");
  });

  it("should keep a cron schedule alive after a delivery failure and record the error", async () => {
    let shouldFail = true;
    const flakyDeliver = (message: string): Promise<void> => {
      if (shouldFail) {
        return Promise.reject(new Error("transient"));
      }
      deliveries.push(message);
      return Promise.resolve();
    };

    const taskId = backend.scheduleCron({ prompt: "retry-me", cronExpression: "* * * * *" }, flakyDeliver);

    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(backend.status(taskId)).toMatchObject({ state: "pending", iterationsUsed: 1, lastDelivered: false });
    expect(backend.status(taskId)?.lastError).toContain("transient");

    shouldFail = false;
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(deliveries).toEqual(["retry-me"]);
    expect(backend.status(taskId)).toMatchObject({ state: "pending", iterationsUsed: 2, lastDelivered: true });
  });

  it("should expose listStatuses and tolerate unknown ids", () => {
    const a = backend.scheduleOneShot({ prompt: "a", durationSeconds: 60 }, recordDelivery);
    const b = backend.scheduleCron({ prompt: "b", cronExpression: "0 9 * * *" }, recordDelivery);

    expect(backend.status("scheduled-999")).toBeUndefined();
    expect(backend.cancel("scheduled-999")).toBe(false);

    const listed = backend.listStatuses().map((status) => status.taskId);
    expect(listed).toEqual(expect.arrayContaining([a, b]));
    expect(listed).toHaveLength(2);
  });

  it("should stop every task on close and reject new registrations", async () => {
    const taskId = backend.scheduleOneShot({ prompt: "doomed", durationSeconds: 60 }, recordDelivery);
    backend.close();

    expect(backend.status(taskId)).toMatchObject({ state: "cancelled" });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(deliveries).toEqual([]);
    expect(() => backend.scheduleOneShot({ prompt: "late", durationSeconds: 1 }, recordDelivery)).toThrow(/closed/i);
  });
});

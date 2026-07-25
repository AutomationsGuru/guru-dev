import { describe, expect, it } from "vitest";

import {
  createSpecTaskStatusTracker,
  SpecTaskStatusSchema,
  SPEC_TASK_STATUSES
} from '../../src/planning/specTaskStatusTracker.js';

describe("specTaskStatusTracker (IDEA-F158-TASK-STATUS-01) — per-task status + wave progress", () => {
  it("starts empty: unknown ids are undefined and summary is all zeroes", () => {
    const tracker = createSpecTaskStatusTracker();

    expect(tracker.getStatus("task-1")).toBeUndefined();

    const summary = tracker.summary();
    expect(summary.total).toBe(0);
    expect(summary.counts).toEqual({ pending: 0, "in-progress": 0, done: 0, blocked: 0 });
    expect(summary.byWave).toEqual({});
  });

  it("exposes the status enum values through the zod schema", () => {
    expect(SPEC_TASK_STATUSES).toEqual(["pending", "in-progress", "done", "blocked"]);
    expect(SpecTaskStatusSchema.parse("blocked")).toBe("blocked");
    expect(() => SpecTaskStatusSchema.parse("nope")).toThrow();
  });

  it("registers a task on first setStatus", () => {
    const tracker = createSpecTaskStatusTracker();

    tracker.setStatus("task-1", "in-progress");

    expect(tracker.getStatus("task-1")).toBe("in-progress");
  });

  it("tracks a full happy-path transition: pending → in-progress → done", () => {
    const tracker = createSpecTaskStatusTracker();
    tracker.setStatus("task-1", "pending");
    expect(tracker.getStatus("task-1")).toBe("pending");
    tracker.setStatus("task-1", "in-progress");
    expect(tracker.getStatus("task-1")).toBe("in-progress");
    tracker.setStatus("task-1", "done");
    expect(tracker.getStatus("task-1")).toBe("done");
  });

  it("records blocked with an optional reason", () => {
    const tracker = createSpecTaskStatusTracker();

    tracker.setStatus("task-2", "blocked", { reason: "waiting on upstream" });

    expect(tracker.getStatus("task-2")).toBe("blocked");
  });

  it("overwriting a status moves the count between buckets", () => {
    const tracker = createSpecTaskStatusTracker();
    tracker.setStatus("task-1", "pending");
    tracker.setStatus("task-1", "done");

    const summary = tracker.summary();
    expect(summary.total).toBe(1);
    expect(summary.counts.pending).toBe(0);
    expect(summary.counts.done).toBe(1);
  });

  it("rejects an invalid status", () => {
    const tracker = createSpecTaskStatusTracker();

    expect(() => tracker.setStatus("task-1", "nope" as never)).toThrow();
  });

  it("summary counts every status across tasks", () => {
    const tracker = createSpecTaskStatusTracker();
    tracker.setStatus("a", "pending");
    tracker.setStatus("b", "in-progress");
    tracker.setStatus("c", "done");
    tracker.setStatus("d", "done");
    tracker.setStatus("e", "blocked");

    const summary = tracker.summary();
    expect(summary.total).toBe(5);
    expect(summary.counts).toEqual({ pending: 1, "in-progress": 1, done: 2, blocked: 1 });
  });

  it("groups summary counts by wave label when provided", () => {
    const tracker = createSpecTaskStatusTracker();
    tracker.setStatus("a", "done", { wave: "wave-1" });
    tracker.setStatus("b", "in-progress", { wave: "wave-1" });
    tracker.setStatus("c", "blocked", { wave: "wave-2" });
    tracker.setStatus("d", "pending");

    const summary = tracker.summary();
    expect(summary.total).toBe(4);
    expect(summary.byWave["wave-1"]).toEqual({ pending: 0, "in-progress": 1, done: 1, blocked: 0, total: 2 });
    expect(summary.byWave["wave-2"]).toEqual({ pending: 0, "in-progress": 0, done: 0, blocked: 1, total: 1 });
    expect(Object.keys(summary.byWave)).toHaveLength(2);
  });

  it("reassigning a task's wave moves it between wave buckets", () => {
    const tracker = createSpecTaskStatusTracker();
    tracker.setStatus("a", "done", { wave: "wave-1" });
    tracker.setStatus("a", "done", { wave: "wave-2" });

    const summary = tracker.summary();
    expect(summary.byWave["wave-1"]).toBeUndefined();
    expect(summary.byWave["wave-2"]).toEqual({ pending: 0, "in-progress": 0, done: 1, blocked: 0, total: 1 });
  });
});

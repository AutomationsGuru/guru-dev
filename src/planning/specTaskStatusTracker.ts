import { z } from "zod";

/**
 * Spec task status tracker (IDEA-F158-TASK-STATUS-01) — an in-memory record of every
 * spec task's status (`pending` / `in-progress` / `done` / `blocked`), keyed by task id,
 * with an optional wave label per task. `summary()` rolls the raw statuses up into an
 * overall count per status plus a per-wave progress breakdown, so a spec run can report
 * how far each wave has advanced without the caller re-deriving the buckets.
 */

export const SPEC_TASK_STATUSES = ["pending", "in-progress", "done", "blocked"] as const;

export const SpecTaskStatusSchema = z.enum(SPEC_TASK_STATUSES);
export type SpecTaskStatus = z.infer<typeof SpecTaskStatusSchema>;

export const SpecTaskStatusCountsSchema = z
  .object({
    pending: z.number().int().nonnegative(),
    "in-progress": z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative()
  })
  .strict();
export type SpecTaskStatusCounts = z.infer<typeof SpecTaskStatusCountsSchema>;

export interface WaveSummary extends SpecTaskStatusCounts {
  total: number;
}

export interface SpecTaskStatusSummary {
  total: number;
  counts: SpecTaskStatusCounts;
  byWave: Record<string, WaveSummary>;
}

export interface SetStatusOptions {
  /** Optional wave label the task belongs to; summary() groups counts under it. */
  wave?: string;
  /** Optional human-readable note (e.g. why a task is blocked). */
  reason?: string;
}

export interface SpecTaskStatusTracker {
  /** Record or transition a task's status; unknown ids are registered on first call. */
  setStatus(taskId: string, status: SpecTaskStatus, options?: SetStatusOptions): void;
  /** Current status of a task, or undefined when the id has never been seen. */
  getStatus(taskId: string): SpecTaskStatus | undefined;
  /** Overall counts per status plus a per-wave breakdown. */
  summary(): SpecTaskStatusSummary;
}

interface TaskRecord {
  status: SpecTaskStatus;
  wave?: string;
  reason?: string;
}

function emptyCounts(): SpecTaskStatusCounts {
  return { pending: 0, "in-progress": 0, done: 0, blocked: 0 };
}

export function createSpecTaskStatusTracker(): SpecTaskStatusTracker {
  const records = new Map<string, TaskRecord>();

  return {
    setStatus: (taskId, status, options = {}) => {
      const parsed = SpecTaskStatusSchema.parse(status);
      const record: TaskRecord = { status: parsed };
      if (options.wave !== undefined) {
        record.wave = options.wave;
      }
      if (options.reason !== undefined) {
        record.reason = options.reason;
      }
      records.set(taskId, record);
    },
    getStatus: (taskId) => records.get(taskId)?.status,
    summary: () => {
      const counts = emptyCounts();
      const byWave = new Map<string, WaveSummary>();
      let total = 0;
      for (const record of records.values()) {
        counts[record.status] += 1;
        total += 1;
        if (record.wave !== undefined) {
          let wave = byWave.get(record.wave);
          if (!wave) {
            wave = { ...emptyCounts(), total: 0 };
            byWave.set(record.wave, wave);
          }
          wave[record.status] += 1;
          wave.total += 1;
        }
      }
      return { total, counts, byWave: Object.fromEntries(byWave) };
    }
  };
}

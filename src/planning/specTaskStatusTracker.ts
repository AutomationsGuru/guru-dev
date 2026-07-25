import { z } from "zod";

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
  readonly wave?: string;
  readonly reason?: string;
}

export interface SpecTaskStatusTracker {
  setStatus(taskId: string, status: SpecTaskStatus, options?: SetStatusOptions): void;
  getStatus(taskId: string): SpecTaskStatus | undefined;
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
    setStatus(taskId, status, options = {}) {
      const record: TaskRecord = { status: SpecTaskStatusSchema.parse(status) };

      if (options.wave !== undefined) {
        record.wave = options.wave;
      }
      if (options.reason !== undefined) {
        record.reason = options.reason;
      }

      records.set(taskId, record);
    },
    getStatus(taskId) {
      return records.get(taskId)?.status;
    },
    summary() {
      const counts = emptyCounts();
      const byWave = new Map<string, WaveSummary>();
      let total = 0;

      for (const record of records.values()) {
        counts[record.status] += 1;
        total += 1;

        if (record.wave !== undefined) {
          const wave = byWave.get(record.wave) ?? { ...emptyCounts(), total: 0 };
          wave[record.status] += 1;
          wave.total += 1;
          byWave.set(record.wave, wave);
        }
      }

      return { total, counts, byWave: Object.fromEntries(byWave) };
    }
  };
}

/**
 * Box resource metrics snapshot (IDEA-F350-TOP-01 · R-AB-TOP).
 *
 * Pure structure for sandbox-box resource readings: cpu / mem / disk percentages
 * with clamp + max helpers. This is the data foundation the box lifecycle
 * resource-monitor (idle auto-pause, unbounded-cost budgets) consumes.
 *
 * No I/O, no provider coupling, no Docker. Pure, testable, dependency-light.
 * Readings are clamped to [0, 100] structurally so a bogus provider value can
 * never leak into a budget/pause decision — the bound is enforced in code, not
 * left as a prompt rule (vision §3 hard limits: unbounded cost must be bounded).
 */

import { z } from "zod";

/** A single resource kind tracked per box. */
export const BoxResourceKindSchema = z.enum(["cpu", "mem", "disk"]);
export type BoxResourceKind = z.infer<typeof BoxResourceKindSchema>;

/** Lower/upper bound for a percentage reading. Exported for tests + callers. */
export const MIN_PERCENT = 0;
export const MAX_PERCENT = 100;

/**
 * Clamp a percentage to [0, 100].
 *
 * Non-finite values (NaN / Infinity) collapse to 0 — a missing or corrupt
 * reading must read as "no usage," never as unbounded usage. This is the
 * structural guard that keeps budget math honest.
 */
export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return MIN_PERCENT;
  if (value < MIN_PERCENT) return MIN_PERCENT;
  if (value > MAX_PERCENT) return MAX_PERCENT;
  return value;
}

/** A single resource reading (0–100 percent). */
export const BoxResourceMetricSchema = z.object({
  kind: BoxResourceKindSchema,
  percent: z.number().min(MIN_PERCENT).max(MAX_PERCENT)
});
export type BoxResourceMetric = z.infer<typeof BoxResourceMetricSchema>;

/**
 * Helper to build a single clamped metric from a raw provider value.
 * Use this when ingesting untrusted numbers so the clamp is not skippable.
 */
export function makeMetric(kind: BoxResourceKind, rawPercent: number): BoxResourceMetric {
  return { kind, percent: clampPercent(rawPercent) };
}

/**
 * A point-in-time resource snapshot for one box.
 *
 * `takenMs` is an externally-supplied epoch millis (callers pass `Date.now()`
 * from the host loop) so this module stays pure and clock-free. Optional
 * `limitMb` (mem) / `limitDiskMb` (disk) carry the box's configured ceiling so
 * a percentage can later be resolved against an absolute cap without a second
 * lookup.
 */
export const BoxResourceMetricsSnapshotSchema = z.object({
  boxId: z.string().trim().min(1).max(256),
  takenMs: z.number().int().nonnegative(),
  cpuPercent: z.number().min(MIN_PERCENT).max(MAX_PERCENT),
  memPercent: z.number().min(MIN_PERCENT).max(MAX_PERCENT),
  diskPercent: z.number().min(MIN_PERCENT).max(MAX_PERCENT),
  limitMb: z.number().int().positive().optional(),
  limitDiskMb: z.number().int().positive().optional()
});
export type BoxResourceMetricsSnapshot = z.infer<typeof BoxResourceMetricsSnapshotSchema>;

/**
 * Build a snapshot from raw (untrusted) provider readings, clamping each axis.
 * Prefer this over constructing the object literal so no axis can bypass the clamp.
 */
export function makeSnapshot(input: {
  boxId: string;
  takenMs: number;
  cpuPercent: number;
  memPercent: number;
  diskPercent: number;
  limitMb?: number;
  limitDiskMb?: number;
}): BoxResourceMetricsSnapshot {
  const snap: BoxResourceMetricsSnapshot = {
    boxId: input.boxId,
    takenMs: input.takenMs,
    cpuPercent: clampPercent(input.cpuPercent),
    memPercent: clampPercent(input.memPercent),
    diskPercent: clampPercent(input.diskPercent)
  };
  if (input.limitMb !== undefined) snap.limitMb = input.limitMb;
  if (input.limitDiskMb !== undefined) snap.limitDiskMb = input.limitDiskMb;
  return snap;
}

/**
 * Element-wise peak of two snapshots (same box, later time wins for `takenMs`).
 *
 * Used to roll up the worst observed resource pressure across a window — the
 * number a budget/idle-pause policy compares against. Both inputs are assumed
 * already clamped (schema-enforced); this takes the max per axis defensively.
 */
export function maxSnapshot(
  a: BoxResourceMetricsSnapshot,
  b: BoxResourceMetricsSnapshot
): BoxResourceMetricsSnapshot {
  const pick = (x: number, y: number): number => clampPercent(Math.max(x, y));
  const out: BoxResourceMetricsSnapshot = {
    boxId: a.boxId,
    takenMs: Math.max(a.takenMs, b.takenMs),
    cpuPercent: pick(a.cpuPercent, b.cpuPercent),
    memPercent: pick(a.memPercent, b.memPercent),
    diskPercent: pick(a.diskPercent, b.diskPercent)
  };
  if (a.limitMb !== undefined || b.limitMb !== undefined) {
    const vals = [a.limitMb, b.limitMb].filter((v): v is number => v !== undefined);
    if (vals.length) out.limitMb = Math.min(...vals);
  }
  if (a.limitDiskMb !== undefined || b.limitDiskMb !== undefined) {
    const vals = [a.limitDiskMb, b.limitDiskMb].filter((v): v is number => v !== undefined);
    if (vals.length) out.limitDiskMb = Math.min(...vals);
  }
  return out;
}

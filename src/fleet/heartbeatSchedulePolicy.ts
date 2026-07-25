/**
 * Heartbeat schedule policy — pure nextFireAt calculator for lightweight
 * agent wake jobs. Interval heartbeats only; no cron, no external scheduler.
 *
 * nextFire(last, intervalMs) returns the next scheduled fire time.
 * Rejects non-positive intervals (zero invalid per plan).
 */

export function nextFire(last: Date | number, intervalMs: number): Date {
  if (intervalMs <= 0) {
    throw new Error("intervalMs must be positive");
  }
  const lastMs = last instanceof Date ? last.getTime() : last;
  return new Date(lastMs + intervalMs);
}

/**
 * Miss monitor (F26) — lightweight, session-scoped counter for scout misses.
 *
 * Tracks how many speculative branches failed to match reality, so the
 * governor can decide when to throttle. No durable PII: only counts and
 * optional tool/tag labels are retained.
 */

export interface MissRecord {
  readonly toolId: string;
  readonly tags?: ReadonlyArray<string> | undefined;
  readonly at: number; // monotonic counter, not wall-clock
}

export interface MissMonitorStats {
  readonly total: number;
}

export interface MissMonitor {
  /** Record a miss for the given task shape. */
  record(toolId: string, tags?: ReadonlyArray<string>): void;
  /** Current total miss count. */
  stats(): MissMonitorStats;
  /** All recorded miss records. */
  records(): ReadonlyArray<MissRecord>;
  /** Reset the session-scoped counters. */
  reset(): void;
}

export function createMissMonitor(): MissMonitor {
  let count = 0;
  const records: MissRecord[] = [];

  return {
    record(toolId, tags) {
      count += 1;
      records.push({ toolId, tags, at: count });
    },
    stats() {
      return { total: count };
    },
    records() {
      return records;
    },
    reset() {
      count = 0;
      records.length = 0;
    }
  };
}

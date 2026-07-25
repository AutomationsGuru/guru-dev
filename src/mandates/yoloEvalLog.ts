import type { MandateOutcome } from "./evaluate.js";

/**
 * Structural evaluation-order log for gated tool calls.
 *
 * Records only non-secret identifiers: the tool, whether a hard edge was hit,
 * whether YOLO was active, and the final mandate decision. Tool input, paths,
 * reasons, and any credential-like values are intentionally excluded.
 *
 * The log is opt-in (disabled by default) and keeps a bounded ring buffer so
 * runtime memory stays predictable.
 */

export interface YoloEvalLogEntry {
  /** Tool id that was evaluated. */
  readonly tool: string;
  /** True when the evaluation hit a hard-edge verb (destructive/spend/secret-edge/auth-edge). */
  readonly hardLimitHit: boolean;
  /** True when the session was in YOLO mode at evaluation time. */
  readonly yoloActive: boolean;
  /** Final mandate decision. */
  readonly decision: MandateOutcome;
  /** ISO 8601 timestamp of the record. */
  readonly timestamp: string;
}

export interface YoloEvalLogOptions {
  /** Maximum number of retained entries; defaults to 50. */
  readonly maxEntries?: number;
  /** Whether to record entries; false means silent discard. */
  readonly enabled?: boolean;
  /** Clock used to timestamp entries. */
  readonly now?: () => Date;
}

export interface YoloEvalLog {
  /**
   * Records a structural evaluation-order entry.
   * Returns the timestamped entry when enabled, otherwise `undefined`.
   */
  recordEval(entry: Omit<YoloEvalLogEntry, "timestamp">): YoloEvalLogEntry | undefined;
  /** Returns a snapshot of retained entries, oldest first. */
  getEntries(): readonly YoloEvalLogEntry[];
  /** Removes all retained entries. */
  clear(): void;
}

const DEFAULT_MAX_ENTRIES = 50;

/**
 * Creates a lightweight, bounded YOLO evaluation-order log.
 * The log is off by default (opt-in verbose); turn it on with `enabled: true`.
 * Excess entries are discarded oldest-first.
 */
export function createYoloEvalLog(options: YoloEvalLogOptions = {}): YoloEvalLog {
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
  const enabled = options.enabled ?? false;
  const now = options.now ?? (() => new Date());

  const entries: YoloEvalLogEntry[] = [];

  function recordEval(entry: Omit<YoloEvalLogEntry, "timestamp">): YoloEvalLogEntry | undefined {
    if (!enabled) {
      return undefined;
    }
    const record = { ...entry, timestamp: now().toISOString() };
    entries.push(record);
    while (entries.length > maxEntries) {
      entries.shift();
    }
    return record;
  }

  return {
    recordEval,
    getEntries: () => [...entries],
    clear: () => {
      entries.length = 0;
    }
  };
}

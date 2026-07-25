/**
 * Bounded-loop caps (IDEA-B3-SCHEDULE-WAKE-01).
 *
 * Every long loop in the harness — agent turns, planner fanout, scheduled
 * wakes, self-build iterations — must run inside explicit token, wall-clock,
 * iteration, fanout, and spend bounds. This module is the structural
 * enforcement point: caps are checked in code and exceedance is a thrown
 * error or a failed verdict, never a prompt instruction. A `$0` spend cap
 * denies any positive spend (hard limit §3.2 — no unapproved spend), and
 * absurd configured values are clamped to absolute ceilings so "effectively
 * unlimited" configurations cannot silently reintroduce an unbounded loop.
 *
 * The module is pure bookkeeping: callers own usage accounting and call
 * {@link LoopCaps.check} (or {@link LoopCaps.throwIfExceeded}) at each loop
 * iteration. `src/runtime/scheduleBackend.ts` consumes these caps for the
 * in-process scheduler.
 */

export const LOOP_CAP_KEYS = ["maxIterations", "maxTokens", "maxWallClockMs", "maxFanoutWidth", "maxSpendUsd"] as const;

export type LoopCapKey = (typeof LOOP_CAP_KEYS)[number];

/**
 * Operator-configured loop bounds. Every field is optional; an absent field
 * means "no configured cap for this dimension" (the absolute ceiling still
 * applies once one is configured, and `check` only enforces configured caps).
 * All values must be finite and, for spend, non-negative; otherwise they are
 * rejected instead of silently ignored (fail closed).
 */
export interface LoopCapsConfig {
  /** Maximum loop iterations / scheduler fires before the loop stops. Integer ≥ 1. */
  readonly maxIterations?: number;
  /** Maximum cumulative model tokens the loop may consume. Integer ≥ 1. */
  readonly maxTokens?: number;
  /** Maximum wall-clock runtime in milliseconds. Number > 0. */
  readonly maxWallClockMs?: number;
  /** Maximum concurrent workers / active tasks the loop may fan out to. Integer ≥ 1. */
  readonly maxFanoutWidth?: number;
  /** Maximum cumulative spend in USD. Number ≥ 0; `0` denies any positive spend. */
  readonly maxSpendUsd?: number;
}

/** Cumulative usage counters, supplied by the caller at each check point. */
export interface LoopUsage {
  readonly iterations: number;
  readonly totalTokens: number;
  readonly wallClockMs: number;
  readonly fanoutWidth: number;
  readonly spendUsd: number;
}

/** One exceeded bound: which cap, the configured limit, and the observed value. */
export interface LoopCapExceededDetail {
  readonly cap: LoopCapKey;
  readonly limit: number;
  readonly actual: number;
}

/** Result of a caps check: `ok` when every configured bound still holds. */
export interface LoopCapVerdict {
  readonly ok: boolean;
  readonly exceeded: readonly LoopCapExceededDetail[];
}

/**
 * Absolute safety ceilings. Even an operator-configured cap is clamped down
 * to these values, so a typo or hostile config cannot make a loop effectively
 * unbounded. Ceilings are generous enough for legitimate overnight runs while
 * still guaranteeing termination inside a finite envelope.
 */
export const LOOP_CAPS_ABSOLUTE_CEILINGS: Readonly<Record<LoopCapKey, number>> = {
  maxIterations: 1_000_000,
  maxTokens: 100_000_000,
  // One week in milliseconds: long enough for overnight/weekly schedules,
  // short enough that a runaway timer cannot outlive its operator's intent.
  maxWallClockMs: 7 * 24 * 60 * 60 * 1_000,
  maxFanoutWidth: 1_024,
  maxSpendUsd: 10_000
};

/** Error thrown by {@link LoopCaps.throwIfExceeded}; carries the structured exceedance details. */
export class LoopCapExceededError extends Error {
  readonly code = "LOOP_CAP_EXCEEDED" as const;
  readonly exceeded: readonly LoopCapExceededDetail[];

  constructor(exceeded: readonly LoopCapExceededDetail[]) {
    super(
      `Loop cap exceeded: ${exceeded.map((detail) => `${detail.cap} limit ${detail.limit} reached by ${detail.actual}`).join("; ")}. The loop must stop (fail closed).`
    );
    this.name = "LoopCapExceededError";
    this.exceeded = [...exceeded];
  }
}

export interface LoopCaps {
  /** True when at least one cap was configured. */
  readonly configured: boolean;
  /** Effective limits after ceiling clamping (only configured keys are present). */
  readonly limits: Readonly<Partial<Record<LoopCapKey, number>>>;
  /** Evaluate usage against every configured cap; never throws on exceedance. */
  check(usage: LoopUsage): LoopCapVerdict;
  /** Same evaluation as {@link check}, but throws {@link LoopCapExceededError} on exceedance. */
  throwIfExceeded(usage: LoopUsage): void;
}

function assertCapValue(name: LoopCapKey, value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Loop cap ${name} must be a finite number; refusing to ignore an invalid bound.`);
  }
  if (name === "maxSpendUsd") {
    if (value < 0) {
      throw new Error(`Loop cap ${name} must be ≥ 0 (a $0 cap denies all spend); refusing to ignore an invalid bound.`);
    }
    return;
  }
  if (value <= 0) {
    throw new Error(`Loop cap ${name} must be a positive value; refusing to ignore an invalid bound.`);
  }
  if (name !== "maxWallClockMs" && !Number.isInteger(value)) {
    throw new Error(`Loop cap ${name} must be an integer; refusing to ignore an invalid bound.`);
  }
}

/**
 * Validate a caps config, throwing on any invalid value. Exported so config
 * loaders can reject bad operator input at load time instead of at first use.
 */
export function assertLoopCapConfig(config: LoopCapsConfig): void {
  for (const key of LOOP_CAP_KEYS) {
    const value = config[key];
    if (value !== undefined) {
      assertCapValue(key, value);
    }
  }
}

/** Create a caps checker. Invalid configured values throw; absent dimensions are unenforced. */
export function createLoopCaps(config: LoopCapsConfig = {}): LoopCaps {
  assertLoopCapConfig(config);

  const limits: Partial<Record<LoopCapKey, number>> = {};
  for (const key of LOOP_CAP_KEYS) {
    const value = config[key];
    if (value !== undefined) {
      limits[key] = Math.min(value, LOOP_CAPS_ABSOLUTE_CEILINGS[key]);
    }
  }

  const configured = LOOP_CAP_KEYS.some((key) => limits[key] !== undefined);

  const usageValueFor = (usage: LoopUsage, key: LoopCapKey): number => {
    switch (key) {
      case "maxIterations":
        return usage.iterations;
      case "maxTokens":
        return usage.totalTokens;
      case "maxWallClockMs":
        return usage.wallClockMs;
      case "maxFanoutWidth":
        return usage.fanoutWidth;
      case "maxSpendUsd":
        return usage.spendUsd;
    }
  };

  const check = (usage: LoopUsage): LoopCapVerdict => {
    const exceeded: LoopCapExceededDetail[] = [];
    for (const key of LOOP_CAP_KEYS) {
      const limit = limits[key];
      if (limit === undefined) {
        continue;
      }
      const actual = usageValueFor(usage, key);
      // Exhaustion caps (iterations, tokens, wall-clock) stop the loop AT the
      // limit — the budget is spent when the counter reaches it. Capacity caps
      // (fanout width, spend) block ABOVE the limit — running exactly at the
      // bound is legal, one unit past it is not (a $0 cap denies any positive
      // spend; maxFanoutWidth 1 allows exactly one active worker).
      const breached = key === "maxFanoutWidth" || key === "maxSpendUsd" ? actual > limit : actual >= limit;
      if (breached) {
        exceeded.push({ cap: key, limit, actual });
      }
    }
    return { ok: exceeded.length === 0, exceeded };
  };

  return {
    configured,
    limits,
    check,
    throwIfExceeded(usage: LoopUsage): void {
      const verdict = check(usage);
      if (!verdict.ok) {
        throw new LoopCapExceededError(verdict.exceeded);
      }
    }
  };
}

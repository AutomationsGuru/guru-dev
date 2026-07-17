import { z } from "zod";

import type { ReviewGateVerdict } from "../review/gates.js";

/**
 * The self-build developer loop's spine (P7) — the pieces that make an UNATTENDED
 * SELECT→BUILD→TEST→SMOKE→DEBUG→REVIEW→SHIP→LEARN cycle safe to run:
 *   1. `DevCycleBudget` — every model loop is bounded by an attempt cap AND a token
 *      budget AND a wall-clock ceiling, plus a `$0`-denies-all spend gate. Spend is the
 *      one hard gate: an integer counter alone is never allowed to bound a loop.
 *   2. `nextStage` — the 0→7 transition as a PURE reducer, so routing (RED→DEBUG,
 *      review-RED→terminate, give-up→blocked) is testable without any I/O.
 * These are I/O-free by construction; the driver that wraps `runSelfBuildExecutor` and
 * injects the mandate policy consumes them.
 */

// ── Budget (spend is the one hard gate) ──────────────────────────────────────

export const SpendBudgetSchema = z
  .object({
    /** Ceiling in USD. `0` (the default) denies ALL spend — the fail-closed stance. */
    ceilingUsd: z.number().min(0).default(0),
    spentUsd: z.number().min(0).default(0)
  })
  .strict();
export type SpendBudget = z.infer<typeof SpendBudgetSchema>;

export const RunDevCycleConfigSchema = z
  .object({
    /** Attempt cap: total stage-advances / DEBUG re-entries before the loop halts. */
    maxIterations: z.number().int().positive().max(100).default(6),
    /** Cumulative model-token ceiling across the loop AND every nested guru-call. */
    tokenBudget: z.number().int().positive().default(500_000),
    /** Wall-clock ceiling so a hung stage cannot stall the loop forever. */
    wallClockMs: z.number().int().positive().default(1_800_000),
    spend: SpendBudgetSchema.default({ ceilingUsd: 0, spentUsd: 0 })
  })
  .strict();
export type RunDevCycleConfig = z.infer<typeof RunDevCycleConfigSchema>;

export interface Clock {
  now(): number;
}

const SYSTEM_CLOCK: Clock = { now: () => Date.now() };

export interface BudgetSnapshot {
  readonly attempts: number;
  readonly maxIterations: number;
  readonly tokens: number;
  readonly tokenBudget: number;
  readonly spentUsd: number;
  readonly ceilingUsd: number;
  readonly elapsedMs: number;
  readonly wallClockMs: number;
}

export const DevCycleBudgetSeedSchema = z
  .object({
    attempts: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    spentUsd: z.number().nonnegative(),
    elapsedMs: z.number().nonnegative()
  })
  .strict();
export type DevCycleBudgetSeed = z.infer<typeof DevCycleBudgetSeedSchema>;

/**
 * Bounds a dev-cycle run three independent ways (any one is sufficient to halt) and
 * gates spend. `$0` ceiling denies every positive spend — the fail-closed default.
 */
export class DevCycleBudget {
  private attempts: number;
  private tokens: number;
  private spentUsd: number;
  private readonly startedAt: number;

  constructor(
    private readonly config: RunDevCycleConfig,
    private readonly clock: Clock = SYSTEM_CLOCK,
    seed?: DevCycleBudgetSeed
  ) {
    const hydrated = seed ? DevCycleBudgetSeedSchema.parse(seed) : null;
    this.attempts = hydrated?.attempts ?? 0;
    this.tokens = hydrated?.tokens ?? 0;
    this.spentUsd = hydrated?.spentUsd ?? config.spend.spentUsd;
    this.startedAt = clock.now() - (hydrated?.elapsedMs ?? 0);
  }

  /** Non-null reason the loop must stop (attempt / token / wall-clock exhausted), else null. */
  exhaustedReason(): string | null {
    if (this.attempts >= this.config.maxIterations) {
      return `attempt cap reached (${this.attempts}/${this.config.maxIterations})`;
    }
    if (this.tokens >= this.config.tokenBudget) {
      return `token budget exhausted (${this.tokens}/${this.config.tokenBudget})`;
    }
    const elapsed = this.clock.now() - this.startedAt;
    if (elapsed >= this.config.wallClockMs) {
      return `wall-clock exceeded (${elapsed}ms/${this.config.wallClockMs}ms)`;
    }
    return null;
  }

  recordAttempt(): void {
    this.attempts += 1;
  }

  recordTokens(count: number): void {
    this.tokens += Math.max(0, count);
  }

  /**
   * Spend hard-gate: `true` only when the amount is free (≤0) OR fits under the ceiling.
   * A `$0` ceiling denies every positive amount — spend is the one un-liftable gate.
   */
  canSpend(amountUsd: number): boolean {
    if (amountUsd <= 0) {
      return true;
    }
    return this.spentUsd + amountUsd <= this.config.spend.ceilingUsd;
  }

  recordSpend(amountUsd: number): void {
    this.spentUsd += Math.max(0, amountUsd);
  }

  snapshot(): BudgetSnapshot {
    return {
      attempts: this.attempts,
      maxIterations: this.config.maxIterations,
      tokens: this.tokens,
      tokenBudget: this.config.tokenBudget,
      spentUsd: this.spentUsd,
      ceilingUsd: this.config.spend.ceilingUsd,
      elapsedMs: this.clock.now() - this.startedAt,
      wallClockMs: this.config.wallClockMs
    };
  }
}

// ── The 0→7 stage state machine (pure) ───────────────────────────────────────

export type DevStage =
  | "select"
  | "build"
  | "test"
  | "smoke"
  | "debug"
  | "review"
  | "ship"
  | "learn"
  | "done"
  | "blocked";

export type StageVerdict = ReviewGateVerdict;

export interface StageOutcome {
  readonly stage: DevStage;
  readonly verdict: StageVerdict;
  readonly evidence: string;
}

/** The ordered working stages (excludes the terminal `done`/`blocked`). */
export const DEV_STAGE_ORDER: readonly DevStage[] = [
  "select",
  "build",
  "test",
  "smoke",
  "debug",
  "review",
  "ship",
  "learn"
];

export function isTerminal(stage: DevStage): boolean {
  return stage === "done" || stage === "blocked";
}

/**
 * Pure routing: given a stage's verdict, where does the loop go? RED at TEST/SMOKE routes
 * to DEBUG; DEBUG-GREEN re-validates from TEST; DEBUG-RED (gave up) and a hard RED at
 * BUILD/REVIEW/SHIP terminate as `blocked` (review-RED must never ship). YELLOW is a
 * legible pass — the loop proceeds but the caller records the note.
 */
export function nextStage(stage: DevStage, verdict: StageVerdict): DevStage {
  const red = verdict === "RED";
  switch (stage) {
    case "select":
      // No ready task (RED) → nothing to do, done. Otherwise build.
      return red ? "done" : "build";
    case "build":
      return red ? "blocked" : "test";
    case "test":
      return red ? "debug" : "smoke";
    case "smoke":
      return red ? "debug" : "review";
    case "debug":
      // Repaired → re-validate from TEST; gave up → blocked.
      return red ? "blocked" : "test";
    case "review":
      // A real defect at review terminates — it must NOT ship.
      return red ? "blocked" : "ship";
    case "ship":
      return red ? "blocked" : "learn";
    case "learn":
      return "done";
    default:
      return stage; // already terminal
  }
}

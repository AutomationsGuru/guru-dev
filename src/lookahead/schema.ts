import { z } from "zod";

/**
 * Look-ahead engine v1 (Finale Wave, 2026-07-04) — the two-plane scout/commit
 * engine per docs/decisions/2026-07-04-lookahead-engine-v1.md. Scouts run ahead
 * during the commit plane's dead time; the strong model adjudicates. The commit
 * plane NEVER waits on scouts; the engine is off by default and byte-identical
 * when off.
 */

export const LookAheadConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Top-K forks pre-explored per pending step. */
    forkWidth: z.number().int().positive().max(5).default(3),
    /** How many decision-nodes ahead (shallow by law). */
    leadDepth: z.number().int().positive().max(3).default(2),
    /** Scout budget as a fraction of the main turn's projected budget. */
    scoutBudgetFraction: z.number().min(0).max(1).default(0.25),
    // --- Governor (§17 scenario 8): even when enabled, speculation is bounded. ---
    /**
     * Idempotency allowlist — pending tool ids whose forks MAY be speculated.
     * Default NOTHING: an empty allowlist means no step is ever speculated, so
     * enabling the engine alone changes nothing until the operator names the
     * idempotent tools they trust. Speculation never runs against an un-listed step.
     */
    idempotentAllowlist: z.array(z.string().trim().min(1)).default([]),
    /** Hard cap on read-only scouts spawned per SESSION (no silent overrun). */
    maxScoutsPerSession: z.number().int().positive().max(500).default(24),
    /** Miss-rate ceiling: above this (after a min sample) speculation self-throttles OFF. */
    missRateThreshold: z.number().min(0).max(1).default(0.5),
    /** Minimum resolved branches before the miss-rate throttle can engage. */
    minSamplesBeforeThrottle: z.number().int().positive().max(50).default(4)
  })
  .strict();

export type LookAheadConfig = z.infer<typeof LookAheadConfigSchema>;

/** Governor observability — surfaced by /lookahead; caps are never silent (§2). */
export interface LookAheadStats {
  readonly scoutsSpawned: number;
  readonly budgetRemaining: number;
  readonly hits: number;
  readonly misses: number;
  readonly missRate: number;
  readonly throttled: boolean;
  /** Why the most recent scoutPendingStep did NOT speculate (empty when it did / off). */
  readonly lastSkip: string;
}

/** A predicted fork of a pending step: a trigger predicate + the scout's plan. */
export interface BranchNode {
  readonly id: string;
  /** The fork this branch bets on, e.g. "tool build returns failed". */
  readonly triggerCondition: string;
  /** The scout's pre-reasoned next steps if this fork occurs (a warm hint, not executed). */
  readonly precomputedPlan: string;
  readonly scoutTaskId: string;
  state: "open" | "matched" | "pruned";
}

export interface CommitStepObservation {
  readonly toolId: string;
  /** The real result status the commit plane saw. */
  readonly status: "succeeded" | "failed";
  /** Optional detail (error text, output hint) to match against branch triggers. */
  readonly detail?: string;
}

export interface MatchResult {
  readonly outcome: "hit" | "miss";
  /** The promoted branch on a hit — its plan becomes a warm hint. */
  readonly branch?: BranchNode;
  readonly warmHint?: string;
}

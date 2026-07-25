import { z } from "zod";

/**
 * Session spend cap (IDEA-F381-SPEND-01, R-MV-SPEND) — the session-layer
 * enforcement of the second hard limit: "No unapproved spend" (VISION §3.2). A
 * running USD accumulator is bounded by an explicit ceiling, and the loop asks
 * `mayCallModel` BEFORE any billable model call. When the next call would push
 * the session over budget, the gate returns `false` and the caller must stop.
 *
 * Fail-closed by construction, mirroring the devCycle SpendBudget stance
 * (`src/selfbuild/devCycle.ts`): a ceiling of `0` (the default) denies ALL
 * spend, so an unattended loop or a misconfigured session can never silently run
 * up cost. The gate is enforced in code — never only in a prompt — which closes
 * prompt-rule drift on the spend limit.
 *
 * Pure and side-effect-free: the cap is a plain mutable state record the caller
 * owns and threads; `recordSpend` mutates it, `mayCallModel` only reads it.
 * There is no I/O, no clock, no network, so the gate is deterministically
 * testable without any provider.
 */

/**
 * Ceiling in USD. `0` (the default) denies ALL spend — the fail-closed stance.
 * Identical semantics to `SpendBudgetSchema.ceilingUsd` in the devCycle budget
 * so the two ceilings compose without surprise.
 */
export const SpendCapConfigSchema = z
  .object({
    ceilingUsd: z.number().min(0).default(0),
    /** Already-spent amount to seed the cap with (e.g. on resume). */
    spentUsd: z.number().min(0).default(0)
  })
  .strict();
export type SpendCapConfig = z.infer<typeof SpendCapConfigSchema>;

/** Default config: a $0-denies-all ceiling, nothing spent. */
export const DEFAULT_SPEND_CAP_CONFIG: SpendCapConfig = SpendCapConfigSchema.parse({});

/**
 * Mutable session spend-cap state. The caller owns the record and threads it
 * through the turn loop; `recordSpend` mutates `spentUsd` in place.
 */
export interface SpendCapState {
  ceilingUsd: number;
  spentUsd: number;
}

/** An immutable view of the cap for logging / handoff evidence. */
export interface SpendCapSnapshot {
  readonly ceilingUsd: number;
  readonly spentUsd: number;
  /** `ceilingUsd - spentUsd`, floored at 0 so an over-budget cap reports 0 left. */
  readonly remainingUsd: number;
  readonly overBudget: boolean;
}

/**
 * Build a cap state from a (possibly partial) config. Validates via the schema,
 * so an out-of-range or malformed config throws rather than yielding a
 * permissive cap — the fail-closed stance again.
 */
export function createSpendCap(config: Partial<SpendCapConfig> = {}): SpendCapState {
  const parsed = SpendCapConfigSchema.parse(config);
  return { ceilingUsd: parsed.ceilingUsd, spentUsd: parsed.spentUsd };
}

/**
 * The spend gate. Returns `true` ONLY when a model call costing `estimateUsd`
 * (default 0 — a free call still consumes nothing) would keep the session within
 * its ceiling. The cap is consulted BEFORE the call so the loop can route around
 * an over-budget state instead of paying to discover it.
 *
 * Fail-closed: a ceiling of `0` always returns `false`, because $0 denies all.
 * A negative estimate is treated as 0 (it cannot buy headroom).
 */
export function mayCallModel(state: SpendCapState, estimateUsd = 0): boolean {
  if (state.ceilingUsd <= 0) return false;
  const next = state.spentUsd + Math.max(0, estimateUsd);
  return next <= state.ceilingUsd;
}

/**
 * Record a completed model call's cost against the cap. Mutates `state.spentUsd`
 * in place and returns the post-spend snapshot. Refuses negative amounts — cost
 * cannot be clawed back through this API (a refund is an explicit operator
 * decision, not a routine loop step).
 */
export function recordSpend(state: SpendCapState, amountUsd: number): SpendCapSnapshot {
  if (!Number.isFinite(amountUsd) || amountUsd < 0) {
    throw new RangeError(`recordSpend: amountUsd must be a finite nonnegative number (got ${amountUsd})`);
  }
  state.spentUsd += amountUsd;
  return snapshot(state);
}

/** Read-only snapshot of the cap's current position. */
export function snapshot(state: SpendCapState): SpendCapSnapshot {
  const overBudget = state.spentUsd > state.ceilingUsd || state.ceilingUsd <= 0;
  return {
    ceilingUsd: state.ceilingUsd,
    spentUsd: state.spentUsd,
    remainingUsd: Math.max(0, state.ceilingUsd - state.spentUsd),
    overBudget
  };
}

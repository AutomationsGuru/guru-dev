/**
 * Max-loops auto budget (IDEA-F523-AUTOLOOP-01).
 *
 * Auto mode's continuation gate: the loop keeps running while the outcome is
 * not yet done AND the configured budget still has room. When either side
 * resolves — the operator's done flag flips true, or the budget exhausts —
 * `shouldContinue` returns false with an explicit reason so the caller stops
 * honestly instead of silently spinning or silently stopping.
 *
 * Pure decision surface: no I/O, no clock, no RNG. The caller owns ticking
 * `used` between turns and flipping `done` when the outcome lands.
 */

/** Budget units tracked by the auto loop. All are "remaining capacity". */
export interface AutoBudgetState {
  /** Iterations already consumed this session (monotonic). */
  readonly iterationsUsed: number;
  /** Tool calls already consumed this session (monotonic). */
  readonly toolCallsUsed: number;
  /** Completion tokens already consumed this session (monotonic). */
  readonly tokensUsed: number;
  /** Wall-clock milliseconds already consumed this session (monotonic). */
  readonly wallMsUsed: number;
  /** True once the outcome is reached — the loop stops regardless of budget. */
  readonly done: boolean;
}

/** Ceilings that bound the auto loop. Any field omitted is unbounded on that axis. */
export interface AutoBudgetPolicy {
  /** Iteration ceiling (loop turns). */
  readonly maxIterations?: number;
  /** Tool-call ceiling across the whole auto session. */
  readonly maxToolCalls?: number;
  /** Completion-token ceiling across the whole auto session. */
  readonly maxTokens?: number;
  /** Wall-clock ceiling in milliseconds. */
  readonly maxWallMs?: number;
}

/** Why the loop stopped. `done` is the happy path; the others name the exhausted axis. */
export type AutoBudgetStopReason =
  | "done"
  | "iterations_exhausted"
  | "tool_calls_exhausted"
  | "tokens_exhausted"
  | "wall_ms_exhausted";

export interface AutoBudgetDecision {
  /** True = run another turn; false = stop now. */
  readonly continue: boolean;
  /** Present iff `continue === false`. Never undefined on stop — honest exit. */
  readonly reason?: AutoBudgetStopReason;
}

const CONTINUE: AutoBudgetDecision = { continue: true };

/**
 * The single gate. Done short-circuits BEFORE any budget check so the loop
 * never burns one more turn after the outcome lands. Budget axes are checked
 * in a fixed order (iterations → tool calls → tokens → wall ms) so the reason
 * is deterministic when several axes exhaust on the same turn.
 *
 * An axis is "exhausted" when `used >= max`. A `max` of 0 or negative is
 * treated as already-exhausted on the first check (the policy is a ceiling,
 * not a target). Omitted axes are unbounded and never stop the loop.
 */
export function shouldContinue(state: AutoBudgetState, policy: AutoBudgetPolicy): AutoBudgetDecision {
  if (state.done) {
    return { continue: false, reason: "done" };
  }
  if (policy.maxIterations !== undefined && state.iterationsUsed >= policy.maxIterations) {
    return { continue: false, reason: "iterations_exhausted" };
  }
  if (policy.maxToolCalls !== undefined && state.toolCallsUsed >= policy.maxToolCalls) {
    return { continue: false, reason: "tool_calls_exhausted" };
  }
  if (policy.maxTokens !== undefined && state.tokensUsed >= policy.maxTokens) {
    return { continue: false, reason: "tokens_exhausted" };
  }
  if (policy.maxWallMs !== undefined && state.wallMsUsed >= policy.maxWallMs) {
    return { continue: false, reason: "wall_ms_exhausted" };
  }
  return CONTINUE;
}

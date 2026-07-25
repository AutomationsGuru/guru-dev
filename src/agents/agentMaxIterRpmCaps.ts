import { z } from "zod";

/**
 * Agent max iter / max rpm caps (IDEA-F561-CAPS-01) — pure counters that stop
 * an agent loop when an iteration budget or a per-minute request budget is
 * exceeded.
 *
 * This module is a leaf utility: it performs no I/O and never reads the clock
 * itself — `nowMs` is always a parameter, so every decision is deterministic
 * and replayable. The caller owns the counters; this module only DECIDES and
 * returns immutable updates.
 *
 * Contract:
 *  - Caps are optional per dimension; an absent cap means "no limit" for that
 *    dimension. Caps are validated by {@link AgentCapsSchema}: each cap must
 *    be a positive integer; non-positive or non-integer values are REJECTED at
 *    the parse step (never silently treated as no-limit), matching the repo's
 *    zod-validated config standard.
 *  - maxIter is evaluated FIRST (it is the harder stop — the loop is done),
 *    then maxRpm. When both would trip, the reason is `max_iter_exceeded`.
 *  - maxRpm uses a FIXED 60_000 ms window anchored at `windowStartedAtMs`
 *    (not a sliding log). When `nowMs - windowStartedAtMs >= 60_000` the window
 *    has rolled and the rpm counter is treated as reset; the decision reports
 *    `windowRolled: true` so the caller can persist the roll via
 *    {@link rollWindow} / {@link recordRequest}. `mayContinue` never mutates
 *    the state it is given.
 */

/** Length of the fixed rpm accounting window in milliseconds. */
export const RPM_WINDOW_MS = 60_000;

/** Optional caps for an agent loop. An absent cap means no limit. */
export const AgentCapsSchema = z
  .object({
    /** Hard iteration budget: stop when `state.iteration >= maxIter`. */
    maxIter: z.number().int().positive().optional(),
    /** Request budget per fixed 60s window. */
    maxRpm: z.number().int().positive().optional()
  })
  .strict();

export type AgentCaps = z.infer<typeof AgentCapsSchema>;

/** Pure counter state for the caps decision. Owned and advanced by the caller. */
export interface AgentCapState {
  /** Number of iterations the loop has completed. */
  readonly iteration: number;
  /** Timestamp (ms) anchoring the current fixed rpm window. */
  readonly windowStartedAtMs: number;
  /** Requests recorded inside the current window. */
  readonly requestsInWindow: number;
}

/** Why the loop must stop. maxIter is reported before maxRpm when both trip. */
export type CapStopReason = "max_iter_exceeded" | "max_rpm_exceeded";

/** Structured decision from {@link mayContinue}. */
export interface CapDecision {
  readonly allowed: boolean;
  /** Present iff `allowed` is false. */
  readonly reason?: CapStopReason;
  /**
   * True when the fixed rpm window has rolled at `nowMs`, so the caller should
   * persist fresh state via {@link rollWindow} / {@link recordRequest}.
   */
  readonly windowRolled: boolean;
}

/** Seed a zeroed counter state anchored at `nowMs`. */
export function initialCapState(nowMs: number): AgentCapState {
  return { iteration: 0, windowStartedAtMs: nowMs, requestsInWindow: 0 };
}

/** True when the fixed 60s window anchored in `state` has elapsed at `nowMs`. */
function hasWindowRolled(state: AgentCapState, nowMs: number): boolean {
  return nowMs - state.windowStartedAtMs >= RPM_WINDOW_MS;
}

/**
 * Decide whether the agent loop may take another step.
 *
 * Evaluation order: maxIter first, then maxRpm. A rolled rpm window resets the
 * effective rpm count for this decision (and is reported via `windowRolled`);
 * the input state is never mutated.
 */
export function mayContinue(
  state: AgentCapState,
  caps: AgentCaps,
  nowMs: number
): CapDecision {
  const windowRolled = hasWindowRolled(state, nowMs);

  if (caps.maxIter !== undefined && state.iteration >= caps.maxIter) {
    return { allowed: false, reason: "max_iter_exceeded", windowRolled };
  }

  const effectiveRequests = windowRolled ? 0 : state.requestsInWindow;
  if (caps.maxRpm !== undefined && effectiveRequests >= caps.maxRpm) {
    return { allowed: false, reason: "max_rpm_exceeded", windowRolled };
  }

  return { allowed: true, windowRolled };
}

/**
 * Return fresh state with the rpm window re-anchored at `nowMs` and the rpm
 * counter zeroed when the window has rolled; otherwise return an unchanged
 * copy. The iteration counter is preserved either way. Never mutates `state`.
 */
export function rollWindow(state: AgentCapState, nowMs: number): AgentCapState {
  if (!hasWindowRolled(state, nowMs)) {
    return { ...state };
  }
  return { ...state, windowStartedAtMs: nowMs, requestsInWindow: 0 };
}

/**
 * Record one iteration + one request, returning fresh state. Rolls the window
 * first when it has elapsed, so the new request counts in the new window.
 * Never mutates `state`.
 */
export function recordRequest(state: AgentCapState, nowMs: number): AgentCapState {
  const rolled = rollWindow(state, nowMs);
  return {
    ...rolled,
    iteration: rolled.iteration + 1,
    requestsInWindow: rolled.requestsInWindow + 1
  };
}

import { z } from "zod";

/**
 * Stall watchdog timer — scion of the agent-stall-watchdog lane (IDEA-F432, R-SC-STALL).
 *
 * Pure clock-driven decision ONLY. Given the wall-clock moment of last observed
 * progress, the current time, and the stall timeout, decide whether the watched
 * subject is stalled. There is intentionally:
 *
 *   - no background timer / interval,
 *   - no process kill / suspend / restart,
 *   - no autonomous action.
 *
 * The caller owns the clock and the reaction. This module only answers the
 * question "has enough clock elapsed since last progress to be stalled?" so a
 * future controller can act (after preserving state and recording a recovery
 * path — never here). Keeping the decision pure makes it trivially testable with
 * injected timestamps and never couples the fleet to a timer lifecycle.
 *
 * Honesty: a missing/unknown last-progress timestamp cannot be proven stalled or
 * healthy, so it returns `unknown` rather than rounding up to either side.
 */

export const StallVerdictSchema = z.enum(["stalled", "progressing", "unknown"]);
export type StallVerdict = z.infer<typeof StallVerdictSchema>;

export const StallCheckResultSchema = z.object({
  verdict: StallVerdictSchema,
  /** Elapsed ms from lastProgress → now. Undefined when lastProgress is unknown. */
  elapsedMs: z.number().int().nonnegative().optional(),
  evidence: z.string()
});
export type StallCheckResult = z.infer<typeof StallCheckResultSchema>;

export interface StallCheckOptions {
  /** ms since the timeout at which a subject is considered stalled. */
  readonly timeoutMs: number;
}

/** Sentinel for "never observed progress" — must not be mistaken for a real timestamp. */
export const NO_PROGRESS: unique symbol = Symbol.for("guruharness.fleet.stallWatchdog.noProgress");
export type LastProgress = number | typeof NO_PROGRESS;

/**
 * Decide stall state from clock alone.
 *
 * @param lastProgress ms epoch of last observed progress, or NO_PROGRESS when unknown.
 * @param now           ms epoch of the current evaluation instant.
 * @param timeoutMs     ms threshold; elapsed strictly greater than this ⇒ stalled.
 * @returns a typed stall verdict with raw evidence (elapsed ms / reason).
 *
 * Edge handling:
 *   - non-finite or negative timeout → `unknown` (a malformed limit is not a stall verdict);
 *   - unknown last progress → `unknown` (cannot prove either side);
 *   - clock skew (lastProgress in the future) → clamp elapsed to 0 → `progressing`
 *     (a skewed clock must never manufacture a false stall);
 *   - elapsed > timeoutMs → `stalled`;
 *   - otherwise → `progressing`.
 */
export function checkStall(lastProgress: LastProgress, now: number, timeoutMs: number): StallCheckResult {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    return { verdict: "unknown", evidence: `invalid timeoutMs=${timeoutMs}` };
  }
  if (!Number.isFinite(now)) {
    return { verdict: "unknown", evidence: `invalid now=${now}` };
  }
  if (lastProgress === NO_PROGRESS) {
    return { verdict: "unknown", evidence: "no progress observed yet" };
  }
  if (!Number.isFinite(lastProgress)) {
    return { verdict: "unknown", evidence: `invalid lastProgress=${lastProgress}` };
  }

  // Clock skew: if "now" precedes last progress, the clock jumped backwards.
  // Treat elapsed as 0 — never let a skewed clock raise a false stall.
  const elapsedMs = lastProgress > now ? 0 : now - lastProgress;

  if (elapsedMs > timeoutMs) {
    return { verdict: "stalled", evidence: `elapsed ${elapsedMs}ms > timeout ${timeoutMs}ms` };
  }
  return { verdict: "progressing", evidence: `elapsed ${elapsedMs}ms ≤ timeout ${timeoutMs}ms` };
}

/** Convenience boolean for callers that only need the stall flag. */
export function isStalled(lastProgress: LastProgress, now: number, timeoutMs: number): boolean {
  return checkStall(lastProgress, now, timeoutMs).verdict === "stalled";
}

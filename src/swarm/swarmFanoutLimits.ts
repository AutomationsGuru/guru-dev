/**
 * Swarm fan-out limits (IDEA-F124-SWARM-FANOUT-01).
 *
 * A token-bucket limiter that caps concurrent sub-agents / fleet workers per
 * session. Callers acquire a token before spawning and release it when the
 * worker settles; a spawn attempted while the bucket is saturated is rejected
 * with a structured error so the caller can re-plan (queue, defer, or surface
 * the cap) instead of silently exceeding the fan-out budget.
 *
 * This is a standalone primitive. The swarm manager's own concurrency
 * scheduler is untouched — this limiter composes with anything that wants an
 * explicit acquire/release bound (fleet ledger, mission fan-out, parallel
 * reviewers) without editing core.
 */

/** Default fan-out ceiling when the caller does not configure one. */
export const DEFAULT_SWARM_FANOUT_LIMIT = 8;

/** Structured rejection when the limiter is saturated. */
export class SwarmFanoutSaturatedError extends Error {
  readonly code = "swarm_fanout_saturated";
  constructor(
    readonly limit: number,
    readonly active: number
  ) {
    super(`Swarm fan-out saturated: ${active}/${limit} slots in use — spawn rejected.`);
    this.name = "SwarmFanoutSaturatedError";
  }
}

/**
 * An acquired slot. `release()` returns the slot to its owning limiter exactly
 * once; subsequent calls are no-ops, so cleanup paths cannot over-free.
 */
export interface SwarmFanoutToken {
  release(): void;
  /** True after the token has been released. */
  readonly released: boolean;
}

export type SwarmFanoutAcquireResult =
  | { readonly ok: true; readonly token: SwarmFanoutToken }
  | { readonly ok: false; readonly error: SwarmFanoutSaturatedError };

export interface SwarmFanoutLimiter {
  /** The configured ceiling. */
  readonly max: number;
  /** Non-blocking acquire. Saturated → `{ ok: false, error }`, never throws. */
  tryAcquire(): SwarmFanoutAcquireResult;
  /** Slots currently held. */
  activeCount(): number;
}

export interface SwarmFanoutLimiterOptions {
  /** Concurrent-slot ceiling. Defaults to {@link DEFAULT_SWARM_FANOUT_LIMIT}. */
  readonly max?: number;
}

export function createSwarmFanoutLimiter(options: SwarmFanoutLimiterOptions = {}): SwarmFanoutLimiter {
  const max = options.max ?? DEFAULT_SWARM_FANOUT_LIMIT;
  if (!Number.isInteger(max) || max <= 0) {
    throw new RangeError(`swarm fan-out limit must be a positive integer, got ${String(max)}`);
  }

  let active = 0;

  const tryAcquire = (): SwarmFanoutAcquireResult => {
    if (active >= max) {
      return { ok: false, error: new SwarmFanoutSaturatedError(max, active) };
    }
    active += 1;
    let released = false;
    const token: SwarmFanoutToken = {
      release() {
        if (released) return;
        released = true;
        active -= 1;
      },
      get released() {
        return released;
      }
    };
    return { ok: true, token };
  };

  return {
    max,
    tryAcquire,
    activeCount: () => active
  };
}

/**
 * Swarm spawn-depth helpers (IDEA-F6-SWARM-SCOPE-01, R-GO-SUB-SCOPE).
 *
 * A depth counter threads every spawn: the parent session is depth 0, a
 * worker spawned by the parent is depth 1, a worker's own spawn is depth 2,
 * and so on. The hard ceiling is `maxSpawnDepth`; a spawn that would exceed
 * it fails closed with a structured error, never silently.
 *
 * This module holds the PURE primitives — the constant, the increment, and
 * the assert — so the depth rule is testable in isolation and so the
 * composition point (the swarm manager's spawn path) reads as a one-line
 * call site. The existing runtime enforcement already lives in
 * `src/swarm/manager.ts` (`SwarmDepthExceededError`, `manager.spawn`'s
 * `depth > maxSpawnDepth` check); this module introduces the F6 residual —
 * the canonical default of **2** and the pure, dependency-free helpers the
 * follow-up wiring pass will adopt.
 *
 * Why 2 (not the schema's current 3): the plan's hard-max default is 2. A
 * parent spawns a worker (depth 1); that worker may spawn ONE level of
 * grandchildren (depth 2); depth 3 is refused. Two levels of delegation is
 * the practical ceiling before context and mandate fidelity degrade past
 * daily-driver usefulness, and it is the containment the ideation review
 * called for. Re-pinning `SwarmConfigSchema.maxSpawnDepth`'s default to this
 * constant is owned by the follow-up wiring packet — this packet must not
 * edit `schema.ts`.
 */

/**
 * Canonical default for the spawn-depth hard ceiling. The parent is depth 0;
 * workers at depth 1; grandchildren at depth 2 — and depth 3 is refused.
 *
 * Follow-up wiring: `SwarmConfigSchema.maxSpawnDepth` currently defaults to
 * 3 in `src/swarm/schema.ts`; re-pinning that default to this constant is
 * out of scope for this packet (schema.ts is not an owned path).
 */
export const DEFAULT_MAX_SPAWN_DEPTH = 2;

/**
 * Absolute ceiling on the ceiling itself. Mirrors the schema's `.max(8)`
 * hard cap: no configuration can raise the spawn-depth limit past this,
 * regardless of how the value reaches the manager.
 */
export const ABSOLUTE_MAX_SPAWN_DEPTH = 8;

/**
 * The depth a worker passes when it spawns its own sub-worker. Pure
 * increment; the bound check is the caller's job (see
 * `assertSpawnDepthWithinLimit`).
 */
export function nextSpawnDepth(currentDepth: number): number {
  if (!Number.isInteger(currentDepth) || currentDepth < 0) {
    throw new RangeError(`Spawn depth must be a non-negative integer, got ${currentDepth}.`);
  }
  return currentDepth + 1;
}

/**
 * Result of a depth-check that did NOT throw — returned by
 * `checkSpawnDepthWithinLimit` for callers that want a structured verdict
 * instead of a throw (e.g., a tool surface that wants to report the denial
 * as data rather than as an exception).
 */
export interface SpawnDepthCheck {
  readonly allowed: boolean;
  readonly depth: number;
  readonly limit: number;
  /** Set only when allowed === false. */
  readonly reason?: string;
}

/**
 * Non-throwing depth check. Use this at tool surfaces that want to report
 * the denial as structured data; use `assertSpawnDepthWithinLimit` at
 * internal choke points where a thrown error is the correct failure mode.
 */
export function checkSpawnDepthWithinLimit(depth: number, limit: number): SpawnDepthCheck {
  if (!Number.isInteger(depth) || depth < 0) {
    return { allowed: false, depth, limit, reason: `Spawn depth must be a non-negative integer, got ${depth}.` };
  }
  if (!Number.isInteger(limit) || limit < 1) {
    return { allowed: false, depth, limit, reason: `Spawn-depth limit must be a positive integer, got ${limit}.` };
  }
  if (limit > ABSOLUTE_MAX_SPAWN_DEPTH) {
    return { allowed: false, depth, limit, reason: `Spawn-depth limit ${limit} exceeds the absolute cap ${ABSOLUTE_MAX_SPAWN_DEPTH}.` };
  }
  if (depth > limit) {
    return {
      allowed: false,
      depth,
      limit,
      reason: `Swarm recursion depth ${depth} exceeds the limit of ${limit} — a worker cannot spawn this deep.`
    };
  }
  return { allowed: true, depth, limit };
}

/**
 * Throwing variant for internal choke points. Throws `RangeError` with the
 * structured reason; the message matches the manager's
 * `SwarmDepthExceededError` text so the failure mode is legible from either
 * surface.
 */
export function assertSpawnDepthWithinLimit(depth: number, limit: number): void {
  const check = checkSpawnDepthWithinLimit(depth, limit);
  if (!check.allowed) {
    throw new RangeError(check.reason ?? `Spawn depth ${depth} exceeds limit ${limit}.`);
  }
}

/**
 * Convenience: given a worker's own depth and the active limit, compute the
 * depth the worker's child would have AND check it in one call. Returns the
 * child depth on success; throws on exceed.
 *
 * This is the call site the follow-up wiring pass will use in the spawn
 * tool's execute: `const childDepth = childSpawnDepth(self.depth, limit);`
 */
export function childSpawnDepth(currentDepth: number, limit: number): number {
  const child = nextSpawnDepth(currentDepth);
  assertSpawnDepthWithinLimit(child, limit);
  return child;
}

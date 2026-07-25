/**
 * Crew delegation allow flag (IDEA-F560-DELEG-01, R-CR-DELEG).
 *
 * Pure deny-only predicate: the ONLY thing this helper can ever do is *permit*
 * a delegation the caller has already authorized elsewhere, or *deny* it. It can
 * never grant authority it was not handed. A caller-supplied agent may delegate
 * only when its own `mayDelegate` field is exactly `true`; anything else
 * (explicit `false`, missing, or any non-boolean) fails closed — delegation is
 * refused. This is a fail-closed gate over a boolean input, nothing more.
 *
 * Explicitly out of scope here (the plan forbids them): spawning workers,
 * provider/model calls, persistence, runtime wiring, authority grants, CrewAI /
 * role / persona concepts, and side effects. Those, if they ever exist, live in
 * the swarm manager and must consult this predicate — this module does not call
 * them and does not import them.
 */

/**
 * The minimal agent shape this gate needs. Callers supply the full agent record;
 * only `mayDelegate` is read. Keeping this a structural (interface) type — not a
 * class — means no runtime authority or identity is fabricated: the predicate
 * works against whatever the caller already has.
 */
export interface DelegatingAgent {
  /**
   * Exactly `true` authorizes delegation for THIS agent. `false`, `undefined`,
   * or any non-boolean value denies it. The gate never coerces — a truthy
   * non-boolean (e.g. `"yes"`) is treated as "not authorized", not as a yes.
   */
  readonly mayDelegate?: unknown;
}

/**
 * Returns `true` ONLY when the agent has opted into delegation with an explicit
 * boolean `mayDelegate: true`. Everything else — `false`, absent, or a
 * non-boolean value — returns `false` (denied). No coercion, no defaults that
 * could silently confer authority, no exceptions thrown for malformed input.
 */
export function mayDelegate(agent: DelegatingAgent): boolean {
  // Fail closed: require the literal boolean true. `=== true` rejects undefined,
  // strings, numbers, objects, and any other value without throwing.
  return agent?.mayDelegate === true;
}

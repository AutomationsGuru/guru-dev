import type { ChatTurnMessage } from "../model/directChat.js";

/**
 * Method bootstrap re-inject (R-SP-BOOT, composes F319).
 *
 * A "method bootstrap" is the methodology instruction block the operator (or a
 * skill) seeds into the session: how to stay a problem-solver, the BUILD/ATTACH/
 * LEARN move, the never-stuck stance. It is free text carried as a `system`
 * message flagged by a stable marker prefix.
 *
 * Compaction folds older free text into a summary and, in doing so, can drop the
 * bootstrap marker — even though the methodology it carries is exactly what the
 * post-compact session still needs. `ensureBootstrapAfterCompact` re-attaches the
 * marker that was present before compaction if compaction dropped it, so the
 * methodology survives every compaction. Pure and allocation-only: no I/O, no
 * wall clock. It never invents a marker the session did not already carry.
 *
 * Mirrors the `[steering]` and `[compaction summary]` marker conventions already
 * used in agentSession.ts and the compaction engine.
 */

/** Stable marker a method-bootstrap system message starts with. */
export const METHOD_BOOTSTRAP_PREFIX = "[method bootstrap]";

/** True when `message` is the system role carrying the bootstrap marker. */
export function isMethodBootstrap(message: ChatTurnMessage): boolean {
  return message.role === "system" && message.content.startsWith(METHOD_BOOTSTRAP_PREFIX);
}

/**
 * Return the first method-bootstrap message in `history`, or `undefined` when
 * none is present. The marker is single — the first one wins, matching how the
 * session treats its single seeded methodology head.
 */
export function findMethodBootstrap(history: readonly ChatTurnMessage[]): ChatTurnMessage | undefined {
  return history.find(isMethodBootstrap);
}

/**
 * Re-attach the method-bootstrap marker after compaction if compaction dropped it.
 *
 * - If `before` carried a bootstrap marker and `after` no longer has one, return
 *   a new history with that marker re-attached at the head (above the compaction
 *   summary), so the methodology leads the rebuilt transcript.
 * - If `after` already carries the marker, return `after` unchanged (idempotent).
 * - If `before` never carried a marker, return `after` unchanged (never invent one).
 *
 * Neither input array is mutated.
 */
export function ensureBootstrapAfterCompact(
  before: readonly ChatTurnMessage[],
  after: readonly ChatTurnMessage[]
): readonly ChatTurnMessage[] {
  const marker = findMethodBootstrap(before);
  if (marker === undefined) {
    return after;
  }
  if (findMethodBootstrap(after) !== undefined) {
    return after;
  }
  // Re-attach the verbatim marker at the head; the rest of the rebuilt history
  // (compaction summary + kept turns) follows unchanged.
  return [marker, ...after];
}

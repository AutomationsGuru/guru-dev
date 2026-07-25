/**
 * Systematic debug phases — require ordered phase receipts (repro -> isolate ->
 * fix -> verify) before a "close bug" claim can be issued.
 *
 * This module is intentionally framework-free and stateless: it validates an
 * ordered chain of {@link DebugPhaseReceipt} entries. It does not own the loop
 * or the bug lifecycle; the caller records receipts as it performs each phase
 * and asks {@link canCloseBug} before asserting a bug is closed.
 *
 * The contract enforced here:
 *   - A bug may be closed only when all four phases appear, in order, each with
 *     non-empty evidence.
 *   - Receipts of an unknown phase never satisfy a canonical phase.
 *   - Re-running an earlier phase (e.g. a second Repro) is allowed and does not
 *     break the chain; the chain advances monotonically through the phase order
 *     but never backwards.
 */

/**
 * The four canonical, ordered phases of systematic debugging.
 *
 * Order is load-bearing: a later phase must not be recorded before its
 * predecessor (see {@link DEBUG_PHASE_ORDER}).
 */
export enum DebugPhase {
  /** Reproduce the failure deterministically. */
  Repro = "repro",
  /** Isolate the minimal cause of the reproduced failure. */
  Isolate = "isolate",
  /** Apply the fix that removes the isolated cause. */
  Fix = "fix",
  /** Verify the fix removes the failure and does not regress. */
  Verify = "verify"
}

/**
 * The canonical order of debug phases. Used to validate receipt chains.
 */
export const DEBUG_PHASE_ORDER: readonly DebugPhase[] = [
  DebugPhase.Repro,
  DebugPhase.Isolate,
  DebugPhase.Fix,
  DebugPhase.Verify
] as const;

const PHASE_RANK: Readonly<Record<DebugPhase, number>> = Object.freeze({
  [DebugPhase.Repro]: 0,
  [DebugPhase.Isolate]: 1,
  [DebugPhase.Fix]: 2,
  [DebugPhase.Verify]: 3
});

/**
 * A single phase receipt: the phase that was performed plus the evidence
 * captured for it. Evidence must be a non-empty string; a receipt without
 * evidence does not count toward closing the bug.
 */
export interface DebugPhaseReceipt {
  /** The debug phase this receipt documents. */
  phase: DebugPhase;
  /** Non-empty evidence for the phase (steps, command, output, citation, ...). */
  evidence: string;
}

function isDebugPhase(value: unknown): value is DebugPhase {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PHASE_RANK, value);
}

function isValidReceipt(value: unknown): value is DebugPhaseReceipt {
  if (typeof value !== "object" || value === null) return false;
  const r = value as { phase?: unknown; evidence?: unknown };
  return isDebugPhase(r.phase) && typeof r.evidence === "string" && r.evidence.trim().length > 0;
}

/**
 * The ordered list of canonical phases still required to close the bug, given
 * the receipts recorded so far.
 *
 * The chain advances monotonically: a phase is considered satisfied only when a
 * valid receipt for it appears after (or at the same point as) the previously
 * satisfied phase, in {@link DEBUG_PHASE_ORDER}. A receipt for a later phase
 * cannot be consumed before an earlier phase is satisfied; it is simply ignored
 * until the chain reaches it.
 *
 * Returns the full {@link DEBUG_PHASE_ORDER} when no progress has been made.
 */
export function missingPhasesForClose(receipts: readonly unknown[]): DebugPhase[] {
  let nextIndex = 0;
  for (const raw of receipts) {
    if (!isValidReceipt(raw)) continue;
    const candidate = raw as DebugPhaseReceipt;
    // Allow re-running the current phase (idempotent advance) and any phase that
    // matches the next required one. Skip phases that are out of order or
    // already satisfied without letting them jump the chain.
    const candidateRank = PHASE_RANK[candidate.phase];
    const requiredPhase = DEBUG_PHASE_ORDER[nextIndex];
    if (requiredPhase === undefined) break; // chain complete
    if (candidate.phase === requiredPhase) {
      nextIndex += 1;
    } else if (candidateRank < PHASE_RANK[requiredPhase]) {
      // Re-run of an already-satisfied earlier phase: allowed, no advance.
      continue;
    }
    // candidateRank > required rank: out of order; ignore (cannot jump chain).
  }
  return DEBUG_PHASE_ORDER.slice(nextIndex) as DebugPhase[];
}

/**
 * Returns true only when every canonical debug phase has a valid, ordered
 * receipt — i.e. {@link missingPhasesForClose} is empty. Use this as the gate
 * before asserting a bug is closed.
 */
export function canCloseBug(receipts: readonly unknown[]): boolean {
  return missingPhasesForClose(receipts).length === 0;
}

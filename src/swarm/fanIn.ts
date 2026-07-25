/**
 * Manager-owned fan-in (IDEA-B2, R-CW-FANIN, 2026-07-18) — when one combined
 * answer is required, dispatch ≠ done. The parent task is not complete until the
 * manager aggregates every worker receipt, verifies the bundle, and synthesizes
 * a single artifact.
 *
 * The flow is three explicit stages:
 *   aggregate → collect every receipt into an ordered bundle + outcome counts
 *   verify    → a "done" worker that left no artifact is flagged (dispatch is
 *               not done); any failure poisons the bundle
 *   synthesize→ the MANAGER (never a worker) folds the verified bundle into one
 *               synthesis artifact the parent cites
 *
 * Hard-limit / trust wiring (§3, R-CW-TRUST): the synthesizer is INJECTED, so the
 * manager owns the combination step and workers stay least-privilege — a worker
 * produces a receipt, it never writes the parent's answer. When
 * `fanInRequired` is true and no synthesizer is bound, fanIn REFUSES to mark the
 * parent complete (a structured {@link FanInBlockedError}), instead of silently
 * treating a bare dispatch as the answer.
 */

export const FAN_IN_SYNTHESIS_REF_PREFIX = "synthesis://";

/**
 * Default trust posture (IDEA-B2 step 5, R-CW-TRUST) — workers run LEAST
 * PRIVILEGE. A worker produces a receipt; it never writes the parent's combined
 * answer, never touches another worker's lease, and never escalates its own
 * privilege. Escalation is a documented hook, deliberately NOT implemented here:
 * no SSH remote workers, no ambient host access (per the plan's exclusions).
 *
 * The named escalation hooks, for whoever wires the manager (S1-B) later:
 *   - synthesizer injection: the manager binds `synthesize`, keeping the combined
 *     answer in trusted hands (workers stay read-only producers).
 *   - resume retry budget: `retryBudget` bounds re-dispatch; exhaustion escalates
 *     to `needs_human` rather than looping.
 *   - ledger redaction: free-text fields are scrubbed at the disk boundary, so a
 *     worker's output can never smuggle a secret into durable fleet state.
 * Granting a worker MORE than its receipt (shell, network, a peer's artifacts, a
 * remote host) is an explicit, reviewable future decision — not a default.
 */
export const FLEET_TRUST_POSTURE = "workers-least-privilege" as const;

export interface WorkerReceipt {
  readonly workerId: string;
  readonly role: string;
  readonly status: "done" | "failed";
  /** References to what the worker produced (never the secret values). */
  readonly artifactRefs: readonly string[];
  /** Short value-free summary of the worker's result. */
  readonly summary?: string;
  readonly failureClass?: "transient" | "task" | "verifier" | "needs_human";
}

export interface FanInAggregate {
  readonly receipts: readonly WorkerReceipt[];
  readonly done: number;
  readonly failed: number;
}

export interface FanInVerify {
  readonly ok: boolean;
  /** Workers that reported done but left no artifact — dispatch is not done. */
  readonly missingArtifacts: readonly string[];
  /** Workers that failed. */
  readonly failedWorkers: readonly string[];
}

export interface FanInSynthesis {
  readonly text: string;
  /** The citeable artifact reference for the combined answer. */
  readonly artifactRef: string;
}

export interface FanInResult {
  readonly aggregate: FanInAggregate;
  readonly verify: FanInVerify;
  /** Present only when the manager synthesized (fan_in_required + synthesizer). */
  readonly synthesis?: FanInSynthesis;
  /**
   * True only when the parent may be treated as done: fan-in not required, OR a
   * synthesis was produced over a verified-clean bundle.
   */
  readonly parentComplete: boolean;
}

/** The manager's combination step. Injected so workers never own the answer. */
export type FanInSynthesizer = (bundle: FanInAggregate) => string;

export interface FanInOptions {
  readonly receipts: readonly WorkerReceipt[];
  /** When true, a synthesis artifact is mandatory before the parent completes. */
  readonly fanInRequired: boolean;
  /** The manager-owned synthesizer. Required when fanInRequired is true. */
  readonly synthesize?: FanInSynthesizer;
}

/** Thrown when a combined answer is required but no synthesizer is bound. */
export class FanInBlockedError extends Error {
  readonly code = "fan_in_blocked";
  constructor(message: string) {
    super(message);
    this.name = "FanInBlockedError";
  }
}

function aggregate(receipts: readonly WorkerReceipt[]): FanInAggregate {
  let done = 0;
  let failed = 0;
  for (const receipt of receipts) {
    if (receipt.status === "done") {
      done += 1;
    } else {
      failed += 1;
    }
  }
  return { receipts, done, failed };
}

function verify(bundle: FanInAggregate): FanInVerify {
  const missingArtifacts: string[] = [];
  const failedWorkers: string[] = [];
  for (const receipt of bundle.receipts) {
    if (receipt.status === "failed") {
      failedWorkers.push(receipt.workerId);
    } else if (receipt.artifactRefs.length === 0) {
      // A worker said "done" but produced nothing citeable — that is not done.
      missingArtifacts.push(receipt.workerId);
    }
  }
  return { ok: missingArtifacts.length === 0 && failedWorkers.length === 0, missingArtifacts, failedWorkers };
}

export function fanIn(options: FanInOptions): FanInResult {
  const { receipts, fanInRequired, synthesize } = options;
  const bundle = aggregate(receipts);
  const checked = verify(bundle);

  if (!fanInRequired) {
    // No combined answer needed: the parent completes on dispatch+receipt alone.
    return { aggregate: bundle, verify: checked, parentComplete: true };
  }

  // A combined answer IS required. The manager must own the synthesis step.
  if (!synthesize) {
    throw new FanInBlockedError(
      "fan_in_required=true but no manager synthesizer is bound — the parent task cannot complete on dispatch alone. Bind a synthesize(bundle) function so the manager owns the combined answer."
    );
  }

  // A poisoned bundle (a failure, or a done-with-no-artifact) is not synthesizable
  // into a trustworthy single answer — the parent stays incomplete.
  if (!checked.ok) {
    return { aggregate: bundle, verify: checked, parentComplete: false };
  }

  const text = synthesize(bundle);
  const synthesis: FanInSynthesis = {
    text,
    artifactRef: `${FAN_IN_SYNTHESIS_REF_PREFIX}${bundle.receipts.map((receipt) => receipt.workerId).join("+")}`
  };
  return { aggregate: bundle, verify: checked, synthesis, parentComplete: true };
}

import type { FleetFailureClass, FleetLedger, FleetWorkerRecord } from "./fleetLedger.js";

/**
 * Fleet resume (IDEA-B2, R-CW-LEDGER, 2026-07-18) — reconcile a run's leases
 * after a process restart, from the durable ledger.
 *
 * The decision is structural, never prompt-driven:
 *   - transient failure with retry budget left  → requeue (a new dispatch attempt)
 *   - transient failure with the budget spent   → escalate (needs_human)
 *   - task / verifier / needs_human failure     → escalate (no blind auto-retry)
 *   - spawned but never finished (lost lease)   → requeue (the worker died with the process)
 *   - done / already terminal                    → left alone
 *
 * Idempotent: re-running over an already-reconciled run appends nothing and
 * re-decides nothing, because each reconciliation writes its outcome back to the
 * ledger (a requeue flips the worker to `queued`, an escalation to `needs_human`).
 */

export type ResumeActionKind = "requeue" | "escalate" | "complete";

export interface ResumeAction {
  readonly workerId: string;
  readonly action: ResumeActionKind;
  /** The attempt number this worker is now on (requeue) or stopped at. */
  readonly attempt: number;
  readonly failureClass?: FleetFailureClass;
}

export interface ResumeResult {
  readonly runId: string;
  readonly requeued: readonly string[];
  readonly escalated: readonly string[];
  readonly actions: readonly ResumeAction[];
}

export interface ResumeOptions {
  readonly ledger: FleetLedger;
  readonly runId: string;
  /**
   * Max dispatch attempts a transient-failed worker may make (spawn = attempt 1).
   * HARD bound: once attempts would exceed this, the worker escalates instead of
   * looping forever. This is the retry-budget analog of the swarm's task cap.
   */
  readonly retryBudget: number;
}

const REQUEUE_CLASSES: ReadonlySet<FleetFailureClass> = new Set(["transient"]);

/** Decide what to do with one worker, without touching the ledger. Pure. */
function decide(worker: FleetWorkerRecord, retryBudget: number): ResumeAction {
  const base = { workerId: worker.workerId, attempt: worker.attempts };
  switch (worker.status) {
    case "done":
      return { ...base, action: "complete" };
    case "needs_human":
      // Already escalated in a prior resume — leave it (idempotency).
      return { ...base, action: "complete" };
    case "failed": {
      const failureClass = worker.failureClass ?? "task";
      if (REQUEUE_CLASSES.has(failureClass) && worker.attempts < retryBudget) {
        // attempt reports the NEW attempt the worker is being dispatched onto.
        return { ...base, action: "requeue", attempt: worker.attempts + 1, failureClass };
      }
      return { ...base, action: "escalate", failureClass };
    }
    case "queued":
      // Queued with no heartbeat on this attempt is a FRESH dispatch (a prior
      // requeue, or work the runner simply hasn't picked up yet) — not a lost
      // lease. Leave it alone so resume is idempotent.
      return { ...base, action: "complete" };
    case "running":
    default:
      // Running = heartbeats were seen but no terminal event followed: the
      // process that owned the lease died mid-flight. Requeue so the run can
      // make progress, within the same budget.
      if (worker.attempts < retryBudget) {
        return { ...base, action: "requeue", attempt: worker.attempts + 1 };
      }
      return { ...base, action: "escalate", failureClass: "transient" };
  }
}

/**
 * Reconcile one run. Writes each requeue/escalation back to the ledger so a
 * later process (or a second resume) sees the decision and does not repeat it.
 */
export function resumeFleetRun(options: ResumeOptions): ResumeResult {
  const { ledger, runId, retryBudget } = options;
  if (!Number.isInteger(retryBudget) || retryBudget < 1) {
    throw new Error(`resumeFleetRun: retryBudget must be a positive integer, got ${retryBudget}.`);
  }

  const requeued: string[] = [];
  const escalated: string[] = [];
  const actions: ResumeAction[] = [];

  for (const worker of ledger.workers(runId)) {
    const action = decide(worker, retryBudget);
    actions.push(action);
    if (action.action === "requeue") {
      // Re-dispatch: a new spawned event carries the bumped attempt and flips the
      // folded record back to `queued`. The run can now pick this worker up again.
      ledger.append({
        kind: "worker_spawned",
        runId,
        workerId: worker.workerId,
        role: worker.role,
        attempt: worker.attempts + 1
      });
      requeued.push(worker.workerId);
    } else if (action.action === "escalate") {
      // Terminal for the machine: a human must look. Recorded, never silent.
      ledger.append({
        kind: "worker_finished",
        runId,
        workerId: worker.workerId,
        status: "needs_human",
        failureClass: action.failureClass ?? worker.failureClass ?? "task",
        detail: `resume escalated ${worker.workerId} after ${worker.attempts} attempt(s)`
      });
      escalated.push(worker.workerId);
    }
    // "complete" appends nothing.
  }

  return { runId, requeued, escalated, actions };
}

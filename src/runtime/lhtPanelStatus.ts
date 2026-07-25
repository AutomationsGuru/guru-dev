/**
 * LHT panel status (IDEA-F172): operator-facing long-horizon task status for
 * TUI binding. Derives a compact { gates, failed, remaining } snapshot from
 * completion-gate results so a panel can render progress without owning gate
 * semantics.
 *
 * Input shape is intentionally minimal and structural: any record with a
 * `status` field works, so this stays decoupled from the completion-gate
 * producer (F160) and from review-gate types.
 */

/** Minimal structural view of one gate result consumed by the panel. */
export interface LhtGateResult {
  readonly name: string;
  /** "passed" closes a gate; "failed" blocks; anything else is still open. */
  readonly status: string;
}

/** Operator-facing long-horizon task status snapshot. */
export interface LhtPanelStatus {
  /** Total gates in the set. */
  readonly gates: number;
  /** Gates that failed and must be fixed before completion. */
  readonly failed: number;
  /** Gates not yet passed (failed plus still-open), i.e. work remaining. */
  readonly remaining: number;
}

export function fromGateResults(results: readonly LhtGateResult[]): LhtPanelStatus {
  const failed = results.filter((result) => result.status === "failed").length;
  const passed = results.filter((result) => result.status === "passed").length;

  return {
    gates: results.length,
    failed,
    remaining: results.length - passed
  };
}

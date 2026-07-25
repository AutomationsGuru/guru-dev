/**
 * Swarm max-loops budget (IDEA-F598-MAXLOOP-01 / R-SW-AUTOLOOP) — resolves a
 * caller's loop intent (`fixed` | `auto`) into a concrete loop ceiling that a
 * swarm driver can enforce. The budget cap is a HARD ceiling in both modes:
 * fixed values clamp down to it, and auto (run-until-done) can never exceed
 * it. Invalid caps fail closed with a structured error — a missing or broken
 * budget must never silently become an unbounded loop (§3 hard limits:
 * unbounded fan-out risk is bounded structurally, not by prose).
 */

/** Structured failure when a loop budget cannot be resolved safely. */
export class SwarmMaxLoopsBudgetError extends Error {
  readonly code = "swarm_max_loops_budget_invalid";
  constructor(message: string) {
    super(message);
    this.name = "SwarmMaxLoopsBudgetError";
  }
}

/** How the swarm driver should treat the loop ceiling. */
export type SwarmMaxLoopsMode = "fixed" | "auto";

/**
 * Resolve the effective maxLoops for a swarm run.
 *
 * - `fixed`: use the caller's value, clamped into [1, budgetCap].
 * - `auto`: the run continues until its done-flag fires, but never past
 *   `budgetCap` — the cap IS the auto budget.
 *
 * @param mode      "fixed" | "auto".
 * @param fixed     The requested loop count (fixed mode only; ignored in auto).
 * @param budgetCap Hard ceiling on loops, a positive finite integer.
 * @returns A positive integer loop count, always ≤ budgetCap.
 * @throws SwarmMaxLoopsBudgetError on an invalid cap or non-finite fixed value.
 */
export function resolveMaxLoops(
  mode: SwarmMaxLoopsMode,
  fixed: number | undefined,
  budgetCap: number
): number {
  if (!Number.isInteger(budgetCap) || budgetCap < 1) {
    throw new SwarmMaxLoopsBudgetError(
      `budgetCap must be a positive integer, got ${String(budgetCap)} — a swarm loop without a valid budget cap is refused, not run unbounded.`
    );
  }

  if (mode === "auto") {
    // Auto never exceeds the cap: the cap is the whole auto budget.
    return budgetCap;
  }

  const requested = fixed ?? 1;
  if (!Number.isFinite(requested)) {
    throw new SwarmMaxLoopsBudgetError(
      `fixed maxLoops must be finite, got ${String(requested)} — refusing to clamp nonsense into a loop count.`
    );
  }

  // Clamp into [1, budgetCap]: zero/negative is never a silent no-op, and an
  // over-budget request is trimmed to the cap rather than unleashed.
  return Math.min(Math.max(Math.trunc(requested), 1), budgetCap);
}

import { evaluateToolMandate, verbsForCall, type MandateContext, type MandateDecision } from "./evaluate.js";
import { HARD_EDGE_VERBS, type MandateVerb } from "./schema.js";

/**
 * Sticky plan|act session mode (idea F64 / R-CL-PLAN-ACT, 2026-07-18).
 *
 * `plan` mode denies mutate / side-effect tools (write / exec / net / spend-class
 * verbs) so the operator can explore and reason without touching anything; `act`
 * restores the prior mandate density by deferring ENTIRELY to
 * {@link evaluateToolMandate}. HARD-EDGE behavior (destructive / spend /
 * secret-edge / auth-edge) is never weakened: those calls still ESCALATE in every
 * mode — plan mode never silently denies a hard edge, it surfaces it. Plan mode
 * sits in FRONT of the constitution pipeline (read-only floor → deny-wins →
 * hard-edge escalation → YOLO → grant → escalate) as an additional gate; it never
 * replaces or reorders it.
 *
 * Session state is a module-level singleton (sticky per-process session mode)
 * with `setMode` / `getMode`, defaulting to `act` so sessions that never toggle
 * behave exactly as before.
 */

/** The session posture: `plan` = deny side effects; `act` = full mandate pipeline. */
export type PlanActMode = "plan" | "act";

/** Verbs that mutate state or cause side effects — denied outright in plan mode. */
const PLAN_MODE_SIDE_EFFECT_VERBS: ReadonlySet<MandateVerb> = new Set(["write", "exec", "net", "spend"]);

let currentMode: PlanActMode = "act";

/** Set the sticky session mode. */
export function setMode(mode: PlanActMode): void {
  currentMode = mode;
}

/** Read the sticky session mode (defaults to `act`). */
export function getMode(): PlanActMode {
  return currentMode;
}

/**
 * Evaluate a tool call through the plan/act gate. In `act` mode this is a pure
 * pass-through to {@link evaluateToolMandate}. In `plan` mode, a call whose
 * verbs include ANY hard edge still escalates (hard edges are never weakened or
 * silently denied — Article 3), a call with any mutate/side-effect verb is
 * DENIED with a clear plan-mode reason, and read-only / empty-verb calls fall
 * through to the ordinary pipeline (allow).
 */
export function evaluatePlanActGate(toolId: string, input: unknown, ctx: MandateContext): MandateDecision {
  if (currentMode === "act") {
    return evaluateToolMandate(toolId, input, ctx);
  }

  const verbs = verbsForCall(toolId, input);

  // Hard edges SURFACE in every mode — a plan-mode deny would hide a
  // destructive / spend / secret-edge / auth-edge call from the operator.
  if (verbs.some((verb) => HARD_EDGE_VERBS.has(verb))) {
    return evaluateToolMandate(toolId, input, ctx);
  }

  const sideEffect = verbs.find((verb) => PLAN_MODE_SIDE_EFFECT_VERBS.has(verb));
  if (sideEffect) {
    return {
      outcome: "deny",
      reason: `plan mode: ${sideEffect} (mutate/side-effect) is denied — switch to act mode to execute`,
      verbs
    };
  }

  return evaluateToolMandate(toolId, input, ctx);
}

/**
 * A decision receipt carrying the session mode under which it was produced, so
 * downstream audit trails can show whether a call ran under `plan` or `act`.
 * Self-contained: `MandateDecision` lives in `evaluate.ts`, so the receipt is a
 * stamped copy rather than a schema change there.
 */
export interface PlanActReceipt extends MandateDecision {
  /** The plan/act mode in effect when the decision was produced. */
  readonly mode: PlanActMode;
}

/**
 * Stamp an existing mandate decision with the session mode. Defaults to the
 * current sticky mode; pass `mode` explicitly when stamping a decision produced
 * under a different posture.
 */
export function receiptForDecision(decision: MandateDecision, mode: PlanActMode = currentMode): PlanActReceipt {
  return { mode, ...decision };
}

import { HARD_EDGE_VERBS, type MandateVerb } from "./schema.js";
import { evaluateToolMandate, type MandateContext, type MandateDecision } from "./evaluate.js";

/**
 * The session-local work posture. `plan` is a restrictive tool floor; `act`
 * delegates to the existing mandate policy unchanged.
 */
export enum PlanActMode {
  Plan = "plan",
  Act = "act"
}

export const PLAN_ACT_PLAN_DENY_REASON = "plan mode denies mutating or side-effect tools until act mode is selected";

export interface PlanActMandateContext extends MandateContext {
  /** The session work posture, evaluated after hard limits and explicit denies. */
  readonly mode: PlanActMode;
}

/**
 * A mandate decision annotated with the session posture that produced it. Call
 * sites can persist this receipt with their normal tool observation/audit data.
 */
export interface PlanActMandateReceipt extends MandateDecision {
  readonly mode: PlanActMode;
}

export interface PlanActModeSession {
  getMode(): PlanActMode;
  setMode(mode: PlanActMode): PlanActMode;
  evaluateToolMandate(toolId: string, input: unknown, ctx: MandateContext): PlanActMandateReceipt;
}

function assertPlanActMode(mode: PlanActMode): void {
  if (mode !== PlanActMode.Plan && mode !== PlanActMode.Act) {
    throw new Error(`Invalid plan|act mode: ${String(mode)}`);
  }
}

function receipt(mode: PlanActMode, decision: MandateDecision): PlanActMandateReceipt {
  return { ...decision, mode };
}

function hasHardEdge(verbs: readonly MandateVerb[]): boolean {
  return verbs.some((verb) => HARD_EDGE_VERBS.has(verb));
}

/**
 * Apply the plan|act posture to a normal mandate evaluation.
 *
 * Explicit deny rules and hard edges remain first: plan mode never weakens a
 * denial, and hard edges retain their existing per-call escalation rather than
 * being silently converted into ordinary plan-mode denials. Once those floors
 * have been evaluated, plan mode denies every non-read-only call before YOLO or
 * standing grants can permit it. Act mode is a transparent pass-through to the
 * existing mandate policy, preserving its current YOLO/grant density.
 */
export function evaluatePlanActToolMandate(
  toolId: string,
  input: unknown,
  ctx: PlanActMandateContext
): PlanActMandateReceipt {
  assertPlanActMode(ctx.mode);

  const decision = evaluateToolMandate(toolId, input, ctx);

  if (decision.outcome === "deny") {
    return receipt(ctx.mode, decision);
  }

  if (ctx.mode === PlanActMode.Plan && decision.verbs.length > 0) {
    const hardEdge = decision.verbs.find((verb) => HARD_EDGE_VERBS.has(verb));
    return {
      mode: ctx.mode,
      outcome: "deny",
      reason: hardEdge ? `${PLAN_ACT_PLAN_DENY_REASON}; hard edge (${hardEdge}) remains blocked` : PLAN_ACT_PLAN_DENY_REASON,
      verbs: decision.verbs
    };
  }

  return receipt(ctx.mode, decision);
}

/**
 * Creates a sticky mode holder for one session. The default is `act` so adding
 * this optional policy helper cannot silently reduce an existing session's
 * ordinary mandate density; callers must explicitly select `plan`.
 */
export function createPlanActMode(initialMode: PlanActMode = PlanActMode.Act): PlanActModeSession {
  assertPlanActMode(initialMode);
  let mode = initialMode;

  return {
    getMode() {
      return mode;
    },
    setMode(nextMode) {
      assertPlanActMode(nextMode);
      mode = nextMode;
      return mode;
    },
    evaluateToolMandate(toolId, input, ctx) {
      return evaluatePlanActToolMandate(toolId, input, { ...ctx, mode });
    }
  };
}

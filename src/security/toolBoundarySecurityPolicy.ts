import { evaluateToolMandate, type MandateContext, type MandateDecision } from "../mandates/evaluate.js";
import { HARD_EDGE_VERBS, type MandateState } from "../mandates/schema.js";

/**
 * Tool Boundary Security Policy (F218 / R-DA-BOUNDARY).
 *
 * The policy this module documents AND enforces: **safety lives at the
 * tool/sandbox layer, never in the model.** A connected model proposes tool
 * calls; it never authorizes them. Every tool call — whatever the model
 * claims about it — passes through {@link evaluateTool}, which resolves the
 * call against the mandate engine's deny rules, hard limits, grants, and the
 * surface policy below, in that order. There is no input a model can supply
 * that lifts a hard limit, because the evaluation reads only the call's
 * effect classification (verbs), never the model's self-assessment.
 *
 * Composition: this module composes the existing mandate engine
 * (F80 grants/denies, the five hard limits, YOLO semantics) rather than
 * reimplementing it. It adds the two things the raw engine leaves to each
 * surface: (1) a single named entry point every tool-dispatch boundary can
 * share, and (2) an explicit fail-closed policy for surfaces with no
 * interactive operator, so a hard-limit escalation can never silently become
 * an allow where no human exists to confirm it.
 */

/**
 * Canonical statement of the boundary rule. Kept as data (not only doc
 * comments) so surfaces, boot reports, and audits can cite the exact policy
 * text the code enforces.
 */
export const TOOL_BOUNDARY_POLICY_STATEMENT =
  "Safety is enforced at the tool/sandbox layer, never delegated to the model. " +
  "Every tool call is evaluated by the harness: deny rules and the five hard limits " +
  "(no destruction without preservation, no unapproved spend, no leaked secrets, " +
  "no moral/out-of-scope crossing, no ungoverned self-improvement) resolve before " +
  "YOLO and are liftable by no mode, grant, or model claim. Ordinary permission " +
  "gates follow the surface policy; where no operator can be asked, escalation " +
  "fails closed.";

/**
 * The operating posture of the surface the call arrived on:
 * - `interactive` — an operator is present; ordinary ungranted calls escalate
 *   to the interactive approval flow (hard limits still deny outright — see
 *   below; the composer-level confirmation UX is a separate surface concern).
 * - `yolo` — YOLO by default: ordinary permission gates are lifted. Hard
 *   limits are NOT lifted; they deny fail-closed because YOLO must never
 *   auto-approve them (Vision §3: hard edges resolve before YOLO).
 * - `headless` — SDK/RPC/CI surface with no operator to ask. Any call the
 *   mandate cannot allow outright fails closed: hard limits deny, and an
 *   ordinary ungranted mutation denies rather than escalating into a void.
 */
export type ToolBoundaryPolicyKind = "interactive" | "yolo" | "headless";

export interface ToolBoundaryPolicy {
  readonly kind: ToolBoundaryPolicyKind;
}

export interface ToolBoundaryContext {
  /** Working directory used for SPACE-scope and target-path resolution. */
  readonly cwd: string;
  /** The standing mandate state (grants + deny rules). */
  readonly mandate: MandateState;
  /** The surface policy this call is evaluated under. */
  readonly policy: ToolBoundaryPolicy;
}

export interface ToolBoundaryDecision extends MandateDecision {
  /** The tool the decision applies to (echoed for audit logging). */
  readonly toolId: string;
  /** The policy kind that produced the decision. */
  readonly policy: ToolBoundaryPolicyKind;
}

/**
 * Evaluates a proposed tool call at the tool boundary. This is THE security
 * choke point: the model's request enters, a boundary decision exits, and the
 * sandbox executes only on `allow`.
 *
 * Order (mandate engine, then boundary policy):
 * read-only floor → deny-wins → hard limits → YOLO → covering grant → policy
 * fallthrough. Hard-limit verbs (`destructive`, `spend`, `secret-edge`,
 * `auth-edge`) always resolve to `deny` here: the raw engine escalates them
 * for an interactive double-check, but no boundary policy may auto-approve a
 * hard limit — not YOLO, not a grant, not a session flag — so the boundary
 * fails closed and an operator who wants the operation must perform it
 * outside the tool-call path.
 */
export function evaluateTool(toolId: string, input: unknown, ctx: ToolBoundaryContext): ToolBoundaryDecision {
  const mandateCtx: MandateContext = {
    cwd: ctx.cwd,
    state: ctx.mandate,
    yolo: ctx.policy.kind === "yolo"
  };
  const decision = evaluateToolMandate(toolId, input, mandateCtx);

  if (decision.outcome !== "escalate") {
    return { ...decision, toolId, policy: ctx.policy.kind };
  }

  const hardEdge = decision.verbs.find((verb) => HARD_EDGE_VERBS.has(verb));
  if (hardEdge) {
    const yoloNote = ctx.policy.kind === "yolo" ? " — YOLO never lifts a hard limit" : "";
    return {
      outcome: "deny",
      reason:
        `hard limit (${hardEdge}) cannot be auto-approved at the tool boundary${yoloNote}; ` +
        "the operator must perform or explicitly authorize this operation outside the tool-call path",
      verbs: decision.verbs,
      toolId,
      policy: ctx.policy.kind
    };
  }

  if (ctx.policy.kind === "headless") {
    return {
      outcome: "deny",
      reason: `headless boundary fails closed: no mandate covers ${decision.verbs.join("+")} and no operator can be asked`,
      verbs: decision.verbs,
      toolId,
      policy: ctx.policy.kind
    };
  }

  // interactive / ordinary yolo fallthrough: escalate to the operator's
  // approval flow exactly as the mandate engine decided.
  return { ...decision, toolId, policy: ctx.policy.kind };
}

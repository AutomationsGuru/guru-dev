/**
 * HITL tool call decision (IDEA-F221-HITL-DECISION-01) — the human-in-the-loop
 * verdict on a pending tool call: approve it as-is, edit it (the operator may
 * rewrite the call's args before it runs), or reject it. Composes with the
 * per-call approval gate (mandates/approval.ts): mandate evaluation and hard
 * edges resolve FIRST (deny-wins, hard edges always escalate); this module is
 * the pure decision-apply step for the calls that DO reach the operator.
 *
 * Pure by design: `applyDecision` never mutates the pending call and never
 * touches a terminal, so the approve/edit/reject logic is unit-tested without
 * a TTY. Default-REJECT on any unknown decision — fail-safe (Constitution §3).
 */

/** A tool call awaiting the operator's decision. */
export interface PendingToolCall {
  readonly toolId: string;
  readonly args: Record<string, unknown>;
}

/**
 * The operator's decision on a pending tool call:
 * - `approve` — run the call with its original args.
 * - `edit` — run the call with REWRITTEN args (`args` replaces the originals).
 * - `reject` — do not run the call; an optional reason explains why.
 */
export type HitlDecision =
  | { readonly type: "approve" }
  | { readonly type: "edit"; readonly args: Record<string, unknown> }
  | { readonly type: "reject"; readonly reason?: string | undefined };

/** The outcome of applying a decision: the call runs (possibly edited) or it does not. */
export type HitlDecisionResult =
  | { readonly kind: "approved"; readonly call: PendingToolCall }
  | { readonly kind: "rejected"; readonly reason?: string | undefined };

/**
 * Apply the operator's decision to a pending tool call. Pure — the input call
 * is never mutated; `edit` produces a NEW call carrying the rewritten args.
 * An unrecognized decision type default-REJECTS rather than ever falling
 * through to a blanket approve.
 */
export function applyDecision(call: PendingToolCall, decision: HitlDecision): HitlDecisionResult {
  switch (decision.type) {
    case "approve":
      return { kind: "approved", call };
    case "edit":
      return { kind: "approved", call: { ...call, args: decision.args } };
    case "reject":
      return { kind: "rejected", reason: decision.reason };
    default:
      return { kind: "rejected" };
  }
}

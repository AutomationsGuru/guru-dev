import { HARD_EDGE_VERBS, type MandateVerb } from "./schema.js";
import type { MandateDecision } from "./evaluate.js";

/**
 * Per-call approval (Per-Call Approval wave, ADR 2026-07-05-per-call-approval,
 * THERE v2 §12 + §2.3 + §17.6). Turns a mandate `escalate` into an interactive
 * yes/no/always decision — retiring the binary `/allow-writes` gate. Pure +
 * injectable prompt, so the y/N/always logic is unit-tested without a terminal.
 * A HARD EDGE always prompts (never auto-approved, and "always" never persists
 * for it); the default answer is DENY.
 */

export type ApprovalChoice = "once" | "always" | "deny";

export interface ApprovalRequest {
  readonly toolId: string;
  readonly verbs: readonly MandateVerb[];
  readonly reason: string;
  /** A destructive / spend / secrets-adjacent / ecosystem-auth op — always prompts. */
  readonly hardEdge: boolean;
  /** "always this session" is offered only for non-hard-edge escalations. */
  readonly allowAlways: boolean;
}

export interface ApprovalContext {
  /** Verbs the operator approved "always" this session (mutated on an "always" choice). */
  readonly sessionApprovals: Set<MandateVerb>;
  /** The interactive prompt — injected (TTY in the REPL, a stub in tests). */
  readonly prompt: (request: ApprovalRequest) => Promise<ApprovalChoice>;
}

/**
 * Resolve a mandate decision into allow/deny, prompting per-call on `escalate`.
 * `allow → true`, `deny → false`. On `escalate`: a hard edge always prompts;
 * a non-hard-edge whose verbs are already session-approved passes silently;
 * otherwise the operator is asked (once / always / deny). "always" grants the
 * verbs for the rest of the session (never for a hard edge).
 */
export async function resolveApproval(toolId: string, decision: MandateDecision, ctx: ApprovalContext): Promise<boolean> {
  if (decision.outcome === "allow") {
    return true;
  }
  if (decision.outcome === "deny") {
    return false;
  }
  const hardEdge = decision.verbs.some((verb) => HARD_EDGE_VERBS.has(verb));
  if (!hardEdge && decision.verbs.length > 0 && decision.verbs.every((verb) => ctx.sessionApprovals.has(verb))) {
    return true; // already approved "always" this session
  }
  const choice = await ctx.prompt({
    toolId,
    verbs: decision.verbs,
    reason: decision.reason,
    hardEdge,
    allowAlways: !hardEdge
  });
  if (choice === "deny") {
    return false;
  }
  if (choice === "always" && !hardEdge) {
    for (const verb of decision.verbs) {
      ctx.sessionApprovals.add(verb);
    }
  }
  // Default-DENY: only an EXPLICIT approval passes. "once" and "always" both approve
  // this call (a hard-edge "always" approves once but did NOT persist above); anything
  // unexpected — empty string, undefined, "n"/"no" — falls through to false rather than
  // the old blanket `return true`. Fail-safe (Constitution §3).
  return choice === "once" || choice === "always";
}

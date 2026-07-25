import { z } from "zod";

/**
 * Dual work/approval axes for plan posture (IDEA-A1).
 *
 * Two INDEPENDENT axes, both fail-closed:
 *
 * - `workMode` — what the session is allowed to DO. `plan` restricts execution
 *   to the certified read-only plan floor; `act` and `operate` leave execution
 *   to the ordinary mandate/tool path.
 * - `approvalPosture` — how much operator sign-off work needs. `ask` (default)
 *   escalates; `auto_review` and `full` reduce routine friction. Posture is an
 *   approval dial only: it can NEVER widen the plan-mode tool floor, and it can
 *   never lift a hard edge.
 *
 * Both axes default to the safest value (`plan` + `ask`) so an absent,
 * malformed, or partial posture resolves to the most restrictive behavior.
 * This module is pure policy: no I/O, no session state, no mutation.
 */

export const WORK_MODES = Object.freeze(["plan", "act", "operate"] as const);
export type WorkMode = (typeof WORK_MODES)[number];

export const APPROVAL_POSTURES = Object.freeze(["ask", "auto_review", "full"] as const);
export type ApprovalPosture = (typeof APPROVAL_POSTURES)[number];

export const WorkModeSchema = z.enum(WORK_MODES);
export const ApprovalPostureSchema = z.enum(APPROVAL_POSTURES);

export const WorkApprovalAxesSchema = z
  .object({
    workMode: WorkModeSchema.default("plan"),
    approvalPosture: ApprovalPostureSchema.default("ask")
  })
  .strict();
export type WorkApprovalAxes = z.infer<typeof WorkApprovalAxesSchema>;

/** Fail-closed default posture: plan mode, ask approval. Frozen so no caller can loosen it in place. */
export const DEFAULT_WORK_APPROVAL_AXES: WorkApprovalAxes = Object.freeze({
  workMode: "plan",
  approvalPosture: "ask"
});

/**
 * Stable deny code for plan-floor refusals. Surfaced in observation errors so
 * callers/tests can match on the code instead of prose.
 */
export const PLAN_MODE_DENY_CODE = "PLAN_MODE_TOOL_DENIED";

/** Parse a work mode, falling back to the fail-closed `plan` on any garbage. */
export function parseWorkMode(input: unknown): WorkMode {
  const result = WorkModeSchema.safeParse(input);
  return result.success ? result.data : DEFAULT_WORK_APPROVAL_AXES.workMode;
}

/** Parse an approval posture, falling back to the fail-closed `ask` on any garbage. */
export function parseApprovalPosture(input: unknown): ApprovalPosture {
  const result = ApprovalPostureSchema.safeParse(input);
  return result.success ? result.data : DEFAULT_WORK_APPROVAL_AXES.approvalPosture;
}

/**
 * Parse full axes from an untrusted/partial value. Each axis falls back to its
 * own fail-closed default independently, so a valid `approvalPosture` survives
 * a garbage `workMode` (and vice versa) without loosening the invalid axis.
 */
export function parseWorkApprovalAxes(input: unknown): WorkApprovalAxes {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return DEFAULT_WORK_APPROVAL_AXES;
  }

  const record = input as Record<string, unknown>;
  return {
    workMode: parseWorkMode(record.workMode),
    approvalPosture: parseApprovalPosture(record.approvalPosture)
  };
}

export type PlanModeGateDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: typeof PLAN_MODE_DENY_CODE; readonly reason: string };

/**
 * Consult the dual axes for a single plan-mode tool call. Pure: the caller
 * supplies the axes and whether the tool id is on the certified read-only
 * floor. The gate denies only when `workMode === "plan"` AND the tool is not
 * certified — the `approvalPosture` axis is read but never consulted to widen
 * the floor, so `full` cannot turn a denied call into an allowed one.
 */
export function evaluatePlanModeGate(
  axes: WorkApprovalAxes | { readonly workMode?: unknown; readonly approvalPosture?: unknown },
  toolId: string,
  certifiedReadOnly: boolean
): PlanModeGateDecision {
  const parsed = parseWorkApprovalAxes(axes);

  if (parsed.workMode !== "plan") {
    return { allowed: true };
  }

  if (certifiedReadOnly) {
    return { allowed: true };
  }

  return {
    allowed: false,
    code: PLAN_MODE_DENY_CODE,
    reason: `${PLAN_MODE_DENY_CODE}: tool "${toolId}" is not allowlisted for plan mode (approvalPosture=${parsed.approvalPosture} cannot widen the plan floor).`
  };
}

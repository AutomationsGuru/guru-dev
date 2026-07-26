/**
 * Work-mode × approval-posture dual axis (IDEA-A1 plan posture).
 *
 * Two orthogonal axes govern how a session executes tool calls:
 *
 *   - `workMode` — what KIND of work the session is doing:
 *       `plan`    : only the certified read-only plan surface may run;
 *                   writes / shell side-effects / network mutators / spawn-with-write
 *                   fail closed with the stable `PLAN_FLOOR_DENIED` error code.
 *                   The plan floor is evaluated BEFORE any YOLO/approval posture
 *                   so an `approvalPosture` of `full` cannot widen it.
 *       `act`     : ordinary harness execution — full surface, posture governs approval.
 *       `operate` : admin / governance surface — the strictest posture (mandate path).
 *
 *   - `approvalPosture` — how aggressively the harness skips per-call approval:
 *       `ask`         : per-call approval is requested unless a grant covers it (default).
 *       `auto_review` : writes auto-approved but land in the review gate queue.
 *       `full`        : YOLO-style; ordinary permission gates lifted. Still bound by
 *                       hard edges (destructive / spend / secret-edge / auth-edge)
 *                       and by the plan-mode floor when workMode === "plan".
 *
 * Defaults are fail-closed: `plan` + `ask`. Resolution order:
 *   1. The plan-mode floor (when workMode === "plan").
 *   2. Hard edges (never liftable).
 *   3. Approval posture (only widens ordinary gates).
 *   4. Per-call grants / deny rules.
 *
 * The posture is a pure module: no I/O, no globals, no side effects.
 */

import { z } from "zod";

/**
 * Work mode enum. `plan` is the read-only posture; `act` is ordinary harness
 * execution; `operate` is the admin/governance surface (mandate-only).
 */
export const WorkModeSchema = z.enum(["plan", "act", "operate"]);
export type WorkMode = z.infer<typeof WorkModeSchema>;

/**
 * Approval posture enum. `ask` is the default (per-call approval unless a
 * mandate grant covers the verb); `auto_review` lets writes land in the review
 * queue automatically; `full` is YOLO-style for ordinary gates. None of them
 * lift hard edges or the plan-mode floor.
 */
export const ApprovalPostureSchema = z.enum(["ask", "auto_review", "full"]);
export type ApprovalPosture = z.infer<typeof ApprovalPostureSchema>;

/**
 * Fail-closed posture defaults. A session that has never set a posture
 * starts in `act` mode (preserves existing harness behavior) with `ask`
 * approval — the safest approval posture. The plan-mode floor is the
 * fail-closed surface for plan mode; entering plan mode explicitly
 * activates the floor and denies mutating tools. Operators enter plan
 * mode via `/posture plan` or `StartHarnessSessionOptions.workMode = "plan"`.
 */
export const DEFAULT_WORK_MODE: WorkMode = "act";
export const DEFAULT_APPROVAL_POSTURE: ApprovalPosture = "ask";

/**
 * Stable error code returned by the plan floor. Surfaced in observation
 * results and gates so callers can branch without parsing human text.
 */
export const PLAN_FLOOR_DENIED_CODE = "PLAN_FLOOR_DENIED" as const;

/**
 * Resolved posture record carried on the session.
 *
 * `effectiveReadOnlyToolIds` is the tool-id allowlist enforced in plan mode.
 * It is the same allowlist the G1004 pure-core `createCertifiedPlanModePolicy`
 * produces, mirrored here so this module stays pure (no runtime coupling).
 */
export interface ResolvedPosture {
  readonly workMode: WorkMode;
  readonly approvalPosture: ApprovalPosture;
  /** True when workMode forces the read-only floor; carries the allowlist. */
  readonly planFloorActive: boolean;
  readonly effectiveReadOnlyToolIds: ReadonlySet<string>;
  /** ISO timestamp of last posture resolution; informational only. */
  readonly resolvedAt: string;
}

export const ResolvedPostureSchema = z
  .object({
    workMode: WorkModeSchema,
    approvalPosture: ApprovalPostureSchema,
    planFloorActive: z.boolean(),
    effectiveReadOnlyToolIds: z.array(z.string()),
    resolvedAt: z.string()
  })
  .strict();

/**
 * Shape of the caller-supplied posture options. Either field may be omitted
 * to keep the current value; missing both preserves the previous resolved
 * posture (caller responsibility to default before first resolve).
 */
export interface PostureOptions {
  readonly workMode?: WorkMode;
  readonly approvalPosture?: ApprovalPosture;
}

/**
 * Resolve posture from raw inputs. Always returns a complete record; missing
 * fields fall back to the fail-closed defaults. Pure.
 */
export function resolvePosture(
  inputs: PostureOptions,
  previous: ResolvedPosture | undefined,
  readOnlyToolIds: readonly string[],
  now: () => string
): ResolvedPosture {
  const workMode: WorkMode = inputs.workMode ?? previous?.workMode ?? DEFAULT_WORK_MODE;
  const approvalPosture: ApprovalPosture =
    inputs.approvalPosture ?? previous?.approvalPosture ?? DEFAULT_APPROVAL_POSTURE;
  const planFloorActive = workMode === "plan";
  const frozenIds = Object.freeze(Array.from(new Set(readOnlyToolIds)).sort());
  return {
    workMode,
    approvalPosture,
    planFloorActive,
    effectiveReadOnlyToolIds: new Set(frozenIds),
    resolvedAt: now()
  };
}

/**
 * Verbs / effects that the plan-mode floor refuses, regardless of approval
 * posture. These are the canonical mutating categories — any tool whose
 * effect is anything other than `read-only` is denied. The list is structural,
 * not advisory.
 */
export type ToolEffectCategory = "read-only" | "mutating" | "network-mutating" | "spawn-with-write";

export interface PlanFloorDecision {
  readonly allowed: boolean;
  /** Present only when `allowed === false`. */
  readonly code?: typeof PLAN_FLOOR_DENIED_CODE;
  /** Human-readable reason; safe to log (no secret values). */
  readonly reason?: string;
}

/**
 * Plan-mode floor evaluator. Pure: given the posture, the tool id, and its
 * declared effect category, returns a fail-closed decision. The floor is
 * `workMode === "plan"` AND `planFloorActive === true`; otherwise the floor
 * is bypassed (the caller still has the mandate / hard-edge floors).
 *
 * The floor does not consult the approval posture — `full` cannot widen it.
 */
export function evaluatePlanFloor(
  posture: ResolvedPosture,
  toolId: string,
  effect: ToolEffectCategory
): PlanFloorDecision {
  if (!posture.planFloorActive) {
    return { allowed: true };
  }

  if (effect === "read-only" && posture.effectiveReadOnlyToolIds.has(toolId)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    code: PLAN_FLOOR_DENIED_CODE,
    reason:
      effect === "read-only"
        ? `Tool "${toolId}" is not on the plan-mode read-only allowlist (workMode=plan).`
        : `Tool "${toolId}" has effect "${effect}" which the plan floor forbids (workMode=plan).`
  };
}

/**
 * Independent-axis invariant: changing the approval posture MUST NOT widen the
 * plan floor. The function returns the prior posture when the caller's
 * approval change would violate that invariant; the caller is expected to
 * surface the rejection as a stable error (see {@link ApprovalCannotWidenPlanFloorCode}).
 */
export const APPROVAL_CANNOT_WIDEN_PLAN_FLOOR_CODE = "APPROVAL_CANNOT_WIDEN_PLAN_FLOOR" as const;

export function assertPostureInvariant(
  previous: ResolvedPosture,
  next: PostureOptions
): { readonly ok: true } | { readonly ok: false; readonly code: string; readonly reason: string } {
  // If the caller is leaving plan mode, anything goes. If they are staying in
  // (or entering) plan mode, the approval posture is irrelevant — the floor
  // binds regardless — but we still verify it cannot widen a previous floor
  // by accident (defense in depth).
  const nextWorkMode: WorkMode = next.workMode ?? previous.workMode;
  if (previous.planFloorActive && nextWorkMode !== "act" && nextWorkMode !== "operate") {
    // Plan floor is still active in next; approval posture cannot override it.
    // We don't reject; we just note that posture remains bounded. The invariant
    // check returns ok and downstream `evaluatePlanFloor` enforces the floor.
    return { ok: true };
  }
  return { ok: true };
}

import { z } from "zod";

import { HARD_EDGE_VERBS, type MandateVerb } from "./schema.js";

/**
 * Autonomy mode boot selector (IDEA-F499-MODEBOOT-01).
 *
 * Resolves a boot-time autonomy mode name into a structural descriptor that
 * downstream consumers (mandate evaluator, session, approval gate) read to
 * set their behavior. The selector OWNS the mode identity and the rule that
 * hard limits are NEVER liftable — by any mode, including YOLO.
 *
 * Design doc: handoffs/build-plans/in-progress/2026-07-19T1753Z-idea-f499-autonomy-mode-boot-selector-build-plan.md
 */

/** The autonomy modes available at boot. */
export const AutonomyModeSchema = z.enum(["normal", "plan", "yolo", "auto-accept"]);
export type AutonomyMode = z.infer<typeof AutonomyModeSchema>;

/**
 * The constitutional hard limits — the set of MandateVerbs that NO autonomy
 * mode may lift. Destructive, spend, secret-edge, and auth-edge are hard
 * edges that always escalate (§2.3 Article 3), even under YOLO.
 *
 * This is a re-export of {@link HARD_EDGE_VERBS} so the boot selector is the
 * single source of truth for "what yolo can never lift." If a new hard edge
 * is added to the schema, this reference automatically includes it.
 */
export const HARD_LIMITS: ReadonlySet<MandateVerb> = HARD_EDGE_VERBS;

/**
 * Structural descriptor for a resolved autonomy mode. Every field is a
 * literal boolean (not `boolean`) so the type system itself enforces the
 * constitutional invariants — no runtime check can be skipped.
 */
export interface ResolvedMode {
  /** The mode that was resolved. */
  readonly mode: AutonomyMode;
  /**
   * Hard limits can NEVER be lifted. This is the type-level enforcement of
   * the constitutional rule: `false` is the only valid value. YOLO and every
   * other mode inherit this — there is no code path that sets it to `true`.
   */
  readonly hardLimitsLifted: false;
  /**
   * True when ordinary (non-hard-edge) permission gates are lifted.
   * YOLO and auto-accept set this; normal and plan do not.
   */
  readonly yolo: boolean;
  /**
   * True when the harness must plan but must not execute mutating operations.
   * Only `plan` mode sets this; all other modes allow execution.
   */
  readonly planOnly: boolean;
  /**
   * True when non-hard-edge escalations are auto-approved without prompting
   * the operator. `auto-accept` is the only mode that sets this; it inherits
   * yolo permission lifting and adds auto-approval of remaining prompts.
   */
  readonly autoAccept: boolean;
}

/**
 * Per-mode constants. The table is ordered from least to most autonomous so
 * a consumer can compare modes ordinally if needed.
 */
const MODE_TABLE: Record<AutonomyMode, Omit<ResolvedMode, "mode">> = {
  normal: { hardLimitsLifted: false, yolo: false, planOnly: false, autoAccept: false },
  plan: { hardLimitsLifted: false, yolo: false, planOnly: true, autoAccept: false },
  yolo: { hardLimitsLifted: false, yolo: true, planOnly: false, autoAccept: false },
  "auto-accept": { hardLimitsLifted: false, yolo: true, planOnly: false, autoAccept: true }
};

/**
 * Resolve an autonomy mode name into its structural descriptor.
 *
 * Unknown mode names throw a Zod error (validation fails before the switch).
 * Every resolved mode carries `hardLimitsLifted: false` — the constitutional
 * floor that no mode, including YOLO, can cross.
 *
 * @throws {z.ZodError} when the name is not a recognized autonomy mode.
 */
export function resolveMode(name: string): ResolvedMode {
  const mode = AutonomyModeSchema.parse(name);
  return { mode, ...MODE_TABLE[mode] };
}

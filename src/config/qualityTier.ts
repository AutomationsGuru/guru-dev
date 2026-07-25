import { z } from "zod";

/**
 * Project quality tier (IDEA-E5, R-OC-SHARE / R-AS-LAND).
 *
 * One named, operator-chosen tier per project that structurally gates how much
 * self-build automation the harness may run unattended. This is an enforcement
 * module, not prose: downstream self-build paths resolve the tier policy and
 * clamp requested automation to the tier ceiling.
 *
 * Constitutional floors (VISION §3, §4 constitution-breach): NO tier may ever
 *   - lift the review gate (`reviewGateRequired` is true at every tier),
 *   - permit a local merge or force push (both stay false at every tier),
 *   - drop the requirement that git delivery is operator-approved.
 * Tiers only ever bound the *degree* of unattended local iteration; the hard
 * limits above resolve before any tier is applied.
 */

export const QUALITY_TIERS = ["local-only", "pr", "gated-selfbuild"] as const;

export const QualityTierSchema = z.enum(QUALITY_TIERS);
export type QualityTier = z.infer<typeof QualityTierSchema>;

export interface QualityTierPolicy {
  readonly tier: QualityTier;
  /** Structural gates the tier imposes on self-build automation. */
  readonly selfBuild: {
    /** Hard ceiling on unattended self-build iterations; requests are clamped to this. */
    readonly maxIterationsCeiling: number;
    /** May the loop auto commit/push/PR within its configured approval policy? */
    readonly autoCommitPushPr: boolean;
    /** Hard floor: false at every tier. */
    readonly allowLocalMerge: false;
    /** Hard floor: false at every tier. */
    readonly allowForcePush: false;
    /** Hard floor: true at every tier — delivery always requires operator approval. */
    readonly requiresOperatorApproval: true;
    /** Hard floor: true at every tier — no tier weakens the review gate. */
    readonly reviewGateRequired: true;
  };
  /** Clamp a requested iteration count to this tier's ceiling (never below 0). */
  clampMaxIterations(requested: number): number;
}

function makePolicy(tier: QualityTier, maxIterationsCeiling: number, autoCommitPushPr: boolean): QualityTierPolicy {
  return {
    tier,
    selfBuild: {
      maxIterationsCeiling,
      autoCommitPushPr,
      allowLocalMerge: false,
      allowForcePush: false,
      requiresOperatorApproval: true,
      reviewGateRequired: true
    },
    clampMaxIterations(requested: number): number {
      if (!Number.isFinite(requested)) {
        return 0;
      }
      return Math.min(Math.max(0, Math.floor(requested)), maxIterationsCeiling);
    }
  };
}

const POLICIES: Readonly<Record<QualityTier, QualityTierPolicy>> = {
  // local-only: no unattended self-build automation at all. The operator runs
  // everything; the loop's iteration ceiling is zero.
  "local-only": makePolicy("local-only", 0, false),
  // pr: bounded local iteration is fine, but git delivery stays fully manual.
  pr: makePolicy("pr", 3, false),
  // gated-selfbuild: the configured approval policy may run (auto commit/push/PR)
  // — still behind the review gate, the approval ledger, and operator approval.
  "gated-selfbuild": makePolicy("gated-selfbuild", 10, true)
};

/**
 * Resolve the enforcement policy for a tier. Pure and total: every tier returns
 * a policy whose hard floors (review required, no local merge, no force push,
 * operator-approved delivery) can never be lifted by configuration.
 */
export function resolveQualityTierPolicy(tier: QualityTier): QualityTierPolicy {
  return POLICIES[tier];
}

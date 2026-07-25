import type { ProvenanceAnnotatedManifest, SkillTrustTier } from "./skillProvenance.js";

/**
 * Skill trust gate (IDEA-F14-SKILL-PROV-01, R-AS-SKILL-GATE residual).
 *
 * The single choke point that decides whether a provenance-annotated skill may
 * be handed to the model for invocation. The rule is structural, not prompt
 * prose:
 *
 * - builtin / home / project → allowed (operator- or harness-owned roots).
 * - external → blocked UNLESS the operator has approved the skill's current
 *   content hash (provenance.approved). Unknown provenance never widens
 *   trust — the gate fails closed.
 *
 * This module only *evaluates*; it never mutates approval state. Approval is
 * recorded through `recordSkillApproval` in skillProvenance.ts.
 */

export interface SkillTrustGateDecision {
  /** True when the model may invoke this skill. */
  readonly allowed: boolean;
  /** The tier the decision was based on (echoed for reporting/badges). */
  readonly tier: SkillTrustTier;
  /** Human-readable reason, always present (used in block banners and audit notes). */
  readonly reason: string;
}

/**
 * Evaluate one annotated manifest for model invocation. External skills carry
 * the fail-closed default: `provenance.approved === true` is the only way an
 * external skill becomes invocable, and that flag is only set when the recorded
 * approval hash matches the skill's current content hash.
 */
export function evaluateSkillTrustGate(skill: ProvenanceAnnotatedManifest): SkillTrustGateDecision {
  if (skill.provenance.tier !== "external") {
    return {
      allowed: true,
      tier: skill.provenance.tier,
      reason: `Skill '${skill.id}' is ${skill.provenance.tier}-trusted and may be model-invoked.`
    };
  }

  if (skill.provenance.approved) {
    return {
      allowed: true,
      tier: "external",
      reason: `External skill '${skill.id}' is operator-approved at its current content hash and may be model-invoked.`
    };
  }

  return {
    allowed: false,
    tier: "external",
    reason: `External skill '${skill.id}' is blocked from model invocation until the operator approves its content hash (${skill.provenance.contentHash}).`
  };
}

/**
 * Partition an annotated catalog into invocable and blocked skills, preserving
 * catalog order. Reporting convenience over `evaluateSkillTrustGate`.
 */
export function partitionSkillsByTrust(skills: readonly ProvenanceAnnotatedManifest[]): {
  readonly invocable: ProvenanceAnnotatedManifest[];
  readonly blocked: ProvenanceAnnotatedManifest[];
} {
  const invocable: ProvenanceAnnotatedManifest[] = [];
  const blocked: ProvenanceAnnotatedManifest[] = [];

  for (const skill of skills) {
    (evaluateSkillTrustGate(skill).allowed ? invocable : blocked).push(skill);
  }

  return { invocable, blocked };
}

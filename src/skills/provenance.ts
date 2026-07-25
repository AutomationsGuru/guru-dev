import { createHash } from "node:crypto";

import { z } from "zod";

import { detectPotentialSecrets } from "../safety/policyGuard.js";

/**
 * Skill install provenance gate (IDEA-E1, R-AS-SKILL-GATE + R-GK-SKILLIFY).
 *
 * A skill is a prompt-shaping artifact — installing one is loading instructions
 * the model will follow. Blind third-party skill install is therefore a
 * self-mutation / supply-chain edge, not a routine file copy: it must be
 * EXPLICITLY allowed, by a named source the operator has already vetted. This
 * module is the structural choke point. It never installs anything itself; it
 * decides whether an install may proceed and, when it may, emits a receipt.
 *
 * The gate (hard, in code — never prompt-only):
 *   1. ORIGIN — first-party sources (home / project / bundled) are trusted by
 *      construction. Everything else is third-party.
 *   2. THIRD-PARTY ⇒ EXPLICIT ALLOW REQUIRED — a third-party install with no
 *      matching allow entry is REFUSED. The allow entry names the source
 *      (exact id or a trailing-* glob) — there is no blanket "allow all".
 *   3. SECRET SCAN — every candidate SKILL.md body is scanned for potential
 *      secrets (presence-over-value). A hit refuses the install regardless of
 *      origin: a skill file is never a place for a credential.
 *   4. RECEIPT — an admitted install produces a content hash so the install is
 *      auditable and a later drift check can tell the file changed.
 */

export const SkillSourceOriginSchema = z.enum(["home", "project", "bundled", "third-party"]);
export type SkillSourceOrigin = z.infer<typeof SkillSourceOriginSchema>;

/** A named, operator-vetted third-party source allow entry (exact or trailing-* glob). */
export const SkillSourceAllowSchema = z
  .object({
    /** Exact source id, or a prefix ending in `*` (e.g. `github:myorg/*`). */
    sourcePattern: z.string().trim().min(1),
    /** Why this source is trusted (auditable reason, recorded on the receipt). */
    reason: z.string().trim().min(1).max(300)
  })
  .strict();
export type SkillSourceAllow = z.infer<typeof SkillSourceAllowSchema>;

export const SkillInstallCandidateSchema = z
  .object({
    /** The skill id being installed. */
    skillId: z.string().trim().min(1),
    /** Where it came from. */
    origin: SkillSourceOriginSchema,
    /**
     * Stable source identifier for third-party skills (e.g. `github:org/repo`,
     * `url:https://…`, `file:/path`). Required for third-party; matched against
     * the allow list. Presence-only — never a credential-bearing locator.
     */
    sourceId: z.string().trim().min(1).optional(),
    /** The SKILL.md body being installed (scanned for secrets before admit). */
    body: z.string().min(1)
  })
  .strict();
export type SkillInstallCandidate = z.infer<typeof SkillInstallCandidateSchema>;

export const SkillProvenanceDecisionSchema = z
  .object({
    admit: z.boolean(),
    /** Stable machine reason for the verdict. */
    reason: z.enum(["first-party", "allowed-third-party", "unallowed-third-party", "secret-detected"]),
    /** Human/operator-facing explanation (never carries a secret value). */
    summary: z.string().trim().min(1),
    /** Present only when admitted: the content hash receipt for audit/drift. */
    contentHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    /** Secret-match KINDS only (never values) when refused for a secret. */
    secretKinds: z.array(z.string()).default([])
  })
  .strict();
export type SkillProvenanceDecision = z.infer<typeof SkillProvenanceDecisionSchema>;

const FIRST_PARTY_ORIGINS: ReadonlySet<SkillSourceOrigin> = new Set(["home", "project", "bundled"]);

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Match a source id against an allow pattern (exact, or trailing-* prefix glob). */
export function sourceMatchesAllow(sourceId: string, pattern: string): boolean {
  if (pattern.endsWith("*")) {
    return sourceId.startsWith(pattern.slice(0, -1));
  }
  return sourceId === pattern;
}

/**
 * The gate. Pure and deterministic — the same candidate + allow list always
 * yields the same decision, so it is unit-testable and replayable in review.
 */
export function gateSkillInstall(
  rawCandidate: SkillInstallCandidate,
  allowList: readonly SkillSourceAllow[] = []
): SkillProvenanceDecision {
  const candidate = SkillInstallCandidateSchema.parse(rawCandidate);

  // Hard limit first (§3.3): a secret in a skill body refuses the install from
  // ANY origin — even first-party. Report KINDS, never values.
  const secretMatches = detectPotentialSecrets([{ name: "skill body", value: candidate.body }]);
  if (secretMatches.length > 0) {
    return SkillProvenanceDecisionSchema.parse({
      admit: false,
      reason: "secret-detected",
      summary: `Refused install of skill '${candidate.skillId}': potential secret (${secretMatches.map((m) => m.kind).join(", ")}) in the skill body — a skill file must never hold a credential.`,
      secretKinds: secretMatches.map((m) => m.kind)
    });
  }

  if (FIRST_PARTY_ORIGINS.has(candidate.origin)) {
    return SkillProvenanceDecisionSchema.parse({
      admit: true,
      reason: "first-party",
      summary: `Admitted first-party skill '${candidate.skillId}' (${candidate.origin}).`,
      contentHash: sha256(candidate.body),
      secretKinds: []
    });
  }

  // Third-party: a matching allow entry is REQUIRED (no blind install).
  const sourceId = candidate.sourceId;
  if (!sourceId) {
    return SkillProvenanceDecisionSchema.parse({
      admit: false,
      reason: "unallowed-third-party",
      summary: `Refused install of third-party skill '${candidate.skillId}': no sourceId given, so no allow entry can match — name a vetted source to install third-party skills.`,
      secretKinds: []
    });
  }
  const matchedAllow = allowList.find((allow) => sourceMatchesAllow(sourceId, allow.sourcePattern));
  if (!matchedAllow) {
    return SkillProvenanceDecisionSchema.parse({
      admit: false,
      reason: "unallowed-third-party",
      summary: `Refused install of third-party skill '${candidate.skillId}' from '${sourceId}': no operator allow entry covers this source. Add an explicit allow to install it.`,
      secretKinds: []
    });
  }
  return SkillProvenanceDecisionSchema.parse({
    admit: true,
    reason: "allowed-third-party",
    summary: `Admitted third-party skill '${candidate.skillId}' from '${sourceId}' (allowed: ${matchedAllow.reason}).`,
    contentHash: sha256(candidate.body),
    secretKinds: []
  });
}

/** Batch helper: gate every candidate, partitioning admitted from refused. */
export function gateSkillInstalls(
  candidates: readonly SkillInstallCandidate[],
  allowList: readonly SkillSourceAllow[] = []
): { readonly admitted: readonly { candidate: SkillInstallCandidate; decision: SkillProvenanceDecision }[]; readonly refused: readonly { candidate: SkillInstallCandidate; decision: SkillProvenanceDecision }[] } {
  const admitted: { candidate: SkillInstallCandidate; decision: SkillProvenanceDecision }[] = [];
  const refused: { candidate: SkillInstallCandidate; decision: SkillProvenanceDecision }[] = [];
  for (const candidate of candidates) {
    const decision = gateSkillInstall(candidate, allowList);
    (decision.admit ? admitted : refused).push({ candidate, decision });
  }
  return { admitted, refused };
}

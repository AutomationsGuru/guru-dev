import { createHash } from "node:crypto";

/**
 * System prompt learning guard (IDEA-F196-PROMPT-LEARN-01). The knowledge
 * flywheel may propose rewrites of system-prompt sections, but the hard-limit
 * section is constitutional (§3) and must never be weakened, stripped, or
 * reordered by a learned proposal. Every proposal path runs
 * `validateSystemPromptSectionProposal` and rejects unless the proposed text
 * still carries a byte-identical hard-limit section — enforced in code, never
 * in prose (prompt-rule drift, §4).
 */

export interface SystemPromptLearningProposal {
  readonly currentSection: string;
  readonly proposedSection: string;
  readonly hardLimitSection: string;
}

export type SystemPromptLearningVerdict =
  | {
      readonly status: "accepted";
      readonly hardLimitChecksum: string;
    }
  | {
      readonly status: "rejected";
      readonly hardLimitChecksum: string;
      readonly blockers: readonly string[];
    };

/** Canonical fingerprint of the protected hard-limit text (whitespace-normalized). */
export function hardLimitSectionChecksum(hardLimitSection: string): string {
  return createHash("sha256").update(normalizeSection(hardLimitSection)).digest("hex");
}

/**
 * Reject a proposed system-prompt section rewrite unless the protected
 * hard-limit section survives intact (whitespace/line-ending tolerant). A
 * proposal that removes, edits, or reorders the hard limits is rejected with
 * explicit blockers.
 */
export function validateSystemPromptSectionProposal(
  proposal: SystemPromptLearningProposal
): SystemPromptLearningVerdict {
  const checksum = hardLimitSectionChecksum(proposal.hardLimitSection);
  const blockers: string[] = [];
  const expected = normalizeSection(proposal.hardLimitSection);
  const current = normalizeSection(proposal.currentSection);
  const proposed = normalizeSection(proposal.proposedSection);

  if (!current.includes(expected)) {
    blockers.push("current system prompt section does not contain the expected hard-limit section — refusing to evaluate the proposal against an unknown baseline");
  }
  if (!proposed.includes(expected)) {
    blockers.push("proposed rewrite strips or alters the hard-limit section — learned prompt changes must preserve the five hard limits byte-for-byte");
  }

  if (blockers.length > 0) {
    return { status: "rejected", hardLimitChecksum: checksum, blockers };
  }
  return { status: "accepted", hardLimitChecksum: checksum };
}

/** Normalize CRLF/CR line endings and trim trailing whitespace per line so formatting noise cannot game the checksum. */
function normalizeSection(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

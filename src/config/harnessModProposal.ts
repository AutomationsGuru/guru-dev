import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

/**
 * IDEA-F187 — Harness mod PROPOSAL only.
 *
 * A mod description is captured as an immutable review artifact and emitted for
 * human review. It is NEVER applied to runtime config automatically. This is the
 * structural enforcement of Vision hard limit #5 ("no ungoverned self-improvement")
 * for the mods-residual case identified in the letta-code ideation review
 * (R-LT-MODS: "No auto harness self-mod; optional proposal artifact only").
 *
 * The loop may *propose* a change to itself through this seam; it may not *make*
 * one. The governed path (validation + review + approval + done packet) is the
 * only route to an applied mutation, and that path is owned outside this module.
 */

/** A proposed mod is a description for review — never an applied change. */
export const ModTargetSchema = z
  .enum(["core", "extension", "tool", "skill", "config", "memory", "other"])
  .default("core");
export type ModTarget = z.infer<typeof ModTargetSchema>;

/**
 * The operator-supplied description of a desired harness modification.
 *
 * Deliberately strict and deliberately WITHOUT any `autoApply` / `approved` /
 * `force` field: a mod input can never assert its own governance bypass at the
 * schema layer. Unknown keys are rejected, so a stray `autoApply: true` is a
 * parse failure rather than a silent escalation.
 */
export const HarnessModInputSchema = z
  .object({
    /** One-line summary of the desired change. */
    summary: z.string().trim().min(1).max(200),
    /** Why the change is wanted — the operator's intent, captured verbatim. */
    rationale: z.string().trim().min(1).max(2_000),
    /** What the change would concretely do (e.g. "register a status-line extension"). */
    proposedChange: z.string().trim().min(1).max(4_000),
    /** Which surface the mod targets. Defaults to "core". */
    target: ModTargetSchema,
    /** Optional risk notes for the reviewer; never auto-promoted to approval. */
    riskNotes: z.string().trim().max(2_000).optional()
  })
  .strict();

/**
 * Caller-facing input (what an operator writes). `target` is optional here
 * because the schema supplies a "core" default at parse time. The parsed
 * output (`HarnessModParsedInput` below) always carries a concrete target.
 */
export type HarnessModInput = z.input<typeof HarnessModInputSchema>;
export type HarnessModParsedInput = z.output<typeof HarnessModInputSchema>;

/** A proposal is always pending review until a human moves it through governance. */
export const PROPOSAL_STATUS = {
  PENDING_REVIEW: "pending_review"
} as const;
export type ProposalStatus = (typeof PROPOSAL_STATUS)[keyof typeof PROPOSAL_STATUS];

/**
 * An immutable harness-mod proposal artifact.
 *
 * `applied` is permanently `false` on this object — there is no method here that
 * flips it. The only path to an applied mutation is the governed review/approval
 * flow that lives outside this module, which produces its own artifacts.
 */
export interface HarnessModProposal {
  /** Stable, unique id for this review item. */
  readonly id: string;
  readonly status: ProposalStatus;
  /** Always false here. A proposal is never an applied mutation. */
  readonly applied: boolean;
  /** Epoch milliseconds — set by the proposer, not the reviewer. */
  readonly createdAtMs: number;
  readonly summary: string;
  readonly rationale: string;
  readonly proposedChange: string;
  readonly target: ModTarget;
  readonly riskNotes?: string;
  /** Render the proposal as a human-readable review artifact. */
  render(): string;
}

/** Build the id from a wall-clock seed plus 8 hex chars of entropy. */
function buildProposalId(createdAtMs: number): string {
  const entropy = randomBytes(4).toString("hex");
  return `harness-mod-${createdAtMs}-${entropy}`;
}

export interface ProposeHarnessModOptions {
  /**
   * Injected wall-clock for deterministic tests. Production callers omit this so
   * the proposer stamps the proposal with the real time.
   */
  readonly now?: () => number;
  /** Injected entropy source for deterministic tests. */
  readonly random?: () => string;
}

/**
 * Capture a mod description as a pending-review proposal.
 *
 * This function ONLY describes — it does not touch runtime config, files, or any
 * applied state. The returned object is frozen and carries no mutator that could
 * turn it into an applied change.
 */
export function proposeHarnessMod(
  input: HarnessModInput,
  options: ProposeHarnessModOptions = {}
): HarnessModProposal {
  const parsed = HarnessModInputSchema.parse(input);
  const createdAtMs = options.now?.() ?? Date.now();
  const id = options.random ? `harness-mod-${createdAtMs}-${options.random()}` : buildProposalId(createdAtMs);

  const proposal: HarnessModProposal = {
    id,
    status: PROPOSAL_STATUS.PENDING_REVIEW,
    applied: false,
    createdAtMs,
    summary: parsed.summary,
    rationale: parsed.rationale,
    proposedChange: parsed.proposedChange,
    target: parsed.target,
    ...(parsed.riskNotes !== undefined ? { riskNotes: parsed.riskNotes } : {}),
    render(): string {
      return renderProposal(this);
    }
  };

  return Object.freeze(proposal);
}

/**
 * The governance gate.
 *
 * A proposal is structurally never applied by this module. Calling this is a
 * programming error — it always throws. The function exists so the codebase can
 * make "you cannot apply a proposal" an enforced code path (and a tested one),
 * not a prose rule a future caller could quietly bypass.
 *
 * Applying a mod requires the governed path (validation + review + approval +
 * done packet), which is owned outside this module and produces its own records.
 */
export function applyHarnessModProposal(_proposal: HarnessModProposal): never {
  throw new Error(
    "A harness mod proposal cannot be auto-applied (status=pending_review). " +
      "Applying a mod requires the governed path: validation + review + approval + done packet. " +
      "Vision hard limit #5: no ungoverned self-improvement."
  );
}

function renderProposal(proposal: HarnessModProposal): string {
  const lines = [
    "# Harness Mod Proposal",
    "",
    `id: ${proposal.id}`,
    `status: ${proposal.status}`,
    `applied: ${proposal.applied}`,
    `target: ${proposal.target}`,
    `created_at_ms: ${proposal.createdAtMs}`,
    "",
    `## Summary`,
    proposal.summary,
    "",
    `## Rationale`,
    proposal.rationale,
    "",
    `## Proposed change`,
    proposal.proposedChange
  ];

  if (proposal.riskNotes !== undefined) {
    lines.push("", `## Risk notes`, proposal.riskNotes);
  }

  lines.push(
    "",
    "## Governance",
    "This proposal is pending review and has NOT been applied. " +
      "Applying requires validation + review + approval + a done packet (Vision hard limit #5)."
  );

  return lines.join("\n");
}

/**
 * Deterministic hash of a proposal's content (excludes id/createdAtMs so that
 * two identical proposals hash the same). Useful for dedup in a review queue
 * without deduping the ids themselves.
 */
export function hashProposalContent(input: HarnessModInput): string {
  const parsed: HarnessModParsedInput = HarnessModInputSchema.parse(input);
  const payload = JSON.stringify({
    summary: parsed.summary,
    rationale: parsed.rationale,
    proposedChange: parsed.proposedChange,
    target: parsed.target,
    riskNotes: parsed.riskNotes ?? null
  });
  return createHash("sha256").update(payload).digest("hex");
}

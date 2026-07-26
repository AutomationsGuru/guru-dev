/**
 * Plan artifact schema (IDEA-A1).
 *
 * A plan artifact is the operator-visible structured document a plan-mode
 * session produces. It is what the operator accepts, revises, or rejects
 * before the harness can leave plan mode and execute writes. The schema is
 * deliberately exhaustive: every section is a required array field so empty
 * sections remain visible in the rendered artifact ("no risks recorded yet")
 * rather than disappearing and leaving the operator wondering whether the
 * planner considered them.
 *
 * Sections (all required; empty arrays are valid and rendered):
 *   - objective        : free-text goal the plan is meant to achieve.
 *   - sources_context  : references (paths, urls, identifiers) the plan was
 *                        grounded in; required so the operator can audit
 *                        provenance.
 *   - critical_files   : paths the plan will read/inspect under plan mode.
 *   - constraints      : hard constraints that bind the plan (e.g. "no
 *                        external network", "do not touch secrets").
 *   - approach         : ordered steps the plan will execute when the
 *                        operator promotes it to act mode.
 *   - verification     : commands / assertions that prove the plan worked.
 *   - risks            : failure modes the operator should know about.
 *   - handoff_notes    : free-text notes for whoever picks this up next.
 *
 * Validation is purely structural: section shape, step ordering, path
 * hygiene. No I/O, no globals, no secret material in any field.
 */

import { z } from "zod";

/**
 * Path safety: rejects NUL bytes and `..` path-traversal segments. Mirrors
 * the rules in `planner/planMode.ts` so an artifact and a draft cannot
 * smuggle a different hygiene contract.
 */
const ArtifactPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"), {
    message: "Artifact paths must not contain NUL characters."
  })
  .refine((value) => !/(^|[\\/])\.\.([\\/]|$)/.test(value), {
    message: "Artifact paths must not contain path traversal segments."
  });

const NonEmptyLineSchema = z.string().trim().min(1).max(20_000);

const ApproachStepSchema = z
  .object({
    order: z.number().int().positive(),
    description: NonEmptyLineSchema
  })
  .strict()
  .superRefine((step, context) => {
    // Order is validated at the array level (sequential), so the per-step
    // shape is just non-empty positive integers.
    if (!Number.isFinite(step.order) || step.order < 1) {
      context.addIssue({
        code: "custom",
        path: ["order"],
        message: "Approach step order must be a positive integer."
      });
    }
  });

export const PlanArtifactSchema = z
  .object({
    /** Stable id (uuid v4 or operator-supplied); used for accept/revise tracking. */
    id: z.string().trim().min(1).max(128),
    /** ISO timestamp the artifact was produced. */
    createdAt: z.string().trim().min(1).max(64),
    /** Free-text goal the plan is meant to achieve. */
    objective: NonEmptyLineSchema,
    /** References the plan was grounded in (paths, urls, identifiers). */
    sources_context: z.array(NonEmptyLineSchema).default([]),
    /** Paths the plan will read/inspect under plan mode. */
    critical_files: z.array(ArtifactPathSchema).default([]),
    /** Hard constraints that bind the plan. */
    constraints: z.array(NonEmptyLineSchema).default([]),
    /** Ordered approach steps; sequence is enforced below. */
    approach: z.array(ApproachStepSchema).default([]),
    /** Verification commands / assertions that prove the plan worked. */
    verification: z.array(NonEmptyLineSchema).default([]),
    /** Failure modes the operator should know about. */
    risks: z.array(NonEmptyLineSchema).default([]),
    /** Free-text notes for whoever picks this up next. */
    handoff_notes: z.array(NonEmptyLineSchema).default([])
  })
  .strict()
  .superRefine((artifact, context) => {
    // Approach steps must be sequential from 1. Empty approach is allowed
    // (the planner may produce a draft before steps crystallize) but when
    // present the order must be exactly 1..N.
    artifact.approach.forEach((step, index) => {
      if (step.order !== index + 1) {
        context.addIssue({
          code: "custom",
          path: ["approach", index, "order"],
          message: "Approach step order must match its one-based position."
        });
      }
    });

    // Bound the serialized artifact so an unbounded session cannot produce a
    // megabyte plan that the operator must scroll.
    const serialized = JSON.stringify(artifact);
    if (serialized.length > 60_000) {
      context.addIssue({
        code: "custom",
        message: "Plan artifact exceeds the maximum serialized size of 60000 characters."
      });
    }
  });

export type PlanArtifact = z.infer<typeof PlanArtifactSchema>;

export type PlanArtifactResult =
  | { readonly ok: true; readonly artifact: PlanArtifact }
  | { readonly ok: false; readonly error: string };

/**
 * Parse + validate an arbitrary input as a PlanArtifact. Pure. Stable error
 * surface: one human-readable string joining the zod issue paths.
 */
export function parsePlanArtifact(input: unknown): PlanArtifactResult {
  const result = PlanArtifactSchema.safeParse(input);
  if (result.success) {
    return { ok: true, artifact: result.data };
  }
  return {
    ok: false,
    error: result.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "root"}: ${issue.message}`)
      .join("; ")
  };
}

/**
 * Stable error codes for the artifact API.
 */
export const PLAN_ARTIFACT_INVALID_CODE = "PLAN_ARTIFACT_INVALID" as const;
export const PLAN_ARTIFACT_EMPTY_OBJECTIVE_CODE = "PLAN_ARTIFACT_EMPTY_OBJECTIVE" as const;

/**
 * Operator-visible accept/revise verdict on a plan artifact. The runtime
 * gate (see `runtime/session.ts`) reads this verdict to decide whether the
 * session may leave plan mode.
 */
export const PlanArtifactVerdictSchema = z.enum(["accepted", "revise", "rejected"]);
export type PlanArtifactVerdict = z.infer<typeof PlanArtifactVerdictSchema>;

export const PlanArtifactDecisionSchema = z
  .object({
    artifactId: z.string().trim().min(1).max(128),
    verdict: PlanArtifactVerdictSchema,
    /** Optional operator note attached to the decision. */
    note: z.string().trim().max(4_000).optional(),
    /** ISO timestamp of the decision. */
    decidedAt: z.string().trim().min(1).max(64)
  })
  .strict();

export type PlanArtifactDecision = z.infer<typeof PlanArtifactDecisionSchema>;

/**
 * True when the verdict lifts the plan floor. `accepted` lifts it; `revise`
 * keeps the floor (the planner must produce a new artifact); `rejected`
 * keeps the floor (operator may switch workMode directly).
 */
export function verdictLiftsPlanFloor(verdict: PlanArtifactVerdict): boolean {
  return verdict === "accepted";
}

/**
 * Render a plan artifact to a stable, human-readable Markdown summary. Pure.
 * Empty sections render as a visible "_(none)_" placeholder so the operator
 * never confuses "the planner forgot" with "the planner recorded nothing".
 */
export function renderPlanArtifactMarkdown(artifact: PlanArtifact): string {
  const lines: string[] = [];
  lines.push(`# Plan ${artifact.id}`);
  lines.push("");
  lines.push(`_Created: ${artifact.createdAt}_`);
  lines.push("");
  lines.push("## Objective");
  lines.push(artifact.objective);
  lines.push("");
  lines.push("## Sources / context");
  lines.push(renderListOrPlaceholder(artifact.sources_context));
  lines.push("");
  lines.push("## Critical files");
  lines.push(renderListOrPlaceholder(artifact.critical_files.map((path) => `- \`${path}\``)));
  lines.push("");
  lines.push("## Constraints");
  lines.push(renderListOrPlaceholder(artifact.constraints));
  lines.push("");
  lines.push("## Approach");
  if (artifact.approach.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const step of artifact.approach) {
      lines.push(`${step.order}. ${step.description}`);
    }
  }
  lines.push("");
  lines.push("## Verification");
  lines.push(renderListOrPlaceholder(artifact.verification));
  lines.push("");
  lines.push("## Risks");
  lines.push(renderListOrPlaceholder(artifact.risks));
  lines.push("");
  lines.push("## Handoff notes");
  lines.push(renderListOrPlaceholder(artifact.handoff_notes));
  lines.push("");
  return lines.join("\n");
}

function renderListOrPlaceholder(items: readonly string[]): string {
  if (items.length === 0) {
    return "_(none)_";
  }
  return items.map((item) => (item.startsWith("- ") ? item : `- ${item}`)).join("\n");
}

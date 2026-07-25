import { z } from "zod";

/**
 * Goal criteria draft review (IDEA-F212-GOAL-DRAFT-01, composes F208 session goal).
 *
 * A model-facing proposal of success criteria for a session goal is only a draft
 * until the operator decides. The draft carries `proposedCriteria[]`; exactly one
 * decision path — `accept` — applies criteria. `edit` replaces the proposal and
 * keeps it pending, `revise` records operator feedback for another pass, and
 * `cancel` drops the proposal. Nothing is applied on any non-accept path, and
 * terminal drafts (accepted / cancelled) reject further decisions so criteria can
 * never be applied retroactively after a cancel.
 */

export const GoalCriterionSchema = z
  .object({
    id: z.string().trim().min(1),
    text: z.string().trim().min(1).max(2_000)
  })
  .strict();
export type GoalCriterion = z.infer<typeof GoalCriterionSchema>;

export const GoalCriteriaDraftStatusSchema = z.enum([
  "pending",
  "revision-requested",
  "accepted",
  "cancelled"
]);
export type GoalCriteriaDraftStatus = z.infer<typeof GoalCriteriaDraftStatusSchema>;

export interface GoalCriteriaDraft {
  readonly status: GoalCriteriaDraftStatus;
  readonly proposedCriteria: readonly GoalCriterion[];
  /** Criteria applied to the session goal. Non-null only after accept. */
  readonly appliedCriteria: readonly GoalCriterion[] | null;
  /** Operator feedback recorded by the most recent revise decision. */
  readonly revisionFeedback: string | null;
}

export type GoalCriteriaDraftResult =
  | { readonly ok: true; readonly draft: GoalCriteriaDraft }
  | { readonly ok: false; readonly error: string };

export type GoalCriteriaDecision =
  | { readonly kind: "accept" }
  | { readonly kind: "edit"; readonly criteria: readonly unknown[] }
  | { readonly kind: "revise"; readonly feedback: string }
  | { readonly kind: "cancel" };

const GoalCriteriaDraftStateSchema = z
  .array(GoalCriterionSchema)
  .min(1)
  .superRefine((criteria, context) => {
    const seen = new Set<string>();
    criteria.forEach((criterion, index) => {
      if (seen.has(criterion.id)) {
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message: `Duplicate criterion id: ${criterion.id}`
        });
      }
      seen.add(criterion.id);
    });
  });

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "root"}: ${issue.message}`)
    .join("; ");
}

function freezeCriteria(criteria: readonly GoalCriterion[]): readonly GoalCriterion[] {
  return Object.freeze(criteria.map((criterion) => Object.freeze({ ...criterion })));
}

function freezeDraft(draft: GoalCriteriaDraft): GoalCriteriaDraft {
  return Object.freeze(draft);
}

function parseCriteria(input: readonly unknown[]): GoalCriteriaDraftResult {
  const result = GoalCriteriaDraftStateSchema.safeParse(input);

  if (!result.success) {
    return { ok: false, error: formatIssues(result.error) };
  }

  return {
    ok: true,
    draft: freezeDraft({
      status: "pending",
      proposedCriteria: freezeCriteria(result.data),
      appliedCriteria: null,
      revisionFeedback: null
    })
  };
}

/** Create a pending draft from a proposed criteria list. Nothing is applied. */
export function proposeGoalCriteria(criteria: readonly unknown[]): GoalCriteriaDraftResult {
  return parseCriteria(criteria);
}

function isTerminal(status: GoalCriteriaDraftStatus): boolean {
  return status === "accepted" || status === "cancelled";
}

/**
 * Apply an operator decision to a draft. Only `accept` applies criteria;
 * `cancel` drops the proposal with nothing applied. Terminal drafts reject
 * every further decision.
 */
export function decideGoalCriteria(
  draft: GoalCriteriaDraft,
  decision: GoalCriteriaDecision
): GoalCriteriaDraftResult {
  if (isTerminal(draft.status)) {
    return {
      ok: false,
      error: `Goal criteria draft is terminal (${draft.status}); no further decisions are allowed.`
    };
  }

  switch (decision.kind) {
    case "accept": {
      const applied = freezeCriteria(draft.proposedCriteria);
      return {
        ok: true,
        draft: freezeDraft({
          status: "accepted",
          proposedCriteria: draft.proposedCriteria,
          appliedCriteria: applied,
          revisionFeedback: null
        })
      };
    }
    case "edit": {
      const parsed = parseCriteria(decision.criteria);
      if (!parsed.ok) {
        return parsed;
      }
      return parsed;
    }
    case "revise": {
      const feedback = decision.feedback.trim();
      if (feedback.length === 0) {
        return { ok: false, error: "revision feedback must not be blank" };
      }
      return {
        ok: true,
        draft: freezeDraft({
          status: "revision-requested",
          proposedCriteria: draft.proposedCriteria,
          appliedCriteria: null,
          revisionFeedback: feedback
        })
      };
    }
    case "cancel": {
      return {
        ok: true,
        draft: freezeDraft({
          status: "cancelled",
          proposedCriteria: draft.proposedCriteria,
          appliedCriteria: null,
          revisionFeedback: null
        })
      };
    }
  }
}

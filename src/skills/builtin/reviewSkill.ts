import { z } from "zod";

export const ReviewSkillInputSchema = z
  .object({
    target: z.string().trim().min(1).default("the pending working-tree changes"),
    focus: z.array(z.string().trim().min(1)).min(1).default(["correctness", "tests", "maintainability"])
  })
  .strict();

export type ReviewSkillInput = z.infer<typeof ReviewSkillInputSchema>;

export interface ReviewSkillPlan {
  readonly objective: string;
  readonly steps: readonly string[];
  readonly focus: readonly string[];
}

export function createReviewSkillPlan(input: ReviewSkillInput): {
  readonly prompt: string;
  readonly plan: ReviewSkillPlan;
} {
  const focus = input.focus.join(", ");
  const objective = `Review ${input.target} without modifying the repository.`;

  return {
    prompt: [
      objective,
      `Focus on ${focus}.`,
      "Inspect the relevant context and report only verified findings, ordered by severity.",
      "Do not commit, push, or make changes."
    ].join(" "),
    plan: {
      objective,
      focus: input.focus,
      steps: [
        "Inspect the target and its surrounding contracts.",
        `Evaluate the target for ${focus}.`,
        "Verify each candidate finding against the actual execution path.",
        "Return verified findings ordered by severity, or state that none survived verification."
      ]
    }
  };
}

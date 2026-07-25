import { z } from "zod";

export const LoopSkillInputSchema = z
  .object({
    task: z.string().trim().min(1),
    maxIterations: z.number().int().min(1).max(100).default(10),
    stopCondition: z.string().trim().min(1).default("The task is complete and its validation passes")
  })
  .strict();

export type LoopSkillInput = z.infer<typeof LoopSkillInputSchema>;

export interface LoopSkillPlan {
  readonly objective: string;
  readonly steps: readonly string[];
  readonly maxIterations: number;
  readonly stopCondition: string;
}

export function createLoopSkillPlan(input: LoopSkillInput): {
  readonly prompt: string;
  readonly plan: LoopSkillPlan;
} {
  const objective = `Iterate on: ${input.task}`;

  return {
    prompt: [
      objective,
      `Run at most ${input.maxIterations} iterations and stop when: ${input.stopCondition}.`,
      "Each iteration must inspect current evidence, make one bounded attempt, validate it, and stop on completion or a real blocker.",
      "This invocation is a plan only; do not begin the loop automatically."
    ].join(" "),
    plan: {
      objective,
      maxIterations: input.maxIterations,
      stopCondition: input.stopCondition,
      steps: [
        "Inspect the current state and select the smallest next attempt.",
        "Apply the bounded attempt only after the operator starts execution.",
        "Validate the result against the stop condition.",
        "Stop on success or a genuine blocker; otherwise begin the next iteration within the limit."
      ]
    }
  };
}

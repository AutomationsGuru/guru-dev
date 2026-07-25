import { z } from "zod";

export const BatchSkillInputSchema = z
  .object({
    tasks: z.array(z.string().trim().min(1)).min(1).max(100),
    maxConcurrency: z.number().int().min(1).max(16).default(4)
  })
  .strict();

export type BatchSkillInput = z.infer<typeof BatchSkillInputSchema>;

export interface BatchSkillPlan {
  readonly objective: string;
  readonly steps: readonly string[];
  readonly tasks: readonly string[];
  readonly maxConcurrency: number;
}

export function createBatchSkillPlan(input: BatchSkillInput): {
  readonly prompt: string;
  readonly plan: BatchSkillPlan;
} {
  const objective = `Plan a batch of ${input.tasks.length} task${input.tasks.length === 1 ? "" : "s"}.`;

  return {
    prompt: [
      objective,
      `Use at most ${input.maxConcurrency} concurrent workers for independent tasks.`,
      `Tasks: ${input.tasks.map((task, index) => `${index + 1}. ${task}`).join(" ")}`,
      "Identify dependencies before parallelizing, preserve each task's evidence, and integrate only validated results.",
      "This invocation is a plan only; do not start workers or change the repository automatically."
    ].join(" "),
    plan: {
      objective,
      tasks: input.tasks,
      maxConcurrency: input.maxConcurrency,
      steps: [
        "Classify task dependencies and owned surfaces.",
        `Schedule independent tasks with no more than ${input.maxConcurrency} running concurrently.`,
        "Collect and validate each task result before integration.",
        "Report completed, failed, and blocked tasks without hiding partial results."
      ]
    }
  };
}

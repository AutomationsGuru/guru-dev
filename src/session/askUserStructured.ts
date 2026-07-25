import { z } from "zod";

/** A validated, multiple-choice operator prompt ready for presentation. */
export const AskPromptSchema = z
  .object({
    question: z.string().trim().min(1).max(500),
    options: z.array(z.string().trim().min(1).max(200)).min(1).max(12)
  })
  .strict();

export type AskPrompt = z.infer<typeof AskPromptSchema>;

/** Reject malformed prompts before they can reach an operator-facing surface. */
export function validateAsk(prompt: unknown): AskPrompt {
  return AskPromptSchema.parse(prompt);
}

import { z } from "zod";

/**
 * Schema definitions for the ask_user_question tool (F93).
 * Structured multi-choice questions with 2–4 options plus Other.
 * Separate from ask_question to enforce stricter validation.
 */

// Options must be 2-4 items; each option text is 1-200 chars.
const OptionSchema = z.string().trim().min(1).max(200);

// Question requires exactly 2-4 options and may mark multi-select.
export const AskUserQuestionSchema = z
  .object({
    question: z.string().trim().min(1).max(500),
    options: z.array(OptionSchema).min(2).max(4),
    multiSelect: z.boolean().optional().default(false),
    allowOther: z.boolean().optional().default(true)
  })
  .strict();

export const AskUserInputSchema = z
  .object({
    questions: z.array(AskUserQuestionSchema).min(1).max(8)
  })
  .strict();

export const AskUserOutputSchema = z
  .object({
    answers: z.array(z.array(z.string())),
    summary: z.string(),
    pendingQuestionId: z.string().optional()
  })
  .strict();

export type AskUserQuestion = z.infer<typeof AskUserQuestionSchema>;
export type AskUserInput = z.infer<typeof AskUserInputSchema>;
export type AskUserOutput = z.infer<typeof AskUserOutputSchema>;

/**
 * Validate that answers match questions and options.
 * Returns error message or null if valid.
 */
export function validateAskUserAnswers(
  questions: readonly AskUserQuestion[],
  answers: string[][]
): string | null {
  if (!Array.isArray(answers)) {
    return "answers must be an array";
  }
  if (answers.length !== questions.length) {
    return `expected ${questions.length} answer(s), got ${answers.length}`;
  }
  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i]!;
    const a = answers[i];
    if (a === undefined) {
      return `answer at index ${i} is undefined`;
    }
    if (!Array.isArray(a)) {
      return `answer at index ${i} must be an array of strings`;
    }
    if (!q.multiSelect && a.length > 1) {
      return `question ${i + 1} is single-select but got ${a.length} selections`;
    }
    for (const item of a) {
      if (typeof item !== "string") {
        return `answer at index ${i} contains non-string value`;
      }
      // Allow "Other" or exact option match when allowOther is true
      const isValidOption = q.options.some((opt) => opt.toLowerCase() === item.toLowerCase());
      const isOther = q.allowOther && item.toLowerCase() === "other";
      if (!isValidOption && !isOther) {
        return `"${item}" is not a valid option or Other for question ${i + 1}`;
      }
    }
  }
  return null;
}
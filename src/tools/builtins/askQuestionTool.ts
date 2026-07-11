import { z } from "zod";
import type { ToolDefinition } from "../registry.js";
import { readAskQuestions } from "../../tui/askPrompt.js";

export const AskQuestionToolInputSchema = z
  .object({
    questions: z.array(
      z.object({
        question: z.string().trim().min(1).describe("The question to ask the user."),
        options: z.array(z.string().trim().min(1)).min(2).describe("The text for each option, formatted as the user's response."),
        is_multi_select: z.boolean().optional().describe("If true, the user can select multiple options.")
      })
    ).min(1).describe("The list of questions to ask.")
  })
  .strict();

export const AskQuestionToolOutputSchema = z.object({
  answers: z.array(z.array(z.string())).describe("The user's answers to the questions. For each question, an array of selected options is returned.")
});

export interface AskQuestionToolOptions {
  /** Callback to render the questions to the user and wait for their response. */
  readonly onAsk?: (questions: z.infer<typeof AskQuestionToolInputSchema>["questions"]) => Promise<string[][]>;
  /**
   * When true (default), a missing onAsk falls back to the TTY multi-choice prompt
   * so chat turns can use ask_question without a custom callback. Headless/RPC
   * still fails cleanly when stdin is not a TTY.
   */
  readonly allowDefaultTtyPrompt?: boolean;
}

export function createAskQuestionTool(options: AskQuestionToolOptions = {}): ToolDefinition<typeof AskQuestionToolInputSchema, typeof AskQuestionToolOutputSchema> {
  const allowDefault = options.allowDefaultTtyPrompt !== false;
  return {
    id: "ask_question",
    title: "Ask Question",
    description: "Ask the user one or more multiple-choice questions to clarify requirements, solicit design feedback, or resolve ambiguity.",
    inputSchema: AskQuestionToolInputSchema,
    outputSchema: AskQuestionToolOutputSchema,
    async execute(input) {
      if (options.onAsk) {
        const answers = await options.onAsk(input.questions);
        return { answers };
      }
      // Daily-driver path: the tool is offered to the model in chat turns, so a
      // missing callback used to throw on every call ("not supported"). On a TTY,
      // fall through to the shared multi-choice prompt; non-TTY still fails.
      if (allowDefault && process.stdin.isTTY === true && process.stdout.isTTY === true) {
        // exactOptionalPropertyTypes: only include is_multi_select when defined.
        const answers = await readAskQuestions(
          input.questions.map((q) => ({
            question: q.question,
            options: q.options,
            ...(q.is_multi_select !== undefined ? { is_multi_select: q.is_multi_select } : {})
          }))
        );
        return { answers };
      }
      throw new Error("ask_question tool is not supported in this runtime environment (no interactive prompt callback provided).");
    }
  };
}

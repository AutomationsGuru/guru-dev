import { z } from "zod";
import type { ToolDefinition } from "../registry.js";
import {
  AskUserQuestionParamsSchema,
  type AskUserQuestionParams,
  type Answer
} from "../askUser/schema.js";

/**
 * Internal state for pending question resolution.
 * The tool returns requiresInput, and the TUI/RPC layer calls resolveAnswers
 * when the user provides their responses.
 */
let pendingResolve: ((answers: Answer[]) => void) | null = null;
let pendingReject: ((error: Error) => void) | null = null;

/**
 * ask_user_question tool implementation.
 *
 * Presents 1-4 structured questions to the user, each with 2-4 options.
 * The tool suspends execution and returns a requiresInput signal with
 * pendingQuestions payload. The TUI/RPC layer collects answers and calls
 * resolveAnswers() to continue execution.
 *
 * This enables agents to ask clarifying or decision questions during
 * autonomous operation without hardcoding choices.
 */
export const AskUserQuestionToolInputSchema = AskUserQuestionParamsSchema;

export const AskUserQuestionToolOutputSchema = z.object({
  answers: z.array(z.object({
    question: z.string(),
    selectedOptions: z.array(z.string()),
    customAnswer: z.string().optional()
  }))
});

export interface AskUserQuestionToolOptions {
  /** Optional callback invoked when questions are presented (for TUI integration) */
  onQuestionsPending?: (questions: AskUserQuestionParams["questions"]) => void;
}

export function createAskUserQuestionTool(
  options: AskUserQuestionToolOptions = {}
): ToolDefinition<typeof AskUserQuestionToolInputSchema, typeof AskUserQuestionToolOutputSchema> {
  return {
    name: "ask_user_question",
    description: "Present structured questions to the user and collect their answers. Use for decisions that require operator input (2-4 options per question, 1-4 questions total). Returns requiresInput signal; caller must invoke resolveAnswers to continue.",
    inputSchema: AskUserQuestionToolInputSchema,
    outputSchema: AskUserQuestionToolOutputSchema,

    execute: async (input: AskUserQuestionParams, _context: unknown, _signal?: AbortSignal) => {
      // Validate questions structure (redundant with schema but explicit for clarity)
      const { questions } = input;

      if (!questions || questions.length === 0) {
        throw new Error("ask_user_question requires at least 1 question");
      }

      if (questions.length > 4) {
        throw new Error("ask_user_question supports at most 4 questions per call");
      }

      for (const q of questions) {
        if (!q.options || q.options.length < 2) {
          throw new Error(`Question "${q.question}" must have at least 2 options`);
        }
        if (q.options.length > 4) {
          throw new Error(`Question "${q.question}" supports at most 4 options`);
        }
      }

      // Notify integration layer (TUI/RPC) that questions are pending
      if (options.onQuestionsPending) {
        options.onQuestionsPending(questions);
      }

      // Return requiresInput signal with pendingQuestions payload
      // The actual promise resolution happens via resolveAnswers()
      return {
        status: "success" as const,
        requiresInput: true,
        pendingQuestions: questions,
        message: "Waiting for user answers via resolveAnswers()"
      };
    }
  };
}

/**
 * Resolve pending questions with user-provided answers.
 * Called by TUI, RPC, or test harness after the user responds.
 *
 * @param answers - Array of Answer objects, one per question
 * @throws Error if no pending question resolution is active
 */
export function resolveAnswers(answers: Answer[]): void {
  if (!pendingResolve) {
    throw new Error("No pending ask_user_question resolution. Tool must be invoked first.");
  }

  // Validate answers match pending questions count
  // (detailed validation happens at call site or via schema)

  pendingResolve(answers);
  pendingResolve = null;
  pendingReject = null;
}

/**
 * Reject the pending question resolution with an error.
 * Used for cancellation, timeout, or session closure.
 *
 * @param error - Error explaining why resolution failed
 */
export function rejectAnswers(error: Error): void {
  if (!pendingReject) {
    // No pending resolution; silently ignore (session may have closed)
    return;
  }

  pendingReject(error);
  pendingResolve = null;
  pendingReject = null;
}

/**
 * Check if there is an active pending question resolution.
 * Useful for TUI/RPC to determine if input is expected.
 */
export function hasPendingQuestions(): boolean {
  return pendingResolve !== null;
}

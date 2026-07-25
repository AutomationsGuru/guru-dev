import { z } from "zod";

import type { ToolDefinition } from "../registry.js";
import {
  AskUserInputSchema,
  AskUserOutputSchema,
  type AskUserInput,
  type AskUserOutput,
  type AskUserQuestion,
  validateAskUserAnswers
} from "../askUser/schema.js";

/**
 * ask_user_question tool (F93).
 *
 * Structured multi-choice questions with 2–4 options plus Other.
 * Designed for TUI/RPC surfaces: tool suspends with pendingQuestionId;
 * resolveAnswers API continues the session.
 *
 * Separate from ask_question to enforce stricter validation (2-4 options,
 * explicit Other support) and broker-based pending question flow.
 */

export interface AskUserQuestionOptions {
  /** Injected handler for TUI/RPC resolution. If provided, tool waits on this. */
  readonly onAsk?: (questions: readonly AskUserQuestion[]) => Promise<string[][]>;
  /** Optional broker integration for pending question ID generation. */
  readonly registerPending?: (questions: readonly AskUserQuestion[]) => Promise<string>;
  /** Override TTY detection (tests). */
  readonly isTty?: () => boolean;
}

function summarize(answers: readonly (readonly string[])[]): string {
  const parts = answers.map((a, i) => `Q${i + 1}: ${a.length > 0 ? a.join(", ") : "(none)"}`);
  return parts.join(" · ");
}

/**
 * Create the ask_user_question tool definition.
 * Accepts optional handlers for TUI/RPC integration.
 */
export function createAskUserQuestionTool(
  options: AskUserQuestionOptions = {}
): ToolDefinition<typeof AskUserInputSchema, typeof AskUserOutputSchema> {
  return {
    id: "ask_user_question",
    title: "Ask the operator (structured)",
    description:
      "Ask the human operator one or more multiple-choice questions (2–4 options each, with Other). " +
      "Returns to operator surface; session waits for answers before continuing. " +
      "Use when you need a decision at a hard edge or explicit preference before proceeding.",
    inputSchema: AskUserInputSchema,
    outputSchema: AskUserOutputSchema,
    effect: "read-only",
    async execute(input: AskUserInput): Promise<AskUserOutput> {
      const { questions } = input;

      // If an onAsk handler is provided, use it directly (TUI/RPC path).
      if (options.onAsk) {
        const answers = await options.onAsk(questions);
        // Validate answers before returning.
        const validationError = validateAskUserAnswers(questions, answers);
        if (validationError) {
          throw new Error(validationError);
        }
        return {
          answers: answers as string[][],
          summary: summarize(answers)
        };
      }

      // If a registerPending handler is provided, suspend and return pendingQuestionId.
      if (options.registerPending) {
        const pendingQuestionId = await options.registerPending(questions);
        return {
          answers: [],
          summary: "Waiting for operator answers…",
          pendingQuestionId
        };
      }

      // Fallback: TTY detection for direct interactive use.
      const isTty = options.isTty ?? (() => Boolean(process.stdin.isTTY && process.stdout.isTTY));
      if (!isTty()) {
        return {
          answers: questions.map(() => []),
          summary:
            "ask_user_question requires an interactive TUI or injected onAsk/registerPending handler. " +
            "Re-run in the TUI or provide answers via the host callback.",
          pendingQuestionId: undefined
        };
      }

      // Minimal interactive fallback (rare path): prompt via stdin.
      // In production this path is replaced by TUI/RPC onAsk wiring.
      const answers: string[][] = [];
      for (const [qi, q] of questions.entries()) {
        const lines = [`\n[${qi + 1}/${questions.length}] ${q.question}`];
        q.options.forEach((opt, i) => {
          lines.push(`  ${i + 1}. ${opt}`);
        });
        if (q.allowOther !== false) {
          lines.push(`  Other`);
        }
        lines.push(
          q.multiSelect
            ? "Select one or more (numbers/letters/text, comma-separated; Other allowed): "
            : "Select one (number/letter/text; Other allowed): "
        );
        // Simple single-line read for fallback.
        const readline = await import("node:readline");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const line = await new Promise<string>((resolve) => {
          rl.question(lines.join("\n"), (answer) => resolve(answer));
        });
        rl.close();

        const picked: string[] = [];
        const tokens = q.multiSelect ? line.split(/[,\s]+/).filter(Boolean) : [line.trim()];
        for (const token of tokens) {
          const asNum = Number.parseInt(token, 10);
          if (Number.isFinite(asNum) && asNum >= 1 && asNum <= q.options.length) {
            const opt = q.options[asNum - 1];
            if (opt && !picked.includes(opt)) picked.push(opt);
            continue;
          }
          const exact = q.options.find((o) => o.toLowerCase() === token.toLowerCase());
          if (exact && !picked.includes(exact)) {
            picked.push(exact);
            continue;
          }
          if (q.allowOther !== false && token.toLowerCase() === "other") {
            if (!picked.includes("Other")) picked.push("Other");
          }
        }
        answers.push(picked);
      }

      return { answers, summary: summarize(answers) };
    }
  };
}

/**
 * Convenience factory returning the tool in an array (matches baseToolFactory pattern).
 */
export function createAskUserQuestionTools(
  options: AskUserQuestionOptions = {}
): readonly ToolDefinition[] {
  return [createAskUserQuestionTool(options)];
}
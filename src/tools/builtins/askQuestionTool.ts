import { createInterface } from "node:readline";

import { z } from "zod";

import type { ToolDefinition } from "../registry.js";

/**
 * Interactive multi-choice questions — parity with modern harness
 * ask_user_question / AskQuestion tools. Inject `onAsk` for TUI overlays;
 * default path uses a TTY readline prompt when stdin is interactive.
 */

const QuestionSchema = z
  .object({
    question: z.string().trim().min(1).max(500),
    options: z.array(z.string().trim().min(1).max(200)).min(2).max(12),
    multiSelect: z.boolean().default(false)
  })
  .strict();

const AskQuestionInputSchema = z
  .object({
    questions: z.array(QuestionSchema).min(1).max(8)
  })
  .strict();

const AskQuestionOutputSchema = z
  .object({
    answers: z.array(z.array(z.string())),
    summary: z.string(),
    interactive: z.boolean()
  })
  .strict();

export type AskQuestionInput = z.infer<typeof AskQuestionInputSchema>;
export type AskQuestionOutput = z.infer<typeof AskQuestionOutputSchema>;
export type AskQuestionSpec = z.infer<typeof QuestionSchema>;

export interface AskQuestionOptions {
  readonly onAsk?: (questions: readonly AskQuestionSpec[]) => Promise<string[][]>;
  /** Override TTY detection (tests). */
  readonly isTty?: () => boolean;
  /** Injected line reader for tests: (prompt) => answer line. */
  readonly readLine?: (prompt: string) => Promise<string>;
}

function summarize(answers: readonly (readonly string[])[]): string {
  const parts = answers.map((a, i) => `Q${i + 1}: ${a.length > 0 ? a.join(", ") : "(none)"}`);
  return parts.join(" · ");
}

function parseSelection(line: string, options: readonly string[], multi: boolean): string[] {
  const trimmed = line.trim();
  if (!trimmed) {
    return [];
  }
  // Accept "1", "1,3", "a", or exact option text.
  const tokens = multi ? trimmed.split(/[,\s]+/u).filter(Boolean) : [trimmed];
  const picked: string[] = [];
  for (const token of tokens) {
    const asNum = Number.parseInt(token, 10);
    if (Number.isFinite(asNum) && asNum >= 1 && asNum <= options.length) {
      const opt = options[asNum - 1];
      if (opt && !picked.includes(opt)) {
        picked.push(opt);
      }
      continue;
    }
    const exact = options.find((o) => o.toLowerCase() === token.toLowerCase());
    if (exact && !picked.includes(exact)) {
      picked.push(exact);
      continue;
    }
    // Letter shortcuts: a=1, b=2, …
    if (/^[a-z]$/iu.test(token)) {
      const idx = token.toLowerCase().charCodeAt(0) - 97;
      const opt = options[idx];
      if (opt && !picked.includes(opt)) {
        picked.push(opt);
      }
    }
  }
  return multi ? picked : picked.slice(0, 1);
}

async function defaultReadLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(prompt, (answer) => resolve(answer));
    });
  } finally {
    rl.close();
  }
}

export async function askQuestionsInteractively(
  questions: readonly AskQuestionSpec[],
  options: AskQuestionOptions = {}
): Promise<AskQuestionOutput> {
  if (options.onAsk) {
    const answers = await options.onAsk(questions);
    return { answers, summary: summarize(answers), interactive: true };
  }

  const isTty = options.isTty ?? (() => Boolean(process.stdin.isTTY && process.stdout.isTTY));
  if (!isTty()) {
    return {
      answers: questions.map(() => []),
      summary:
        "ask_question requires an interactive TTY (or an injected onAsk handler). Re-run in the TUI or provide answers via the host callback.",
      interactive: false
    };
  }

  const readLine = options.readLine ?? defaultReadLine;
  const answers: string[][] = [];
  for (const [qi, q] of questions.entries()) {
    const lines = [`\n[${qi + 1}/${questions.length}] ${q.question}`];
    q.options.forEach((opt, i) => {
      lines.push(`  ${i + 1}. ${opt}`);
    });
    lines.push(
      q.multiSelect
        ? "Select one or more (numbers/letters/text, comma-separated): "
        : "Select one (number/letter/text): "
    );
    // Keep prompting until a valid pick (or empty for multi is ok only if multi? require at least one for single).
    let picks: string[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const line = await readLine(lines.join("\n"));
      picks = parseSelection(line, q.options, q.multiSelect);
      if (picks.length > 0 || (q.multiSelect && line.trim() === "")) {
        break;
      }
      process.stdout.write("Invalid selection — try again.\n");
    }
    answers.push(picks);
  }
  return { answers, summary: summarize(answers), interactive: true };
}

export function createAskQuestionTools(options: AskQuestionOptions = {}): readonly ToolDefinition[] {
  const tool: ToolDefinition<typeof AskQuestionInputSchema, typeof AskQuestionOutputSchema> = {
    id: "ask_question",
    title: "Ask the operator",
    description:
      "Ask the human operator one or more multiple-choice questions to resolve ambiguity, pick a design option, or confirm a non-hard-edge preference. Use when you need a decision before continuing.",
    inputSchema: AskQuestionInputSchema,
    outputSchema: AskQuestionOutputSchema,
    async execute(input) {
      return await askQuestionsInteractively(input.questions, options);
    }
  };
  return [tool];
}

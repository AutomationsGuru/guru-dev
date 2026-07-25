import { z } from "zod";
import type { ToolDefinition } from "./registry.js";

/**
 * Shell suggest buffer (IDEA-F283-SHELL-SUGGEST-01).
 * Maps NL description → suggested shell command text for human buffer/review.
 * Contract: suggest(nl) → commandText. NEVER executes. Read-only effect.
 * Execution (if approved later) is handled by separate shellExec / bash tools.
 */

export const ShellSuggestBufferInputSchema = z
  .object({
    nl: z.string().trim().min(1)
  })
  .strict();

export type ShellSuggestBufferInput = z.infer<typeof ShellSuggestBufferInputSchema>;

export const ShellSuggestBufferOutputSchema = z
  .object({
    suggestedCommand: z.string(),
    explanation: z.string().optional()
  })
  .strict();

export type ShellSuggestBufferOutput = z.infer<typeof ShellSuggestBufferOutputSchema>;

/** Core suggest(nl) → commandText (pure, no exec, no side-effects). */
export function suggest(nl: string): string {
  const input = ShellSuggestBufferInputSchema.parse({ nl });
  // Returns normalized text intended for buffer / human paste.
  // Model delegation or richer heuristics belong at call site or future extension.
  return input.nl;
}

export function createShellSuggestBufferTool(): ToolDefinition<
  typeof ShellSuggestBufferInputSchema,
  typeof ShellSuggestBufferOutputSchema
> {
  return {
    id: "shell.suggest.buffer",
    title: "Suggest shell command from natural language",
    description:
      "NL → suggested shell command text for human review/buffer. " +
      "Never executes. Dry-run by design; separate approval required for any run.",
    inputSchema: ShellSuggestBufferInputSchema,
    outputSchema: ShellSuggestBufferOutputSchema,
    effect: "read-only",
    execute(input) {
      const commandText = suggest(input.nl);
      return {
        suggestedCommand: commandText,
        explanation: "Suggested for human buffer. Review before any execution."
      };
    }
  };
}


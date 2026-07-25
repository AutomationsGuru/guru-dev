import { z } from "zod";

/**
 * Shell suggest buffer (IDEA-F283-SHELL-SUGGEST-01).
 *
 * A suggestion is text for the operator's buffer, not an execution request.
 * This module deliberately has no process, filesystem, or network side effects;
 * an approved command must be handed to a separate shell execution tool.
 */

export const ShellSuggestBufferInputSchema = z
  .object({
    nl: z.string().trim().min(1)
  })
  .strict();

export type ShellSuggestBufferInput = z.infer<typeof ShellSuggestBufferInputSchema>;

/** Return reviewable command text without executing or otherwise mutating state. */
export function suggest(nl: string): string {
  return ShellSuggestBufferInputSchema.parse({ nl }).nl;
}

/** Compatibility name for shell integrations that call the buffer operation directly. */
export function suggestToBuffer(nl: string): string {
  return suggest(nl);
}

import type { ToolDefinition } from "../tools/registry.js";
import { HARD_EDGE_VERBS } from "./schema.js";
import { verbsForCall } from "./evaluate.js";

// Module augmentation to extend ToolDefinition with the approvalMode metadata
declare module "../tools/registry.js" {
  interface ToolDefinition {
    readonly approvalMode?: "always_require" | "never_require" | "ask";
  }
}

export type ToolApprovalMode = "always_require" | "never_require" | "ask";

/**
 * Decorates a tool definition with approvalMode metadata.
 *
 * @param tool - The tool definition to decorate.
 * @param mode - The desired approval mode: "always_require" | "never_require" | "ask".
 * @returns The decorated tool definition.
 */
export function withToolApproval<
  TInputSchema extends import("zod").ZodType = import("zod").ZodType,
  TOutputSchema extends import("zod").ZodType = import("zod").ZodType
>(
  tool: ToolDefinition<TInputSchema, TOutputSchema>,
  mode: ToolApprovalMode
): ToolDefinition<TInputSchema, TOutputSchema> & { readonly approvalMode: ToolApprovalMode } {
  Object.defineProperty(tool, "approvalMode", {
    value: mode,
    writable: false,
    configurable: true,
    enumerable: true
  });
  return tool as any;
}

/**
 * Resolves the effective approval mode for a tool call.
 * If the tool call exercises any hard-limit verb, it escalates to "always_require"
 * regardless of the declared mode, enforcing the system's hard limits (Constitution §3).
 *
 * @param tool - The tool definition.
 * @param input - The tool input/arguments.
 * @returns The effective approval mode for this call.
 */
export function getEffectiveApprovalMode(
  tool: ToolDefinition,
  input: unknown
): ToolApprovalMode {
  // A call is a hard limit if it exercises any hard-edge verb
  const verbs = verbsForCall(tool.id, input);
  const isHardLimit = verbs.some((v) => HARD_EDGE_VERBS.has(v));

  if (isHardLimit) {
    return "always_require";
  }

  return tool.approvalMode ?? "ask";
}

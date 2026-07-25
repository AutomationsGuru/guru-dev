import type { ToolDefinition } from "../tools/registry.js";
import { verbsForCall } from "./evaluate.js";
import { HARD_EDGE_VERBS } from "./schema.js";

/**
 * A tool's preferred approval posture. Hard-edge calls always override this
 * declaration and require explicit operator approval.
 */
export type ToolApprovalMode = "always_require" | "never_require" | "ask";

/**
 * Tool metadata added by {@link withToolApproval}. Kept as module augmentation
 * so registries can carry the declaration without a second tool type.
 */
declare module "../tools/registry.js" {
  interface ToolDefinition {
    readonly approvalMode?: ToolApprovalMode;
  }
}

/**
 * Attach approval metadata to an existing tool definition without changing its
 * execution behavior or object identity.
 */
export function withToolApproval<
  TInputSchema extends import("zod").ZodType = import("zod").ZodType,
  TOutputSchema extends import("zod").ZodType = import("zod").ZodType
>(
  tool: ToolDefinition<TInputSchema, TOutputSchema>,
  mode: ToolApprovalMode
): ToolDefinition<TInputSchema, TOutputSchema> & { readonly approvalMode: ToolApprovalMode } {
  Object.defineProperty(tool, "approvalMode", {
    configurable: true,
    enumerable: true,
    value: mode,
    writable: false
  });
  return tool as ToolDefinition<TInputSchema, TOutputSchema> & { readonly approvalMode: ToolApprovalMode };
}

/**
 * Resolve a tool's mode for one invocation. Hard-edge verbs are evaluated from
 * the actual call and always win over declared metadata, including
 * `never_require` (Constitution §3).
 */
export function getEffectiveApprovalMode(tool: ToolDefinition, input: unknown): ToolApprovalMode {
  const hasHardEdge = verbsForCall(tool.id, input).some((verb) => HARD_EDGE_VERBS.has(verb));
  return hasHardEdge ? "always_require" : (tool.approvalMode ?? "ask");
}

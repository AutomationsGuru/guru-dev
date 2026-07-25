export interface ToolApprovalContext {
  readonly toolName: string;
}

export type ToolApprove = (ctx: ToolApprovalContext) => boolean | Promise<boolean>;

export interface GateToolCallInput {
  readonly hardLimit: boolean;
  readonly approve?: ToolApprove;
  readonly toolName: string;
}

export type ToolApprovalErrorCode = "tool_approval_denied" | "tool_hard_limit_denied";

export interface ToolApprovalError {
  readonly code: ToolApprovalErrorCode;
  readonly message: string;
}

export type GateToolCallResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly error: ToolApprovalError };

/**
 * Enforce hard limits before optional operator approval so no callback can lift
 * a constitutional stop condition.
 */
export async function gateToolCall({ hardLimit, approve, toolName }: GateToolCallInput): Promise<GateToolCallResult> {
  if (hardLimit) {
    return {
      allowed: false,
      error: {
        code: "tool_hard_limit_denied",
        message: `Tool '${toolName}' is blocked by a hard limit.`
      }
    };
  }

  if (approve && !(await approve({ toolName }))) {
    return {
      allowed: false,
      error: {
        code: "tool_approval_denied",
        message: `Tool '${toolName}' was denied by the approval callback.`
      }
    };
  }

  return { allowed: true };
}

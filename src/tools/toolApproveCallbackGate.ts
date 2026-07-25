export interface GateToolCallOpts {
  readonly hardLimit: boolean;
  readonly toolName: string;
  readonly approve?: (ctx: { readonly toolName: string }) => boolean | Promise<boolean>;
}

export interface GateToolCallResult {
  readonly allowed: boolean;
  readonly error?: "tool_hard_limit_denied" | "tool_approval_denied";
}

export async function gateToolCall(opts: GateToolCallOpts): Promise<GateToolCallResult> {
  if (opts.hardLimit) {
    return { allowed: false, error: "tool_hard_limit_denied" };
  }

  if (!opts.approve) {
    return { allowed: true };
  }

  try {
    const isApproved = await opts.approve({ toolName: opts.toolName });
    if (isApproved === true) {
      return { allowed: true };
    }
  } catch {
    // If the approve callback throws or rejects, handle as denied
  }

  return { allowed: false, error: "tool_approval_denied" };
}

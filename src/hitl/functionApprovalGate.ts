export type ApprovalMode = 'ask' | 'auto' | 'never_require' | 'ApprovalRequired';

export interface ToolContext {
  userId: string;
  sessionId: string;
}

let approvalCounter = 0;

export function withApproval<TArgs extends any[], TReturn>(
  tool: (...args: TArgs) => Promise<TReturn>,
  opts: { mode: ApprovalMode; hardLimit?: boolean }
) {
  return async (...args: TArgs) => {
    if (opts.hardLimit) {
      return {
        status: 'denied' as const,
        reason: 'hard limit',
        approvalState: 'denied-auto' as const,
        hardLimit: true
      };
    }
    if (opts.mode === 'ask' || opts.mode === 'ApprovalRequired') {
      approvalCounter += 1;
      return {
        status: 'suspended' as const,
        reason: 'approval-required' as const,
        state: { ask: true },
        approvalState: 'ask' as const,
        approvalId: `approval-${approvalCounter}`
      };
    }
    // default: execute (for completeness, though not tested here)
    return tool(...args);
  };
}

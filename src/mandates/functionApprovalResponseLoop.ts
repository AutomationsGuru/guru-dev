/**
 * Function approval response loop — IDEA-F247-APPR-LOOP-01.
 *
 * Holds a pure pending-approvals list and applies the operator's approve/reject
 * response to individual items, clearing them as they are resolved. This is the
 * session-level "request/response loop" (MAF K2 analogue): requests land in the
 * pending queue, the operator decides, and the item is cleared.
 *
 * Composes with:
 *  - F246: approval-required function wrapper (marks calls that need approval)
 *  - F221: HITL tool-call decision (approve|edit|reject types)
 *
 * Pure state — no side effects, no I/O, injectable everywhere.
 */

export interface PendingApprovalItem {
  /** Stable unique key for this pending request. */
  readonly id: string;
  /** The tool/function whose invocation requires approval. */
  readonly toolId: string;
  /** Human-readable reason surfaced to the operator. */
  readonly reason: string;
  /** True when a hard-edge verb is in play — always prompts, never auto-approved. */
  readonly hardEdge: boolean;
}

export type ApprovalLoopResponse = "approve" | "reject";

export interface ApprovalLoopState {
  readonly pending: readonly PendingApprovalItem[];
}

export interface ApprovalResponseResult {
  readonly state: ApprovalLoopState;
  /** True when the operator approved — the caller should proceed. */
  readonly proceed: boolean;
}

/** Create an empty approval-loop state. */
export function createApprovalLoopState(): ApprovalLoopState {
  return { pending: [] };
}

/** Add a pending approval item (immutable — returns new state). */
export function addPendingApproval(state: ApprovalLoopState, item: PendingApprovalItem): ApprovalLoopState {
  return { pending: [...state.pending, item] };
}

/**
 * Apply an approval/rejection response to a specific pending item by id.
 * Clears the item from pending regardless of outcome.
 * Returns whether the caller should proceed (approve → true, reject → false).
 * Unknown id → no-op, proceed=false (fail-secure: never proceed for an
 * unrecognised request).
 */
export function applyApprovalResponse(
  state: ApprovalLoopState,
  id: string,
  response: ApprovalLoopResponse
): ApprovalResponseResult {
  const item = state.pending.find((p) => p.id === id);
  if (!item) {
    return { state, proceed: false };
  }
  return {
    state: { pending: state.pending.filter((p) => p.id !== id) },
    proceed: response === "approve"
  };
}

/** Clear all pending approvals — returns a fresh empty state. */
export function clearApprovalLoop(_state: ApprovalLoopState): ApprovalLoopState {
  return { pending: [] };
}

import { describe, expect, it } from "vitest";

import {
  addPendingApproval,
  applyApprovalResponse,
  clearApprovalLoop,
  createApprovalLoopState,
  type ApprovalLoopResponse,
  type PendingApprovalItem
} from '../../src/mandates/functionApprovalResponseLoop.js';

function item(overrides: Partial<PendingApprovalItem> = {}): PendingApprovalItem {
  return {
    id: "req-1",
    toolId: "bash",
    reason: "exec: npm install",
    hardEdge: false,
    ...overrides
  };
}

describe("functionApprovalResponseLoop — pending / respond / clear", () => {
  it("starts with an empty pending list", () => {
    const state = createApprovalLoopState();
    expect(state.pending).toEqual([]);
  });

  it("adds an item to the pending list", () => {
    const state = createApprovalLoopState();
    const next = addPendingApproval(state, item());
    expect(next.pending).toHaveLength(1);
    expect(next.pending[0]).toMatchObject({ id: "req-1", toolId: "bash" });
  });

  it("preserves immutability — original state unchanged after add", () => {
    const state = createApprovalLoopState();
    addPendingApproval(state, item());
    expect(state.pending).toHaveLength(0);
  });

  it("approve → proceed is true, item is cleared from pending", () => {
    let state = createApprovalLoopState();
    state = addPendingApproval(state, item({ id: "req-1" }));
    state = addPendingApproval(state, item({ id: "req-2", toolId: "write" }));

    const result = applyApprovalResponse(state, "req-1", "approve");

    expect(result.proceed).toBe(true);
    expect(result.state.pending).toHaveLength(1);
    expect(result.state.pending[0]!.id).toBe("req-2");
  });

  it("reject → proceed is false, item is cleared from pending", () => {
    let state = createApprovalLoopState();
    state = addPendingApproval(state, item({ id: "req-1" }));
    state = addPendingApproval(state, item({ id: "req-2", toolId: "write" }));

    const result = applyApprovalResponse(state, "req-1", "reject");

    expect(result.proceed).toBe(false);
    expect(result.state.pending).toHaveLength(1);
    expect(result.state.pending[0]!.id).toBe("req-2");
  });

  it("responding to a non-existent id is a no-op — proceed is false", () => {
    let state = createApprovalLoopState();
    state = addPendingApproval(state, item({ id: "req-1" }));

    const result = applyApprovalResponse(state, "nonexistent", "approve");

    expect(result.proceed).toBe(false);
    // pending list unchanged — the unknown id couldn't be found
    expect(result.state.pending).toHaveLength(1);
    expect(result.state.pending[0]!.id).toBe("req-1");
  });

  it("clearApprovalLoop removes all pending items", () => {
    let state = createApprovalLoopState();
    state = addPendingApproval(state, item({ id: "req-1" }));
    state = addPendingApproval(state, item({ id: "req-2" }));
    state = addPendingApproval(state, item({ id: "req-3" }));

    const cleared = clearApprovalLoop(state);

    expect(cleared.pending).toEqual([]);
    expect(state.pending).toHaveLength(3); // original unchanged
  });

  it("preserves hard edge flag on pending items", () => {
    let state = createApprovalLoopState();
    state = addPendingApproval(state, item({ id: "req-1", hardEdge: true }));

    expect(state.pending[0]!.hardEdge).toBe(true);

    const result = applyApprovalResponse(state, "req-1", "approve");
    expect(result.proceed).toBe(true);
    expect(result.state.pending).toHaveLength(0);
  });

  it("acceptance: approve = continues execution; reject = stops", () => {
    let state = createApprovalLoopState();
    state = addPendingApproval(state, item({ id: "approve-me" }));
    state = addPendingApproval(state, item({ id: "reject-me" }));

    // Approve — should proceed
    const approved = applyApprovalResponse(state, "approve-me", "approve");
    expect(approved.proceed).toBe(true);

    // Reject — should stop
    const rejected = applyApprovalResponse(state, "reject-me", "reject");
    expect(rejected.proceed).toBe(false);

    // Both were cleared independently
    expect(approved.state.pending).toHaveLength(1);
    expect(approved.state.pending[0]!.id).toBe("reject-me");
    expect(rejected.state.pending).toHaveLength(1);
    expect(rejected.state.pending[0]!.id).toBe("approve-me");
  });

  it("handles an empty pending list for clear and response gracefully", () => {
    const state = createApprovalLoopState();
    expect(clearApprovalLoop(state).pending).toEqual([]);
    expect(applyApprovalResponse(state, "any", "approve").proceed).toBe(false);
    expect(applyApprovalResponse(state, "any", "reject").proceed).toBe(false);
  });
});

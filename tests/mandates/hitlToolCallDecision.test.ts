import { describe, expect, it } from "vitest";

import {
  applyDecision,
  type HitlDecision,
  type PendingToolCall
} from '../../src/mandates/hitlToolCallDecision.js';

function pendingCall(overrides: Partial<PendingToolCall> = {}): PendingToolCall {
  return {
    toolId: "write",
    args: { path: "src/app.ts", content: "v1" },
    ...overrides
  };
}

describe("applyDecision — HITL tool call decision (approve | edit | reject)", () => {
  it("approve → proceeds with the call's original args, unchanged", () => {
    const call = pendingCall();
    const result = applyDecision(call, { type: "approve" });
    expect(result).toEqual({ kind: "approved", call });
    // The approved call carries the ORIGINAL args by identity — no rewrite.
    expect(result.kind === "approved" && result.call.args).toBe(call.args);
  });

  it("edit → proceeds with the REWRITTEN args replacing the originals", () => {
    const call = pendingCall();
    const edited = { path: "src/app.ts", content: "v2 — operator edit" };
    const result = applyDecision(call, { type: "edit", args: edited });
    expect(result).toEqual({
      kind: "approved",
      call: { ...call, args: edited }
    });
    expect(result.kind === "approved" && result.call.args).toBe(edited);
    expect(result.kind === "approved" && result.call.args).not.toBe(call.args);
  });

  it("edit → the original pending call is NOT mutated (pure)", () => {
    const call = pendingCall();
    const snapshot = { ...call.args };
    applyDecision(call, { type: "edit", args: { path: "other.ts" } });
    expect(call.args).toEqual(snapshot);
  });

  it("reject → does not proceed; an optional operator reason is carried through", () => {
    const withReason = applyDecision(pendingCall(), { type: "reject", reason: "not on main" });
    expect(withReason).toEqual({ kind: "rejected", reason: "not on main" });
    const noReason = applyDecision(pendingCall(), { type: "reject" });
    expect(noReason).toEqual({ kind: "rejected", reason: undefined });
  });

  it("an UNKNOWN decision type default-rejects (fail-safe, never a blanket approve)", () => {
    const bad = { type: "sure-why-not" } as unknown as HitlDecision;
    expect(applyDecision(pendingCall(), bad)).toEqual({ kind: "rejected", reason: undefined });
  });
});

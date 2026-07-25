import { describe, expect, it, vi } from "vitest";

import { gateToolCall } from '../../src/tools/toolApproveGate.js';

describe("gateToolCall", () => {
  it("returns a structured denial when the approval callback denies the tool", async () => {
    const approve = vi.fn(async () => false);

    await expect(gateToolCall({ toolName: "write", hardLimit: false, approve })).resolves.toEqual({
      allowed: false,
      error: {
        code: "tool_approval_denied",
        message: "Tool 'write' was denied by the approval callback."
      }
    });
    expect(approve).toHaveBeenCalledWith({ toolName: "write" });
  });

  it("allows the tool when the approval callback approves it", async () => {
    const approve = vi.fn(async () => true);

    await expect(gateToolCall({ toolName: "read", hardLimit: false, approve })).resolves.toEqual({ allowed: true });
    expect(approve).toHaveBeenCalledWith({ toolName: "read" });
  });

  it("denies hard-limit tools without invoking the approval callback", async () => {
    const approve = vi.fn(async () => true);

    await expect(gateToolCall({ toolName: "delete", hardLimit: true, approve })).resolves.toEqual({
      allowed: false,
      error: {
        code: "tool_hard_limit_denied",
        message: "Tool 'delete' is blocked by a hard limit."
      }
    });
    expect(approve).not.toHaveBeenCalled();
  });
});

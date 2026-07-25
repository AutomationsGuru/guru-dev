import { describe, expect, it, vi } from "vitest";

import { gateToolCall } from '../../src/tools/toolApproveCallbackGate.js';

describe("gateToolCall", () => {
  it("should return { allowed: true } when hardLimit is false and approve callback is omitted", async () => {
    const result = await gateToolCall({
      hardLimit: false,
      toolName: "test-tool"
    });

    expect(result).toEqual({
      allowed: true
    });
  });

  it("should return { allowed: false, error: \"tool_hard_limit_denied\" } when hardLimit is true and approve is omitted", async () => {
    const result = await gateToolCall({
      hardLimit: true,
      toolName: "test-tool"
    });

    expect(result).toEqual({
      allowed: false,
      error: "tool_hard_limit_denied"
    });
  });

  it("should prioritize hardLimit over approve callback and not invoke the callback", async () => {
    const approveMock = vi.fn().mockReturnValue(true);

    const result = await gateToolCall({
      hardLimit: true,
      toolName: "test-tool",
      approve: approveMock
    });

    expect(result).toEqual({
      allowed: false,
      error: "tool_hard_limit_denied"
    });
    expect(approveMock).not.toHaveBeenCalled();
  });

  it("should return { allowed: true } when hardLimit is false and sync approve returns true", async () => {
    const approveMock = vi.fn().mockReturnValue(true);

    const result = await gateToolCall({
      hardLimit: false,
      toolName: "test-tool",
      approve: approveMock
    });

    expect(result).toEqual({
      allowed: true
    });
    expect(approveMock).toHaveBeenCalledWith({ toolName: "test-tool" });
  });

  it("should return { allowed: false, error: \"tool_approval_denied\" } when hardLimit is false and sync approve returns false", async () => {
    const approveMock = vi.fn().mockReturnValue(false);

    const result = await gateToolCall({
      hardLimit: false,
      toolName: "test-tool",
      approve: approveMock
    });

    expect(result).toEqual({
      allowed: false,
      error: "tool_approval_denied"
    });
    expect(approveMock).toHaveBeenCalledWith({ toolName: "test-tool" });
  });

  it("should return { allowed: true } when hardLimit is false and async approve resolves to true", async () => {
    const approveMock = vi.fn().mockResolvedValue(true);

    const result = await gateToolCall({
      hardLimit: false,
      toolName: "test-tool",
      approve: approveMock
    });

    expect(result).toEqual({
      allowed: true
    });
    expect(approveMock).toHaveBeenCalledWith({ toolName: "test-tool" });
  });

  it("should return { allowed: false, error: \"tool_approval_denied\" } when hardLimit is false and async approve resolves to false", async () => {
    const approveMock = vi.fn().mockResolvedValue(false);

    const result = await gateToolCall({
      hardLimit: false,
      toolName: "test-tool",
      approve: approveMock
    });

    expect(result).toEqual({
      allowed: false,
      error: "tool_approval_denied"
    });
    expect(approveMock).toHaveBeenCalledWith({ toolName: "test-tool" });
  });

  it("should return { allowed: false, error: \"tool_approval_denied\" } when hardLimit is false and approve throws an error (fail-closed)", async () => {
    const approveMock = vi.fn().mockImplementation(() => {
      throw new Error("sync error");
    });

    const result = await gateToolCall({
      hardLimit: false,
      toolName: "test-tool",
      approve: approveMock
    });

    expect(result).toEqual({
      allowed: false,
      error: "tool_approval_denied"
    });
    expect(approveMock).toHaveBeenCalledWith({ toolName: "test-tool" });
  });

  it("should return { allowed: false, error: \"tool_approval_denied\" } when hardLimit is false and approve rejects (fail-closed)", async () => {
    const approveMock = vi.fn().mockRejectedValue(new Error("async error"));

    const result = await gateToolCall({
      hardLimit: false,
      toolName: "test-tool",
      approve: approveMock
    });

    expect(result).toEqual({
      allowed: false,
      error: "tool_approval_denied"
    });
    expect(approveMock).toHaveBeenCalledWith({ toolName: "test-tool" });
  });
});

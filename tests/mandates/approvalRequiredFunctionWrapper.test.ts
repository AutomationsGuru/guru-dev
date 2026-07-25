import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  wrapApprovalRequired,
  type ApprovalRequiredFunction,
  type ApprovalRequiredWrapperOptions,
  type WrappedApprovalRequest
} from '../../src/mandates/approvalRequiredFunctionWrapper.js';
import type { ToolDefinition } from '../../src/tools/registry.js';
import type { ToolExecutionContext } from '../../src/tools/registry.js';

/**
 * ApprovalRequired function wrapper (IDEA-F246-APPROVAL-WRAP-01; MAF
 * ApprovalRequiredAIFunction residual). The wrapper turns an ordinary tool def
 * into one whose invoke path ALWAYS emits an approval request BEFORE any side
 * effect can run — the tool body never executes until an explicit approval is
 * supplied. Composes conceptually with F242 tool approval modes and F221 HITL
 * decisions, but stays dependency-free: it wraps a ToolDefinition and carries an
 * injected approval surface, so the always-prompt-first contract is a structural
 * code path (Constitution §3.2 — no side effect without approval), not prose.
 */

function makeExecutedCounter() {
  let calls = 0;
  return {
    get count() {
      return calls;
    },
    bump() {
      calls += 1;
    }
  };
}

/** A toy mutating tool that bumps the counter on every execution. */
function makeEchoTool(executed: ReturnType<typeof makeExecutedCounter>): ToolDefinition {
  return {
    id: "echo",
    title: "Echo",
    description: "echoes its input",
    effect: "mutating",
    inputSchema: z.object({ message: z.string() }),
    outputSchema: z.object({ message: z.string() }),
    async execute(input: { message: string }) {
      executed.bump();
      return { message: input.message };
    }
  };
}

function captureRequests(): {
  request: (req: WrappedApprovalRequest) => Promise<boolean>;
  seen: WrappedApprovalRequest[];
} {
  const seen: WrappedApprovalRequest[] = [];
  return {
    seen,
    request: async (req) => {
      seen.push(req);
      return true;
    }
  };
}

describe("wrapApprovalRequired — always prompt before side effects (§3.2)", () => {
  it("tryInvoke never runs the tool on the first call — it returns needsApproval", async () => {
    const executed = makeExecutedCounter();
    const tool = makeEchoTool(executed);
    const { request, seen } = captureRequests();
    const wrapped: ApprovalRequiredFunction<typeof tool> = wrapApprovalRequired(tool, { request });

    const outcome = await wrapped.tryInvoke({ message: "hi" });

    expect(outcome.kind).toBe("needsApproval");
    if (outcome.kind === "needsApproval") {
      expect(outcome.request.toolId).toBe("echo");
      expect(outcome.request.input).toEqual({ message: "hi" });
    }
    // No approval surface has fired and the tool body has NOT executed.
    expect(seen).toHaveLength(0);
    expect(executed.count).toBe(0);
  });

  it("after needsApproval, supplying an explicit approval runs the tool exactly once and returns the result", async () => {
    const executed = makeExecutedCounter();
    const tool = makeEchoTool(executed);
    const { request, seen } = captureRequests();
    const wrapped = wrapApprovalRequired(tool, { request });

    const first = await wrapped.tryInvoke({ message: "hi" });
    expect(first.kind).toBe("needsApproval");

    const second = await wrapped.tryInvoke({ message: "hi" }, { approved: true });
    expect(second.kind).toBe("result");
    if (second.kind === "result") {
      expect(second.output).toEqual({ message: "hi" });
    }
    expect(executed.count).toBe(1);
    expect(seen).toHaveLength(1); // the injected approval surface was consulted
  });

  it("a denied approval never executes the tool and returns a denied result", async () => {
    const executed = makeExecutedCounter();
    const tool = makeEchoTool(executed);
    const seen: WrappedApprovalRequest[] = [];
    const wrapped = wrapApprovalRequired(tool, {
      request: async (req) => {
        seen.push(req);
        return false;
      }
    });

    const first = await wrapped.tryInvoke({ message: "x" });
    expect(first.kind).toBe("needsApproval");

    const second = await wrapped.tryInvoke({ message: "x" }, { approved: true });
    expect(second.kind).toBe("denied");
    expect(executed.count).toBe(0);
    expect(seen).toHaveLength(1);
  });

  it("without an approval token, repeated tryInvoke keeps re-emitting needsApproval and never runs", async () => {
    const executed = makeExecutedCounter();
    const tool = makeEchoTool(executed);
    const wrapped = wrapApprovalRequired(tool, { request: async () => true });

    for (let i = 0; i < 3; i += 1) {
      const outcome = await wrapped.tryInvoke({ message: "again" });
      expect(outcome.kind).toBe("needsApproval");
    }
    expect(executed.count).toBe(0);
  });

  it("forwards the execution context (signal/cwd) into the underlying tool body", async () => {
    let received: ToolExecutionContext | undefined;
    const tool: ToolDefinition = {
      id: "ctx",
      title: "Ctx",
      description: "records context",
      effect: "mutating",
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      async execute(_input, context) {
        received = context;
        return { ok: true };
      }
    };
    const wrapped = wrapApprovalRequired(tool, { request: async () => true });
    const execContext: ToolExecutionContext = { cwd: "/tmp", runId: "r1", startedBy: "op" };

    await wrapped.tryInvoke({});
    const second = await wrapped.tryInvoke({}, { approved: true, context: execContext });
    expect(second.kind).toBe("result");
    expect(received).toMatchObject({ cwd: "/tmp", runId: "r1", startedBy: "op" });
  });

  it("a thrown tool body is surfaced as a failed result, never silently swallowed", async () => {
    const tool: ToolDefinition = {
      id: "boom",
      title: "Boom",
      description: "always throws",
      effect: "mutating",
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      async execute() {
        throw new Error("kaboom");
      }
    };
    const wrapped = wrapApprovalRequired(tool, { request: async () => true });
    await wrapped.tryInvoke({});
    const second = await wrapped.tryInvoke({}, { approved: true });
    expect(second.kind).toBe("failed");
    if (second.kind === "failed") {
      expect(second.error).toBe("kaboom");
    }
  });

  it("the wrapper exposes the wrapped tool's metadata so registries can still describe it", () => {
    const tool = makeEchoTool(makeExecutedCounter());
    const wrapped = wrapApprovalRequired(tool, { request: async () => true });
    expect(wrapped.id).toBe("echo");
    expect(wrapped.title).toBe("Echo");
    expect(wrapped.effect).toBe("mutating");
    expect(wrapped.description).toBe("echoes its input");
  });

  it("default fail-safe: an approval surface that returns a non-boolean truthy value is NOT treated as approval", async () => {
    const executed = makeExecutedCounter();
    const tool = makeEchoTool(executed);
    // A buggy surface that resolves a truthy object instead of true.
    const opts: ApprovalRequiredWrapperOptions = {
      request: async () => "yes" as unknown as boolean
    };
    const wrapped = wrapApprovalRequired(tool, opts);
    await wrapped.tryInvoke({ message: "z" });
    const second = await wrapped.tryInvoke({ message: "z" }, { approved: true });
    // Truthy-but-not-true must NOT run the side effect (fail-closed, §3.2).
    expect(second.kind).toBe("denied");
    expect(executed.count).toBe(0);
  });
});

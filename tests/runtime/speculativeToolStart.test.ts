import { describe, expect, it } from "vitest";

import { z } from "zod";

import {
  classifySpeculative,
  scheduleSpeculativeToolStart,
  type SpeculativeApprovalPolicy,
  type SpeculativeHardLimitPolicy,
  type SpeculativeTool
} from '../../src/runtime/speculativeToolStart.js';

// --- fixture tools -----------------------------------------------------------

const readTool: SpeculativeTool = {
  id: "repo.read",
  effect: "read-only",
  execute: async () => ({ ok: true, text: "file contents" })
};

const writeTool: SpeculativeTool = {
  id: "repo.write",
  effect: "mutating",
  execute: async () => ({ ok: true })
};

// A tool with NO effect declared — untrusted. Must never be speculative-safe.
const unmarkedTool: SpeculativeTool = {
  id: "repo.risky",
  execute: async () => ({ ok: true })
};

const allowAll: SpeculativeApprovalPolicy = { approve: async () => true };
const denyAll: SpeculativeApprovalPolicy = { approve: async () => false };

// Default hard-limit policy: spend ceiling $0 denies all, no secret-presence block.
const permissiveHardLimits: SpeculativeHardLimitPolicy = {
  approveSpend: async () => false,
  blockedSecretNames: []
};

// --- classification ----------------------------------------------------------

describe("classifySpeculative", () => {
  it("marks an explicit read-only tool as speculative-safe", () => {
    expect(classifySpeculative(readTool)).toBe("speculative-safe");
  });

  it("marks a mutating tool as must-wait", () => {
    expect(classifySpeculative(writeTool)).toBe("must-wait");
  });

  it("treats an unmarked tool as must-wait (omission is untrusted)", () => {
    // Vision §1.2 + G1004 effect gate: omission never grants read-only trust.
    expect(classifySpeculative(unmarkedTool)).toBe("must-wait");
  });
});

// --- scheduling --------------------------------------------------------------

describe("scheduleSpeculativeToolStart", () => {
  it("starts a read-only tool early when policy and hard limits allow it", async () => {
    const executions: Array<unknown> = [];
    const decision = await scheduleSpeculativeToolStart({
      tool: readTool,
      completeArguments: { path: "README.md" },
      approval: allowAll,
      hardLimits: permissiveHardLimits,
      execute: async (toolId, input) => {
        const out = await readTool.execute?.(input);
        executions.push({ toolId, input, out });
        return { status: "succeeded" as const, output: out };
      }
    });

    expect(decision.kind).toBe("started");
    if (decision.kind === "started") {
      await decision.done;
      expect(decision.toolId).toBe("repo.read");
    }
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({ toolId: "repo.read", input: { path: "README.md" } });
  });

  it("waits (does not start) a mutating tool even when approval allows it", async () => {
    const executions: Array<unknown> = [];
    const decision = await scheduleSpeculativeToolStart({
      tool: writeTool,
      completeArguments: { path: "a.txt", contents: "x" },
      approval: allowAll,
      hardLimits: permissiveHardLimits,
      execute: async () => {
        executions.push("ran");
        return { status: "succeeded" as const, output: {} };
      }
    });

    expect(decision.kind).toBe("wait");
    if (decision.kind === "wait") {
      expect(decision.reasons).toContain("tool is not speculative-safe (effect !== read-only)");
    }
    expect(executions).toHaveLength(0);
  });

  it("waits when the approval policy denies the call", async () => {
    const executions: Array<unknown> = [];
    const decision = await scheduleSpeculativeToolStart({
      tool: readTool,
      completeArguments: { path: "README.md" },
      approval: denyAll,
      hardLimits: permissiveHardLimits,
      execute: async () => {
        executions.push("ran");
        return { status: "succeeded" as const, output: {} };
      }
    });

    expect(decision.kind).toBe("wait");
    if (decision.kind === "wait") {
      expect(decision.reasons.some((r) => r.includes("approval policy"))).toBe(true);
    }
    expect(executions).toHaveLength(0);
  });

  it("never speculative-auto-starts when a hard limit denies (spend ceiling)", async () => {
    // Vision §3.2: no unapproved spend. A tool that needs spend is denied by the
    // $0-denies-all ceiling BEFORE any speculative start — YOLO cannot lift it.
    const executions: Array<unknown> = [];
    const decision = await scheduleSpeculativeToolStart({
      tool: readTool,
      completeArguments: { path: "README.md" },
      approval: allowAll,
      hardLimits: {
        // Hard limit reports that this call would spend.
        approveSpend: async () => false,
        spendRequired: true,
        blockedSecretNames: []
      },
      execute: async () => {
        executions.push("ran");
        return { status: "succeeded" as const, output: {} };
      }
    });

    expect(decision.kind).toBe("wait");
    if (decision.kind === "wait") {
      expect(decision.reasons.some((r) => r.includes("hard limit") && r.includes("spend"))).toBe(true);
    }
    expect(executions).toHaveLength(0);
  });

  it("never speculative-auto-starts when a blocked secret NAME is referenced", async () => {
    // Vision §3.3: secrets handled by presence/name only. The harness never reads
    // the value; it only sees that a blocked secret name is referenced.
    const executions: Array<unknown> = [];
    const decision = await scheduleSpeculativeToolStart({
      tool: readTool,
      completeArguments: { path: "secrets.env" },
      approval: allowAll,
      hardLimits: {
        approveSpend: async () => false,
        // The input references a path that a hard-limit scrubber flags by NAME.
        blockedSecretNames: ["secrets.env"]
      },
      execute: async () => {
        executions.push("ran");
        return { status: "succeeded" as const, output: {} };
      }
    });

    expect(decision.kind).toBe("wait");
    if (decision.kind === "wait") {
      expect(decision.reasons.some((r) => r.includes("hard limit") && r.includes("secret"))).toBe(true);
    }
    expect(executions).toHaveLength(0);
  });

  it("waits when the stream abort signal is already set", async () => {
    const executions: Array<unknown> = [];
    const controller = new AbortController();
    controller.abort();

    const decision = await scheduleSpeculativeToolStart({
      tool: readTool,
      completeArguments: { path: "README.md" },
      approval: allowAll,
      hardLimits: permissiveHardLimits,
      streamSignal: controller.signal,
      execute: async () => {
        executions.push("ran");
        return { status: "succeeded" as const, output: {} };
      }
    });

    expect(decision.kind).toBe("cancelled");
    if (decision.kind === "cancelled") {
      expect(decision.reason).toContain("aborted");
    }
    expect(executions).toHaveLength(0);
  });

  it("cancels an in-flight speculative execution when cancel() is called", async () => {
    let observedAbort: AbortSignal | undefined;
    let released = false;
    const decision = await scheduleSpeculativeToolStart({
      tool: readTool,
      completeArguments: { path: "README.md" },
      approval: allowAll,
      hardLimits: permissiveHardLimits,
      execute: async (_toolId, _input, signal) => {
        observedAbort = signal;
        // Block until the abort arrives.
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener("abort", () => resolve(), { once: true });
          // Safety: resolve anyway after the test releases.
          setTimeout(() => {
            released = true;
            resolve();
          }, 1000);
        });
        return { status: "failed" as const, error: "aborted" };
      }
    });

    expect(decision.kind).toBe("started");
    if (decision.kind === "started") {
      decision.cancel("stream aborted");
      await decision.done;
      expect(observedAbort?.aborted).toBe(true);
    }
    void released;
  });

  it("waits when the complete arguments are invalid JSON", async () => {
    const executions: Array<unknown> = [];
    const decision = await scheduleSpeculativeToolStart({
      tool: readTool,
      completeArgumentsText: "{not json",
      approval: allowAll,
      hardLimits: permissiveHardLimits,
      execute: async () => {
        executions.push("ran");
        return { status: "succeeded" as const, output: {} };
      }
    });

    expect(decision.kind).toBe("wait");
    if (decision.kind === "wait") {
      expect(decision.reasons.some((r) => r.includes("invalid JSON"))).toBe(true);
    }
    expect(executions).toHaveLength(0);
  });

  it("treats an unmarked tool as must-wait even under allow-all + permissive limits", async () => {
    const executions: Array<unknown> = [];
    const decision = await scheduleSpeculativeToolStart({
      tool: unmarkedTool,
      completeArguments: {},
      approval: allowAll,
      hardLimits: permissiveHardLimits,
      execute: async () => {
        executions.push("ran");
        return { status: "succeeded" as const, output: {} };
      }
    });

    expect(decision.kind).toBe("wait");
    expect(executions).toHaveLength(0);
  });

  it("prefers the already-parsed object over raw JSON text when both are given", async () => {
    let captured: unknown;
    const decision = await scheduleSpeculativeToolStart({
      tool: readTool,
      completeArguments: { path: "from-object" },
      completeArgumentsText: '{"path":"from-text"}',
      approval: allowAll,
      hardLimits: permissiveHardLimits,
      execute: async (_id, input) => {
        captured = input;
        return { status: "succeeded" as const, output: {} };
      }
    });

    expect(decision.kind).toBe("started");
    if (decision.kind === "started") {
      await decision.done;
      expect(captured).toEqual({ path: "from-object" });
    }
  });
});

// --- zod schema interop: the module must accept real ToolDefinition-shaped tools

describe("speculative start with zod-validated tools (parity with registry)", () => {
  it("classifies a zod-schema read-only tool as speculative-safe", () => {
    const tool = {
      id: "search.grep",
      title: "grep",
      description: "search",
      inputSchema: z.object({ pattern: z.string() }),
      outputSchema: z.object({ matches: z.array(z.string()) }),
      effect: "read-only" as const,
      execute: async () => ({ matches: [] })
    };
    // A real registry ToolDefinition carries the same `effect` field — classification
    // must work on the structural marker, independent of the schema libraries.
    expect(classifySpeculative(tool)).toBe("speculative-safe");
  });
});

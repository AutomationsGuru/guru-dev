import { describe, expect, it } from "vitest";

import {
  createDebugLoopTool,
  DebugLoopToolInputSchema,
  DEFAULT_DEBUG_LOOP_MAX_TRIES,
  type DebugLoopBackend
} from '../../src/tools/builtins/debugLoopTool.js';
import {
  runDebugLoop,
  type CommandRunner,
  type CommandRunResult,
  type FixProposer,
  type TrialApplier
} from '../../src/tools/debugLoop/runDebugLoop.js';

/**
 * IDEA-F10-DEBUG-LOOP-01 — bounded debug loop. The engine is fully injectable
 * (command runner, fix proposer, trial applier) so tests drive deterministic
 * success-on-second-try and maxTries-fail-closed paths without a live model or
 * shell. The tool factory wraps the engine behind the standard
 * `ToolDefinition` + injectable-backend seam used by monitor/schedule.
 */
describe("debugLoop engine — runDebugLoop", () => {
  const baseInput = { Command: "make test", MaxTries: 5 };

  function passingRunner(): CommandRunner {
    return async () => ({ exitCode: 0, stdout: "ok", stderr: "" });
  }

  it("succeeds on the first try and reports attempt count 1", async () => {
    const receipt = await runDebugLoop({
      run: passingRunner(),
      propose: async () => null,
      apply: async () => {},
      input: baseInput
    });
    expect(receipt.status).toBe("succeeded");
    expect(receipt.tries).toBe(1);
    expect(receipt.maxTries).toBe(5);
    expect(receipt.message).toMatch(/succeeded/i);
  });

  it("succeeds on the second try after a fix is proposed and applied", async () => {
    let calls = 0;
    const run: CommandRunner = async () => {
      calls += 1;
      return calls < 2
        ? { exitCode: 1, stdout: "", stderr: "Error: missing semicolon" }
        : { exitCode: 0, stdout: "ok", stderr: "" };
    };
    const proposerCalls: string[] = [];
    const proposer: FixProposer = async ({ lastResult }) => {
      proposerCalls.push(`${lastResult.stdout}|${lastResult.stderr}`);
      return { description: "add the missing semicolon", patch: "x++;" };
    };
    const applied: string[] = [];
    const applier: TrialApplier = async (fix) => {
      applied.push(fix.description);
    };

    const receipt = await runDebugLoop({
      run,
      propose: proposer,
      apply: applier,
      input: baseInput
    });

    expect(receipt.status).toBe("succeeded");
    expect(receipt.tries).toBe(2);
    expect(applied).toEqual(["add the missing semicolon"]);
    expect(proposerCalls).toHaveLength(1);
    expect(receipt.message).toMatch(/succeeded on try 2/i);
  });

  it("fails closed at maxTries with an explicit fail receipt", async () => {
    const run: CommandRunner = async () => ({
      exitCode: 2,
      stdout: "",
      stderr: "boom"
    });
    const receipt = await runDebugLoop({
      run,
      propose: async () => ({ description: "retry", patch: "" }),
      apply: async () => {},
      input: { Command: "make test", MaxTries: 3 }
    });

    expect(receipt.status).toBe("failed");
    expect(receipt.tries).toBe(3);
    expect(receipt.maxTries).toBe(3);
    expect(receipt.message).toMatch(/exhausted|failed after/i);
    expect(receipt.lastExitCode).toBe(2);
    expect(receipt.lastStderr).toBe("boom");
  });

  it("rolls back a trial when the next run still fails, then continues", async () => {
    let calls = 0;
    const run: CommandRunner = async () => {
      calls += 1;
      // fail, fail, succeed
      return calls < 3
        ? { exitCode: 1, stdout: "", stderr: `err ${calls}` }
        : { exitCode: 0, stdout: "ok", stderr: "" };
    };
    const rollbacks: string[] = [];
    const applier: TrialApplier = async (fix, attempt) => {
      // Return a rollback closure; engine invokes it when the trial fails.
      return async () => {
        rollbacks.push(`${fix.description}@${attempt}`);
      };
    };

    const receipt = await runDebugLoop({
      run,
      propose: async () => ({ description: "fix", patch: "p" }),
      apply: applier,
      input: { Command: "c", MaxTries: 5 }
    });

    expect(receipt.status).toBe("succeeded");
    expect(receipt.tries).toBe(3);
    // The trial applied at the start of attempt 2 (to recover from attempt 1's
    // failure) did not pass, so its rollback was invoked before attempt 3.
    expect(rollbacks).toEqual(["fix@2"]);
  });

  it("stops when no fix can be proposed and reports the unresolved state", async () => {
    const run: CommandRunner = async () => ({ exitCode: 1, stdout: "", stderr: "x" });
    const receipt = await runDebugLoop({
      run,
      propose: async () => null,
      apply: async () => {},
      input: { Command: "c", MaxTries: 5 }
    });

    expect(receipt.status).toBe("failed");
    expect(receipt.tries).toBe(1);
    expect(receipt.message).toMatch(/no fix|could not propose|unresolved/i);
  });

  it("never exceeds maxTries even if every fix fails", async () => {
    let runs = 0;
    const run: CommandRunner = async () => {
      runs += 1;
      return { exitCode: 1, stdout: "", stderr: "x" };
    };
    await runDebugLoop({
      run,
      propose: async () => ({ description: "d", patch: "" }),
      apply: async () => {},
      input: { Command: "c", MaxTries: 2 }
    });
    expect(runs).toBe(2);
  });

  it("rejects a maxTries of 0 by clamping to at least 1", async () => {
    const run: CommandRunner = async () => ({ exitCode: 0, stdout: "ok", stderr: "" });
    const receipt = await runDebugLoop({
      run,
      propose: async () => null,
      apply: async () => {},
      input: { Command: "c", MaxTries: 0 }
    });
    expect(receipt.tries).toBe(1);
    expect(receipt.maxTries).toBeGreaterThanOrEqual(1);
  });
});

describe("debugLoop tool factory — createDebugLoopTool", () => {
  const okResult: CommandRunResult = { exitCode: 0, stdout: "ok", stderr: "" };

  it("throws a clear error when no debug-loop backend is wired", async () => {
    const tool = createDebugLoopTool();
    const result = tool.execute({ Command: "make test" }, {});
    await expect(result).rejects.toThrow(/debug.loop backend/i);
  });

  it("runs to success through an injected backend and returns a structured receipt", async () => {
    const backend: DebugLoopBackend = {
      run: async () => okResult,
      propose: async () => null,
      apply: async () => {}
    };
    const tool = createDebugLoopTool({ backend });
    const out = await tool.execute({ Command: "make test" }, {});
    expect(out.status).toBe("succeeded");
    expect(out.tries).toBe(1);
    expect(out.maxTries).toBe(DEFAULT_DEBUG_LOOP_MAX_TRIES);
    expect(out.command).toBe("make test");
  });

  it("defaults MaxTries to DEFAULT_DEBUG_LOOP_MAX_TRIES when omitted", async () => {
    const backend: DebugLoopBackend = {
      run: async () => ({ exitCode: 1, stdout: "", stderr: "x" }),
      propose: async () => null,
      apply: async () => {}
    };
    const tool = createDebugLoopTool({ backend });
    const out = await tool.execute({ Command: "c" }, {});
    expect(out.maxTries).toBe(DEFAULT_DEBUG_LOOP_MAX_TRIES);
    expect(out.status).toBe("failed");
  });

  it("schema rejects empty command and out-of-range MaxTries", () => {
    expect(() => DebugLoopToolInputSchema.parse({ Command: "" })).toThrow();
    expect(() => DebugLoopToolInputSchema.parse({ Command: "c", MaxTries: 0 })).toThrow();
    expect(() => DebugLoopToolInputSchema.parse({ Command: "c", MaxTries: 51 })).toThrow();
    expect(DebugLoopToolInputSchema.parse({ Command: "c" })).toEqual({ Command: "c" });
  });

  it("exposes the required ToolDefinition fields and a mutating effect", () => {
    const tool = createDebugLoopTool({
      backend: { run: async () => okResult, propose: async () => null, apply: async () => {} }
    });
    expect(tool.id).toBe("debug_loop");
    expect(tool.title).toBeTruthy();
    expect(tool.description).toBeTruthy();
    expect(tool.effect).toBe("mutating");
    expect(typeof tool.execute).toBe("function");
  });
});

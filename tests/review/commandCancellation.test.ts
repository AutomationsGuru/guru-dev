import { describe, expect, it } from "vitest";

import { executeCommand, type CommandExecutionContext } from "../../src/review/gates.js";
import { createPiBashTool } from "../../src/tools/builtins/bashTool.js";

/**
 * Bash cancellation (ADR 2026-07-05, Cluster 3): the child is ACTUALLY killed on
 * timeout/abort — SIGTERM on POSIX, taskkill /T on Windows — and the result says
 * cancelled with the partial output captured before the kill.
 *
 * These tests spawn REAL node children (node is guaranteed present) with short
 * timeouts; the assertions bound wall-clock hard so a broken kill fails fast.
 */

const gate = (command: readonly string[]): CommandExecutionContext["gate"] => ({
  kind: "validation",
  name: "bash",
  command,
  required: true
});

/** A child that prints a marker then sleeps far beyond any test timeout. */
const HANG_SCRIPT = "process.stdout.write('started-marker'); setInterval(() => {}, 1000);";

describe("executeCommand — the kill path", () => {
  it("kills a hung child on timeout and reports cancelled with partial output", async () => {
    const startedAt = Date.now();
    const command = ["node", "-e", HANG_SCRIPT];
    const result = await executeCommand(command, { gate: gate(command), timeoutMs: 1_500 });
    const elapsed = Date.now() - startedAt;

    expect(result.cancelled).toBe(true);
    expect(result.stdout).toContain("started-marker"); // partial output survives
    expect(result.stderr).toContain("timed out");
    expect(result.exitCode === 0).toBe(false);
    // The hang script would run forever; a working kill returns promptly.
    expect(elapsed).toBeLessThan(15_000);
  }, 20_000);

  it("kills the child when the AbortSignal fires", async () => {
    const controller = new AbortController();
    const command = ["node", "-e", HANG_SCRIPT];
    const pending = executeCommand(command, { gate: gate(command), signal: controller.signal });
    setTimeout(() => controller.abort(), 300);
    const result = await pending;

    expect(result.cancelled).toBe(true);
    expect(result.stderr).toContain("aborted");
  }, 20_000);

  it("an already-aborted signal kills immediately", async () => {
    const controller = new AbortController();
    controller.abort();
    const command = ["node", "-e", HANG_SCRIPT];
    const result = await executeCommand(command, { gate: gate(command), signal: controller.signal });
    expect(result.cancelled).toBe(true);
  }, 20_000);

  it("a fast successful command is untouched by the new paths (no cancelled flag)", async () => {
    const command = ["node", "-e", "process.stdout.write('quick-ok')"];
    const result = await executeCommand(command, { gate: gate(command), timeoutMs: 30_000 });
    expect(result.cancelled).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("quick-ok");
  }, 20_000);
});

describe("bashTool — cancellation surface", () => {
  it("a timed-out command returns cancelled:true with the KILLED summary and partial output", async () => {
    const tool = createPiBashTool({ shellAllowlist: ["node"] });
    const result = await tool.execute({
      repoRoot: process.cwd(),
      command: "node",
      args: ["-e", HANG_SCRIPT],
      timeoutMs: 1_500,
      maxOutputBytes: 64_000,
      dryRun: false
    }, {});
    expect(result.executed).toBe(true);
    expect(result.cancelled).toBe(true);
    expect(result.summary).toContain("KILLED");
    expect(result.stdout).toContain("started-marker");
  }, 20_000);

  it("normal completion reports cancelled:false", async () => {
    const tool = createPiBashTool({ shellAllowlist: ["node"] });
    const result = await tool.execute({
      repoRoot: process.cwd(),
      command: "node",
      args: ["-e", "process.stdout.write('done')"],
      timeoutMs: 30_000,
      maxOutputBytes: 64_000,
      dryRun: false
    }, {});
    expect(result.cancelled).toBe(false);
    expect(result.exitCode).toBe(0);
  }, 20_000);

  it("BACKSTOP: a hung custom executor that ignores the timeout contract still resolves cancelled:true", async () => {
    const tool = createPiBashTool({
      shellAllowlist: ["node"],
      executor: () => new Promise(() => undefined) // never resolves, ignores timeoutMs
    });
    const result = await tool.execute({
      repoRoot: process.cwd(),
      command: "node",
      args: ["-e", "1"],
      timeoutMs: 1_000,
      maxOutputBytes: 64_000,
      dryRun: false
    }, {});
    expect(result.cancelled).toBe(true); // resolves the contract shape — never throws
    expect(result.stderr).toContain("Backstop timeout");
  }, 20_000);

  it("dry-run and blocked paths carry cancelled:false (schema completeness)", async () => {
    const tool = createPiBashTool({ shellAllowlist: ["node"] });
    const dry = await tool.execute({
      repoRoot: process.cwd(),
      command: "node",
      args: ["-e", "1"],
      timeoutMs: 1_000,
      maxOutputBytes: 64_000,
      dryRun: true
    }, {});
    expect(dry.cancelled).toBe(false);
    const blocked = await tool.execute({
      repoRoot: process.cwd(),
      command: "not-allowlisted-exe",
      args: [],
      timeoutMs: 1_000,
      maxOutputBytes: 64_000,
      dryRun: false
    }, {});
    expect(blocked.cancelled).toBe(false);
    expect(blocked.executed).toBe(false);
  }, 20_000);
});

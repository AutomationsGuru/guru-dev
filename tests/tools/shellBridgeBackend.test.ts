import { MockShellBackend } from '../../src/tools/shellBridgeBackend.js';
import type { ShellBackend } from '../../src/tools/shellBridgeBackend.js';
import type { CommandExecutionContext, CommandExecutionResult } from '../../src/review/gates.js';

function makeContext(overrides?: Partial<CommandExecutionContext>): CommandExecutionContext {
  return {
    gate: { kind: "validation", name: "test.gate", command: ["true"], required: false },
    ...overrides,
  };
}

function makeResult(overrides?: Partial<CommandExecutionResult>): CommandExecutionResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 1,
    ...overrides,
  };
}

describe("ShellBackend", () => {
  it("MockShellBackend records calls — command and context captured", async () => {
    const backend = new MockShellBackend();
    const ctx = makeContext({ cwd: "/tmp/test" });

    await backend.runCommand(["echo", "hello"], ctx);

    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]?.command).toEqual(["echo", "hello"]);
    expect(backend.calls[0]?.context.cwd).toBe("/tmp/test");
    expect(backend.calls[0]?.context.gate.name).toBe("test.gate");
  });

  it("MockShellBackend records multiple calls in order", async () => {
    const backend = new MockShellBackend();

    await backend.runCommand(["first"], makeContext());
    await backend.runCommand(["second"], makeContext());
    await backend.runCommand(["third"], makeContext());

    expect(backend.calls).toHaveLength(3);
    expect(backend.calls.map((c) => c.command[0])).toEqual(["first", "second", "third"]);
  });

  it("MockShellBackend returns exitCode 0 by default", async () => {
    const backend = new MockShellBackend();

    const result = await backend.runCommand(["echo"], makeContext());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.durationMs).toBe(1);
  });

  it("MockShellBackend propagates configured exit code", async () => {
    const backend = new MockShellBackend(makeResult({ exitCode: 1, stderr: "error" }));

    const result = await backend.runCommand(["failing"], makeContext());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("error");
  });

  it("MockShellBackend propagates stdout and duration from configured result", async () => {
    const backend = new MockShellBackend(
      makeResult({ exitCode: 0, stdout: "hello world", durationMs: 42 }),
    );

    const result = await backend.runCommand(["echo", "hello"], makeContext());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello world");
    expect(result.durationMs).toBe(42);
  });

  it("MockShellBackend propagates signal and cancelled flags", async () => {
    const backend = new MockShellBackend(
      makeResult({ exitCode: null, signal: "SIGTERM", cancelled: true }),
    );

    const result = await backend.runCommand(["hanging"], makeContext());

    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    expect(result.cancelled).toBe(true);
  });

  it("MockShellBackend setDefaultResult updates subsequent return values", async () => {
    const backend = new MockShellBackend();

    // First call returns the original default.
    const first = await backend.runCommand(["first"], makeContext());
    expect(first.exitCode).toBe(0);

    // Update the default — subsequent calls pick it up.
    backend.setDefaultResult(makeResult({ exitCode: 2, stdout: "changed" }));

    const second = await backend.runCommand(["second"], makeContext());
    expect(second.exitCode).toBe(2);
    expect(second.stdout).toBe("changed");

    // The first call is still recorded.
    expect(backend.calls).toHaveLength(2);
  });

  it("MockShellBackend captures timeoutMs from execution context", async () => {
    const backend = new MockShellBackend();
    const ctx = makeContext({ timeoutMs: 30_000 });

    await backend.runCommand(["long-running"], ctx);

    expect(backend.calls[0]?.context.timeoutMs).toBe(30_000);
  });

  it("MockShellBackend captures AbortSignal from execution context", async () => {
    const backend = new MockShellBackend();
    const controller = new AbortController();
    const ctx = makeContext({ signal: controller.signal });

    await backend.runCommand(["abortable"], ctx);

    expect(backend.calls[0]?.context.signal).toBe(controller.signal);
  });

  it("ShellBackend interface is structurally compatible with CommandExecutor", async () => {
    // Verify that a ShellBackend satisfies the shape of CommandExecutor
    // without a runtime cast — the async function returns the right type.
    const backend: ShellBackend = new MockShellBackend();

    const result: CommandExecutionResult = await backend.runCommand(
      ["true"],
      makeContext(),
    );

    expect(result).toHaveProperty("exitCode");
    expect(result).toHaveProperty("stdout");
    expect(result).toHaveProperty("stderr");
    expect(result).toHaveProperty("durationMs");
  });
});

import type { CommandExecutionContext, CommandExecutionResult } from "../review/gates.js";

/**
 * Shell bridge backend: abstracts command execution behind an interface so
 * the shell tool can swap between a real OS backend and a mock backend for
 * deterministic tests.
 *
 * Part of the GuruHarness tool extension seam: new backends register through
 * this interface without editing core shell-tool logic.
 */
export interface ShellBackend {
  /** Execute a command and return its result. Same contract as CommandExecutor. */
  runCommand(
    command: readonly string[],
    context: CommandExecutionContext,
  ): Promise<CommandExecutionResult>;
}

/**
 * Mock shell backend that records every call and returns a configurable
 * result. Useful for tests that need to assert exact commands and exit codes
 * without touching a real subprocess.
 */
export class MockShellBackend implements ShellBackend {
  /** Every call made through this mock, in order. */
  readonly calls: Array<{
    readonly command: readonly string[];
    readonly context: CommandExecutionContext;
  }> = [];

  private defaultResult: CommandExecutionResult;

  constructor(defaultResult?: CommandExecutionResult) {
    this.defaultResult = defaultResult ?? {
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 1,
    };
  }

  /**
   * Set the result that subsequent (unconfigured) calls will return.
   * Mutates the default — callers that need per-call results should
   * replace the mock instance or extend this class.
   */
  setDefaultResult(result: CommandExecutionResult): void {
    this.defaultResult = result;
  }

  async runCommand(
    command: readonly string[],
    context: CommandExecutionContext,
  ): Promise<CommandExecutionResult> {
    this.calls.push({ command, context });
    return { ...this.defaultResult };
  }
}

import { spawn } from "node:child_process";

import type { HarnessConfig, ReviewGate, ValidationCommand } from "../config/schema.js";

export type ReviewGateVerdict = "GREEN" | "YELLOW" | "RED";
export type GateKind = "validation" | "review";
export type GateStatus = "passed" | "failed";

export interface CommandExecutionContext {
  readonly cwd?: string;
  readonly gate: CommandGate;
  /**
   * Kill the child when this elapses (ADR 2026-07-05): SIGTERM on POSIX,
   * `taskkill /T /F` on Windows (the process TREE — cmd.exe shims spawn
   * grandchildren). The promise resolves with `cancelled: true` + partial output.
   */
  readonly timeoutMs?: number;
  /** Abort seam: an external abort kills the child the same way. */
  readonly signal?: AbortSignal;
}

export interface CommandExecutionResult {
  readonly exitCode: number | null;
  readonly signal?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  /** True when the child was killed by timeout or abort; output is partial. */
  readonly cancelled?: boolean;
}

export type CommandExecutor = (
  command: readonly string[],
  context: CommandExecutionContext
) => Promise<CommandExecutionResult>;

export interface CommandGate {
  readonly kind: GateKind;
  readonly name: string;
  readonly command: readonly string[];
  readonly required: boolean;
}

export interface CommandGateResult extends CommandGate, CommandExecutionResult {
  readonly status: GateStatus;
  readonly summary: string;
}

export interface ReviewGatesReport {
  readonly verdict: ReviewGateVerdict;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly results: readonly CommandGateResult[];
  readonly passed: number;
  readonly failed: number;
  readonly summary: string;
}

export interface RunReviewGatesOptions {
  readonly cwd?: string;
  readonly includeReviewGate?: boolean;
  readonly executor?: CommandExecutor;
}

export async function runReviewGates(
  config: HarnessConfig,
  options: RunReviewGatesOptions = {}
): Promise<ReviewGatesReport> {
  const startedAtDate = new Date();
  const gates = createCommandGates(config, options.includeReviewGate ?? true);
  const executor = options.executor ?? executeCommand;
  const results: CommandGateResult[] = [];

  for (const gate of gates) {
    results.push(await runCommandGate(gate, executor, options.cwd));
  }

  return buildReviewGatesReport(startedAtDate, results);
}

export function createCommandGates(config: HarnessConfig, includeReviewGate: boolean): readonly CommandGate[] {
  const validationGates = config.validationCommands.map(toValidationGate);
  const reviewGates = includeReviewGate ? [toReviewGate(config.reviewGate)] : [];

  return [...validationGates, ...reviewGates];
}

export async function runCommandGate(
  gate: CommandGate,
  executor: CommandExecutor = executeCommand,
  cwd?: string
): Promise<CommandGateResult> {
  const execution = await executeGateCommand(gate, executor, cwd);
  const status: GateStatus = execution.exitCode === 0 ? "passed" : "failed";

  return {
    ...gate,
    ...execution,
    status,
    summary: buildCommandSummary(gate, status, execution)
  };
}

export async function executeCommand(
  command: readonly string[],
  context: CommandExecutionContext
): Promise<CommandExecutionResult> {
  const startedAt = Date.now();
  const [executable, ...args] = command;

  if (!executable) {
    return {
      exitCode: null,
      stdout: "",
      stderr: "Command is empty.",
      durationMs: Date.now() - startedAt
    };
  }

  // Windows: bare tool names (npm, coderabbit) resolve to .cmd shims that cannot be
  // spawned with shell:false — the child dies instantly with a null exit code. Route
  // them through cmd.exe with a fixed argv (no shell-string interpolation), same
  // pattern as the provider-CLI delegate.
  const needsCmdShell =
    process.platform === "win32" && !/\.exe$/iu.test(executable) && !executable.includes("/") && !executable.includes("\\");

  return new Promise<CommandExecutionResult>((resolveExecution) => {
    const child = needsCmdShell
      ? spawn("cmd.exe", ["/c", executable, ...args], { cwd: context.cwd, shell: false, windowsHide: true })
      : spawn(executable, args, { cwd: context.cwd, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let cancelled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let escalateTimer: NodeJS.Timeout | undefined;

    // The kill path (ADR 2026-07-05): actually terminate the child — never abandon
    // it. Windows kills the process TREE (cmd.exe shims spawn grandchildren).
    const killChild = (reason: string): void => {
      if (settled || cancelled) {
        return;
      }
      // Kill/close race: the child may have ALREADY exited naturally with its
      // 'close' event still in flight — don't mislabel a completed run as
      // cancelled (adversarial review 2026-07-05).
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      cancelled = true;
      stderr = appendLine(stderr, reason);
      if (process.platform === "win32" && child.pid !== undefined) {
        // taskkill failure surfaces via the ChildProcess error EVENT, not a throw
        // (CodeRabbit 2026-07-05) — fall back to SIGTERM explicitly.
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true });
        killer.on("error", () => child.kill("SIGTERM"));
      } else {
        child.kill("SIGTERM");
        // SIGTERM-resistant children would hang the resolve forever — escalate
        // to SIGKILL after a short grace (CodeRabbit 2026-07-05).
        escalateTimer = setTimeout(() => {
          if (!settled) {
            child.kill("SIGKILL");
          }
        }, 2_000);
      }
    };

    if (context.timeoutMs !== undefined) {
      killTimer = setTimeout(() => killChild(`Command timed out after ${context.timeoutMs}ms and was killed.`), context.timeoutMs);
    }
    const onAbort = (): void => killChild("Command was aborted and killed.");
    if (context.signal) {
      if (context.signal.aborted) {
        onAbort();
      } else {
        context.signal.addEventListener("abort", onAbort, { once: true });
      }
    }
    const cleanup = (): void => {
      if (killTimer) {
        clearTimeout(killTimer);
      }
      if (escalateTimer) {
        clearTimeout(escalateTimer);
      }
      context.signal?.removeEventListener("abort", onAbort);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolveExecution({
        exitCode: null,
        stdout,
        stderr: appendLine(stderr, formatError(error)),
        durationMs: Date.now() - startedAt,
        ...(cancelled ? { cancelled: true } : {})
      });
    });
    child.on("close", (exitCode, signal) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      const result = {
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        ...(cancelled ? { cancelled: true } : {})
      } satisfies Omit<CommandExecutionResult, "signal">;

      resolveExecution(signal ? { ...result, signal } : result);
    });
  });
}

function toValidationGate(command: ValidationCommand): CommandGate {
  return {
    kind: "validation",
    name: command.name,
    command: command.command,
    required: command.required
  };
}

function toReviewGate(reviewGate: ReviewGate): CommandGate {
  return {
    kind: "review",
    name: reviewGate.provider,
    command: reviewGate.command,
    required: reviewGate.required
  };
}

async function executeGateCommand(
  gate: CommandGate,
  executor: CommandExecutor,
  cwd: string | undefined
): Promise<CommandExecutionResult> {
  try {
    return await executor(gate.command, cwd ? { cwd, gate } : { gate });
  } catch (error) {
    return {
      exitCode: null,
      stdout: "",
      stderr: formatError(error),
      durationMs: 0
    };
  }
}

function buildReviewGatesReport(startedAtDate: Date, results: readonly CommandGateResult[]): ReviewGatesReport {
  const endedAtDate = new Date();
  const failed = results.filter((result) => result.status === "failed").length;
  const passed = results.length - failed;
  const verdict = deriveVerdict(results);

  return {
    verdict,
    startedAt: startedAtDate.toISOString(),
    endedAt: endedAtDate.toISOString(),
    durationMs: Math.max(0, endedAtDate.getTime() - startedAtDate.getTime()),
    results,
    passed,
    failed,
    summary: buildReportSummary(verdict, passed, failed)
  };
}

function deriveVerdict(results: readonly CommandGateResult[]): ReviewGateVerdict {
  if (results.length === 0) {
    return "YELLOW";
  }

  if (results.some((result) => result.required && result.status === "failed")) {
    return "RED";
  }

  if (results.some((result) => result.status === "failed")) {
    return "YELLOW";
  }

  return "GREEN";
}

function buildReportSummary(verdict: ReviewGateVerdict, passed: number, failed: number): string {
  return `${verdict}: ${passed} gate(s) passed, ${failed} gate(s) failed.`;
}

function buildCommandSummary(gate: CommandGate, status: GateStatus, execution: CommandExecutionResult): string {
  const exitDescription = execution.exitCode === null ? "no exit code" : `exit ${execution.exitCode}`;

  return `${gate.name} ${status} (${exitDescription}).`;
}

function appendLine(existing: string, line: string): string {
  return existing ? `${existing}\n${line}` : line;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

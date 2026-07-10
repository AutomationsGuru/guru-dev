import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import type { HarnessConfig, ReviewGate, ValidationCommand } from "../config/schema.js";

/**
 * PATH-probe: is a command present? (P0) — the basis of attach-if-present overlays
 * (e.g. append gh only when installed), never assumed. Presence only.
 */
export function commandExists(name: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

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

/** Default TEST-gate timeout — a hung `npm test` must not stall the self-build loop forever. */
export const DEFAULT_GATE_TIMEOUT_MS = 600_000;

export interface CommandGate {
  readonly kind: GateKind;
  readonly name: string;
  readonly command: readonly string[];
  readonly required: boolean;
  /** The native critic panel (P1): run via an injected model reviewer, NOT a shell command. */
  readonly native?: boolean;
  /** Kill the gate subprocess after this many ms (default applied for discovered validation gates). */
  readonly timeoutMs?: number;
}

/** Runs guru's OWN model-powered review for a native gate (no external tool). Injected by the caller. */
export type NativeReviewer = (gate: CommandGate, cwd?: string) => Promise<CommandGateResult>;

export interface CommandGateResult extends CommandGate, CommandExecutionResult {
  readonly status: GateStatus;
  readonly summary: string;
  /** Explicit GREEN/YELLOW/RED (the native panel emits YELLOW on medium-only findings). */
  readonly verdict?: ReviewGateVerdict;
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
  /** Runs a native-critic-panel gate (P1). Absent → the native gate degrades to YELLOW, never RED-by-absence. */
  readonly nativeReviewer?: NativeReviewer;
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
    if (gate.native) {
      // guru's own model-powered review — never a shell command. With no reviewer wired it
      // degrades to YELLOW (honest "not run"), never a silent pass or a RED-by-absence.
      results.push(options.nativeReviewer ? await options.nativeReviewer(gate, options.cwd) : nativeGateUnavailable(gate));
    } else {
      results.push(await runCommandGate(gate, executor, options.cwd));
    }
  }

  return buildReviewGatesReport(startedAtDate, results);
}

/** A native gate with no reviewer wired: YELLOW (couldn't run) — honest, not a pass, not RED-by-absence. */
function nativeGateUnavailable(gate: CommandGate): CommandGateResult {
  return {
    ...gate,
    exitCode: null,
    stdout: "",
    stderr: "native critic panel not wired (no model reviewer provided)",
    durationMs: 0,
    status: "failed",
    verdict: "YELLOW",
    summary: `${gate.name}: not run — native review reviewer not wired (YELLOW).`
  };
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

/**
 * Resolve a gate argv for Windows under Node 20+ / 24:
 * - CVE-2024-27980: Node refuses to spawn `.cmd`/`.bat` with `shell:false` (EINVAL).
 * - Blindly rewriting bare names to `name.cmd` broke `node` (native `.exe`) and every
 *   hang/cancel test that spawns `node -e …`.
 * Strategy: prefer a real `.exe` from `where`; rewrite known package-manager shims to
 * `node <cli.js>`; otherwise keep the bare name (Node resolves `node`/`git` fine).
 * Never uses `cmd.exe /c`.
 */
function listWhereMatches(name: string): string[] {
  try {
    const out = execFileSync("where.exe", [name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    });
    return out
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function packageManagerCliJs(id: "npm" | "npx"): string | undefined {
  // Sibling of the running node.exe — standard Node for Windows layout.
  const candidate = join(dirname(process.execPath), "node_modules", "npm", "bin", `${id === "npm" ? "npm" : "npx"}-cli.js`);
  return existsSync(candidate) ? candidate : undefined;
}

export function resolveWindowsGateSpawn(command: readonly string[]): { executable: string; args: string[] } {
  const [executable, ...args] = command;
  if (!executable) {
    return { executable: "", args: [] };
  }
  if (process.platform !== "win32") {
    return { executable, args: [...args] };
  }

  // Absolute/relative path already chosen by the caller.
  if (executable.includes("/") || executable.includes("\\") || /^[A-Za-z]:/.test(executable)) {
    // Refuse bare .cmd/.bat paths under shell:false — rewrite npm-cli if recognizable.
    if (/\.(?:cmd|bat)$/iu.test(executable)) {
      const base = executable.replace(/\.(?:cmd|bat)$/iu, "").toLowerCase();
      if (base.endsWith("npm") || base.endsWith("\\npm") || base.endsWith("/npm")) {
        const cli = packageManagerCliJs("npm");
        if (cli) return { executable: process.execPath, args: [cli, ...args] };
      }
      if (base.endsWith("npx") || base.endsWith("\\npx") || base.endsWith("/npx")) {
        const cli = packageManagerCliJs("npx");
        if (cli) return { executable: process.execPath, args: [cli, ...args] };
      }
    }
    return { executable, args: [...args] };
  }

  if (/\.exe$/iu.test(executable)) {
    return { executable, args: [...args] };
  }
  // Explicit .cmd/.bat bare names — never spawn them shell:false on Node 20+.
  if (/\.(?:cmd|bat)$/iu.test(executable)) {
    const bare = executable.replace(/\.(?:cmd|bat)$/iu, "");
    return resolveWindowsGateSpawn([bare, ...args]);
  }

  const lower = executable.toLowerCase();
  if (lower === "npm" || lower === "npx") {
    const cli = packageManagerCliJs(lower);
    if (cli) {
      return { executable: process.execPath, args: [cli, ...args] };
    }
  }

  const matches = listWhereMatches(executable);
  const exeMatch = matches.find((m) => /\.exe$/iu.test(m));
  if (exeMatch) {
    return { executable: exeMatch, args: [...args] };
  }

  // Bare name: Node can resolve many PATH .exe entries (node, git, …) without a suffix.
  return { executable, args: [...args] };
}

export async function executeCommand(
  command: readonly string[],
  context: CommandExecutionContext
): Promise<CommandExecutionResult> {
  const startedAt = Date.now();
  const [rawExecutable] = command;

  if (!rawExecutable) {
    return {
      exitCode: null,
      stdout: "",
      stderr: "Command is empty.",
      durationMs: Date.now() - startedAt
    };
  }

  // Never shell out via `cmd.exe /c <dynamic>` (CodeQL js/shell-command-injection-
  // from-environment). Resolve to a real PE or node+cli.js — not a batch shim.
  const { executable: resolvedExecutable, args } = resolveWindowsGateSpawn(command);

  return new Promise<CommandExecutionResult>((resolveExecution) => {
    const child = spawn(resolvedExecutable, args, { cwd: context.cwd, shell: false, windowsHide: true });
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
        // (review 2026-07-05) — fall back to SIGTERM explicitly.
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true });
        killer.on("error", () => child.kill("SIGTERM"));
      } else {
        child.kill("SIGTERM");
        // SIGTERM-resistant children would hang the resolve forever — escalate
        // to SIGKILL after a short grace (review 2026-07-05).
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
    required: command.required,
    // Bound every discovered gate so a hung suite cannot stall the loop forever.
    timeoutMs: DEFAULT_GATE_TIMEOUT_MS
  };
}

function toReviewGate(reviewGate: ReviewGate): CommandGate {
  if (reviewGate.provider === "native-critic-panel") {
    // guru's OWN model-powered review — no shell command; run via the injected NativeReviewer.
    return { kind: "review", name: reviewGate.provider, command: [], required: reviewGate.required, native: true };
  }
  return {
    kind: "review",
    name: reviewGate.provider,
    command: reviewGate.command ?? [],
    required: reviewGate.required
  };
}

async function executeGateCommand(
  gate: CommandGate,
  executor: CommandExecutor,
  cwd: string | undefined
): Promise<CommandExecutionResult> {
  try {
    const base = {
      gate,
      ...(gate.timeoutMs !== undefined ? { timeoutMs: gate.timeoutMs } : {})
    };
    return await executor(gate.command, cwd ? { ...base, cwd } : base);
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

/** A gate's effective verdict: its explicit `verdict` (native panel) if set, else from status/required. */
function gateVerdict(result: CommandGateResult): ReviewGateVerdict {
  if (result.verdict) {
    return result.verdict;
  }
  if (result.status === "failed") {
    return result.required ? "RED" : "YELLOW";
  }
  return "GREEN";
}

function deriveVerdict(results: readonly CommandGateResult[]): ReviewGateVerdict {
  if (results.length === 0) {
    return "YELLOW";
  }
  const verdicts = results.map(gateVerdict);
  if (verdicts.includes("RED")) {
    return "RED";
  }
  if (verdicts.includes("YELLOW")) {
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

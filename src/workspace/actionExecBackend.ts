import { spawn } from "node:child_process";
import { z } from "zod";

/**
 * Result of running a single stateless command through an action execution backend.
 * Mirrors the shape of {@link CommandExecutionResult} from review/gates.ts
 * to keep downstream consumers and tool wrappers consistent.
 */
export interface ActionExecResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  /** True when the child was killed by timeout or abort; output is partial. */
  readonly cancelled: boolean;
}

export const ActionExecResultSchema = z
  .object({
    exitCode: z.number().int().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    durationMs: z.number().int().nonnegative(),
    cancelled: z.boolean()
  })
  .strict();

/**
 * Options passed to every {@link ActionExecBackend.run} call.
 */
export interface ActionExecOptions {
  cmd: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export const ActionExecOptionsSchema = z
  .object({
    cmd: z.array(z.string().trim().min(1)).min(1),
    cwd: z.string().trim().min(1),
    env: z.record(z.string(), z.string()).optional(),
    timeoutMs: z.number().int().positive().max(300_000).optional(),
    signal: z.instanceof(AbortSignal).optional()
  })
  .strict();

/**
 * Tag discriminating concrete backend implementations so operators and
 * diagnostics can report which backend executed an action.
 */
export type ActionExecBackendKind = "local" | "docker-later";

/**
 * A swappable backend that runs a single command per call — no persistent shell
 * session, no sticky state or cwd, no implicit environment. Each `run()` is an
 * independent subprocess.
 *
 * This is the env-backend seam from F38/F78: implementations include
 * `createLocalActionExecBackend` (local subprocess-equivalent) and a future
 * `createDockerActionExecBackend` (containerized). Tool layers and agent loops
 * consume the interface, never the concrete factory.
 */
export interface ActionExecBackend {
  readonly kind: ActionExecBackendKind;
  run(options: ActionExecOptions): Promise<ActionExecResult>;
}

// ── local backend ──────────────────────────────────────────────────────────

/**
 * Default local implementation: runs each command as a direct child process via
 * `spawn(shell=false)`. Every call is independent — no sticky cwd, no inherited
 * shell state, no environment leakage between runs.
 *
 * Timeout handling: SIGTERM → 2 s grace → SIGKILL (same kill contract as the
 * review/gates.ts executor). AbortSignal support via the same path.
 */
export function createLocalActionExecBackend(): ActionExecBackend {
  return {
    kind: "local",
    async run(options: ActionExecOptions): Promise<ActionExecResult> {
      const startedAt = Date.now();
      const [executable, ...args] = options.cmd;

      if (!executable) {
        return {
          exitCode: null,
          stdout: "",
          stderr: "Command is empty.",
          durationMs: Date.now() - startedAt,
          cancelled: false
        };
      }

      return new Promise<ActionExecResult>((resolve) => {
        const child = spawn(executable, args, {
          cwd: options.cwd,
          env: options.env ?? process.env,
          shell: false,
          windowsHide: true
        });

        let stdout = "";
        let stderr = "";
        let settled = false;
        let cancelled = false;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        let escalateTimer: ReturnType<typeof setTimeout> | undefined;

        const killChild = (reason: string): void => {
          if (settled || cancelled) return;
          // Don't mislabel a naturally-exited child as cancelled.
          if (child.exitCode !== null || child.signalCode !== null) return;
          cancelled = true;
          stderr = stderr ? `${stderr}\n${reason}` : reason;
          if (process.platform === "win32" && child.pid !== undefined) {
            const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true });
            killer.on("error", () => child.kill("SIGTERM"));
          } else {
            child.kill("SIGTERM");
            escalateTimer = setTimeout(() => {
              if (!settled) child.kill("SIGKILL");
            }, 2_000);
          }
        };

        if (options.timeoutMs !== undefined) {
          killTimer = setTimeout(() => killChild(`Command timed out after ${options.timeoutMs}ms and was killed.`), options.timeoutMs);
        }

        const onAbort = (): void => killChild("Command was aborted and killed.");
        if (options.signal) {
          if (options.signal.aborted) {
            onAbort();
          } else {
            options.signal.addEventListener("abort", onAbort, { once: true });
          }
        }

        const cleanup = (): void => {
          if (killTimer) clearTimeout(killTimer);
          if (escalateTimer) clearTimeout(escalateTimer);
          options.signal?.removeEventListener("abort", onAbort);
        };

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => { stdout += chunk; });
        child.stderr.on("data", (chunk: string) => { stderr += chunk; });

        child.on("error", (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({
            exitCode: null,
            stdout,
            stderr: stderr ? `${stderr}\n${formatError(error)}` : formatError(error),
            durationMs: Date.now() - startedAt,
            cancelled
          });
        });

        child.on("close", (exitCode) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({
            exitCode,
            stdout,
            stderr,
            durationMs: Date.now() - startedAt,
            cancelled
          });
        });
      });
    }
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
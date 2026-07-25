import { z } from "zod";
import {
  type ActionExecBackend,
  type ActionExecOptions,
  type ActionExecResult,
  createLocalActionExecBackend
} from "./actionExecBackend.js";

/**
 * A single stateless action to run — an independent command with its own
 * working directory, environment, and timeout. No sticky shell state.
 */
export interface StatelessAction {
  cmd: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

export const StatelessActionSchema = z
  .object({
    cmd: z.array(z.string().trim().min(1)).min(1),
    cwd: z.string().trim().min(1),
    env: z.record(z.string(), z.string()).optional(),
    timeoutMs: z.number().int().positive().max(300_000).optional()
  })
  .strict();

/**
 * Executed action result — the original action bundled with its execution
 * outcome so consumers can correlate input ↔ output without threading
 * state through the backend.
 */
export interface StatelessActionResult {
  action: StatelessAction;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly cancelled: boolean;
}

export const StatelessActionResultSchema = z
  .object({
    action: StatelessActionSchema,
    exitCode: z.number().int().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    durationMs: z.number().int().nonnegative(),
    cancelled: z.boolean()
  })
  .strict();

/**
 * Optional hook for classifying commands that MUST NOT proceed in any
 * backend. If the classifier returns a string, that string becomes the
 * blocker message and execution is skipped entirely (fail-closed).
 *
 * The design intent is that hard-limit enforcement (secrets, destruction
 * policy, etc.) runs here BEFORE the backend, so no backend — local or
 * container — can route around constitution rules.
 */
export type StatelessActionBlocker = (action: StatelessAction) => string | null;

/**
 * Stateless action executor — takes a swappable backend and an optional
 * blocker hook, then executes actions one-at-a-time with no cross-call
 * contamination. Each action runs in its own subprocess; cwd resets to the
 * action's explicit value every call.
 */
export interface StatelessActionExecutor {
  /** Run one action; fails closed on blocker match. */
  run(action: StatelessAction, signal?: AbortSignal): Promise<StatelessActionResult>;
}

export interface StatelessActionExecutorOptions {
  backend?: ActionExecBackend;
  /** Optional hard-limit command-class blocker — fail-closed, evaluated first. */
  blocker?: StatelessActionBlocker;
}

/**
 * Create the default stateless action executor backed by a local subprocess
 * backend. Pass a custom `backend` for containerized execution (docker-later).
 */
export function createStatelessActionExecutor(
  options: StatelessActionExecutorOptions = {}
): StatelessActionExecutor {
  const backend = options.backend ?? createLocalActionExecBackend();
  const blocker = options.blocker;

  return {
    async run(action: StatelessAction, signal?: AbortSignal): Promise<StatelessActionResult> {
      const parsed = StatelessActionSchema.safeParse(action);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        return {
          action,
          exitCode: null,
          stdout: "",
          stderr: `Invalid action: ${issues}`,
          durationMs: 0,
          cancelled: false
        };
      }

      // Coerce parsed Zod output (T | undefined for optional fields)
      // into a clean StatelessAction matching exactOptionalPropertyTypes.
      const cleanAction: StatelessAction = {
        cmd: parsed.data.cmd,
        cwd: parsed.data.cwd
      };
      if (parsed.data.env !== undefined) {
        cleanAction.env = parsed.data.env;
      }
      if (parsed.data.timeoutMs !== undefined) {
        cleanAction.timeoutMs = parsed.data.timeoutMs;
      }

      if (blocker) {
        const blockReason = blocker(cleanAction);
        if (blockReason !== null) {
          return {
            action: cleanAction,
            exitCode: null,
            stdout: "",
            stderr: `Blocked: ${blockReason}`,
            durationMs: 0,
            cancelled: false
          };
        }
      }

      const backendOptions: ActionExecOptions = {
        cmd: cleanAction.cmd,
        cwd: cleanAction.cwd
      };
      if (cleanAction.env !== undefined) {
        backendOptions.env = cleanAction.env;
      }
      if (cleanAction.timeoutMs !== undefined) {
        backendOptions.timeoutMs = cleanAction.timeoutMs;
      }
      if (signal !== undefined) {
        backendOptions.signal = signal;
      }

      const result: ActionExecResult = await backend.run(backendOptions);

      return {
        action: cleanAction,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        cancelled: result.cancelled
      };
    }
  };
}
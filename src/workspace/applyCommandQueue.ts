import { spawn } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import {
  ApplyCommandSchema,
  type ApplyCommand,
  type ApplyCommandQueueEntry,
  type ApplyCommandQueueResult,
  type ApplyCommandResult
} from "./applyCommandQueueSchema.js";

/**
 * Apply command queue — IDEA-F9 (`R-PD-CMDQ`).
 *
 * Optional staged command queue tied to pending/file apply. Commands run only
 * after a successful file apply; on failure the file apply is rolled back from
 * its backups when the command's rollback policy is `require`.
 *
 * Independence by design: this module consumes a structural
 * `CommandApplyOutcome` (the F4 `PendingSandboxApplyResult` shape) without
 * importing the F4 pending sandbox, so it composes with it when F4 lands and
 * stays testable until then. Execution is bounded (schema-capped timeout,
 * argv-only spawn with no shell, repo-contained cwd, size-capped captured
 * output) — no approval prompts are added and no hard limit is touched;
 * rollback only restores prior state that the apply step already preserved.
 */

/** Structural outcome of a single file apply (matches F4's apply result shape). */
export interface CommandApplyOutcome {
  readonly path: string;
  readonly applied: boolean;
  /** Repo-root-relative backup path preserving prior state; absent for create ops. */
  readonly backupPath?: string;
  readonly blockers: readonly string[];
}

export interface ApplyCommandQueueOptions {
  readonly repoRoot: string;
  /** Injectable clock (ISO-8601) for staging timestamps. */
  readonly now?: () => string;
}

export interface ApplyCommandQueue {
  /** Validate and stage a command; returns the durable entry. Nothing executes. */
  stage(command: unknown): ApplyCommandQueueEntry;
  /** Execute staged commands post-apply. Skips cleanly when there is nothing to do. */
  executeAfterApply(
    outcomes: readonly CommandApplyOutcome[],
    commands?: readonly unknown[]
  ): Promise<ApplyCommandQueueResult>;
}

/** Cap captured stdout/stderr so a noisy child cannot exhaust memory. */
const CAPTURE_LIMIT_BYTES = 1_048_576;

export function createApplyCommandQueue(options: ApplyCommandQueueOptions): ApplyCommandQueue {
  const repoRoot = resolve(options.repoRoot);
  const now = options.now ?? (() => new Date().toISOString());
  let sequence = 0;
  const staged: ApplyCommandQueueEntry[] = [];

  function stage(command: unknown): ApplyCommandQueueEntry {
    const parsed = ApplyCommandSchema.parse(command);
    const entry: ApplyCommandQueueEntry = {
      ...parsed,
      id: `cmdq-${++sequence}-${createHash("sha256").update(parsed.argv.join(" ")).digest("hex").slice(0, 12)}`,
      createdAt: now()
    };
    staged.push(entry);
    return entry;
  }

  function resolveCwd(cwd: string): string {
    const target = resolve(repoRoot, cwd);
    const rel = relative(repoRoot, target);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Apply command cwd escapes repoRoot: ${cwd}`);
    }
    return target;
  }

  function runCommand(command: ApplyCommand): Promise<ApplyCommandResult> {
    const cwd = resolveCwd(command.cwd);
    const started = Date.now();
    return new Promise((resolvePromise) => {
      let settled = false;
      const finish = (result: Omit<ApplyCommandResult, "durationMs">): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolvePromise({ ...result, durationMs: Date.now() - started });
      };

      let child;
      try {
        child = spawn(command.argv[0]!, command.argv.slice(1), { cwd, shell: false });
      } catch (error) {
        // Synchronous spawn failure (e.g. bad cwd resolved above).
        finish({
          id: "",
          argv: command.argv,
          cwd: command.cwd,
          status: "failed",
          exitCode: null,
          stdout: "",
          stderr: "",
          error: error instanceof Error ? error.message : String(error)
        });
        return;
      }

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < CAPTURE_LIMIT_BYTES) {
          stdout = (stdout + chunk.toString("utf8")).slice(0, CAPTURE_LIMIT_BYTES);
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < CAPTURE_LIMIT_BYTES) {
          stderr = (stderr + chunk.toString("utf8")).slice(0, CAPTURE_LIMIT_BYTES);
        }
      });

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({
          id: "",
          argv: command.argv,
          cwd: command.cwd,
          status: "timeout",
          exitCode: null,
          stdout,
          stderr,
          error: `Timed out after ${command.timeoutMs}ms`
        });
      }, command.timeoutMs);
      timer.unref?.();

      child.on("error", (error) => {
        clearTimeout(timer);
        finish({
          id: "",
          argv: command.argv,
          cwd: command.cwd,
          status: "failed",
          exitCode: null,
          stdout,
          stderr,
          error: error.message
        });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        finish({
          id: "",
          argv: command.argv,
          cwd: command.cwd,
          status: code === 0 ? "ok" : "failed",
          exitCode: code,
          stdout,
          stderr
        });
      });
    });
  }

  async function rollback(outcomes: readonly CommandApplyOutcome[]): Promise<{ restoredPaths: string[]; rollbackBlockers: string[] }> {
    const restoredPaths: string[] = [];
    const rollbackBlockers: string[] = [];
    // Reverse order so later applies are undone first.
    for (const outcome of [...outcomes].reverse()) {
      if (!outcome.applied) {
        continue;
      }
      const target = resolve(repoRoot, outcome.path);
      const rel = relative(repoRoot, target);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        rollbackBlockers.push(`${outcome.path}: path escapes repoRoot; not restored`);
        continue;
      }
      if (outcome.backupPath === undefined) {
        // Create op: no prior state to restore. The created file is left in
        // place and reported — deleting it is not authorized here.
        rollbackBlockers.push(`${outcome.path}: no backup recorded (created file left in place)`);
        continue;
      }
      const backupTarget = resolve(repoRoot, outcome.backupPath);
      const backupRel = relative(repoRoot, backupTarget);
      if (backupRel === "" || backupRel.startsWith("..") || isAbsolute(backupRel)) {
        rollbackBlockers.push(`${outcome.path}: backup path escapes repoRoot; not restored`);
        continue;
      }
      try {
        await mkdir(dirname(target), { recursive: true });
        await copyFile(backupTarget, target);
        restoredPaths.push(outcome.path);
      } catch (error) {
        rollbackBlockers.push(`${outcome.path}: restore failed (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    return { restoredPaths, rollbackBlockers };
  }

  async function executeAfterApply(
    outcomes: readonly CommandApplyOutcome[],
    commands?: readonly unknown[]
  ): Promise<ApplyCommandQueueResult> {
    const appliedOutcomes = outcomes.filter((outcome) => outcome.applied);
    const queue: ApplyCommand[] = commands !== undefined
      ? commands.map((command) => ApplyCommandSchema.parse(command))
      : staged.splice(0, staged.length);

    if (appliedOutcomes.length === 0) {
      return { ran: false, skipReason: "no applied ops", results: [], rolledBack: false, restoredPaths: [], rollbackBlockers: [], allOk: true };
    }
    if (queue.length === 0) {
      return { ran: false, skipReason: "empty queue", results: [], rolledBack: false, restoredPaths: [], rollbackBlockers: [], allOk: true };
    }

    const results: ApplyCommandResult[] = [];
    let rolledBack = false;
    let restoredPaths: string[] = [];
    let rollbackBlockers: string[] = [];
    let stopped = false;

    for (let index = 0; index < queue.length; index += 1) {
      if (stopped) {
        break;
      }
      const command = queue[index]!;
      const result = await runCommand(command);
      results.push({ ...result, id: `cmdq-exec-${index + 1}` });

      if (result.status === "ok") {
        continue;
      }
      if (command.rollbackPolicy === "require") {
        const rollbackOutcome = await rollback(appliedOutcomes);
        rolledBack = rollbackOutcome.restoredPaths.length > 0;
        restoredPaths = rollbackOutcome.restoredPaths;
        rollbackBlockers = rollbackOutcome.rollbackBlockers;
        stopped = true;
      }
      // policy=report: surface the failure and continue with the next command.
    }

    return {
      ran: true,
      results,
      rolledBack,
      restoredPaths,
      rollbackBlockers,
      allOk: results.every((result) => result.status === "ok")
    };
  }

  return { stage, executeAfterApply };
}

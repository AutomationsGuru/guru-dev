import { executeCommand, type CommandExecutor } from "../../review/gates.js";

/**
 * Bounded outcome debug loop (IDEA-F10): run a command; on failure ask a
 * model-or-stub fix proposer for one trial fix; apply it under policy; re-run;
 * stop on success with a receipt, otherwise roll the trial back and continue;
 * at maxTries emit an explicit fail receipt. The loop never leaves the
 * workspace mutated by a losing trial — every failed trial is rolled back.
 */

/** Hard ceiling on loop iterations regardless of caller input (bound-the-loop). */
export const DEBUG_LOOP_MAX_TRIES_CEILING = 10;
/** Plan default when the caller does not specify maxTries. */
export const DEBUG_LOOP_DEFAULT_MAX_TRIES = 5;

export interface DebugLoopFix {
  readonly description: string;
  readonly summary: string;
}

export interface DebugLoopProposeContext {
  readonly attempt: number;
  readonly command: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly priorFixes: readonly DebugLoopFix[];
}

/** Model-or-stub seam: given one failure's output, propose exactly one trial fix. */
export type DebugLoopFixProposer = (context: DebugLoopProposeContext) => Promise<DebugLoopFix>;

export interface DebugLoopTrialResult {
  readonly applied: boolean;
  readonly rolledBack: boolean;
  readonly detail?: string;
}

/**
 * Policy-mediated trial seam. The caller owns how a proposed fix becomes a
 * workspace change (pending-edit proposal, direct edit under policy, etc.) and
 * how it is undone. The loop only requires: apply one fix, and roll back the
 * fix that was under test after its re-run failed.
 */
export interface DebugLoopTrialApplier {
  readonly applyTrial: (fix: DebugLoopFix, attempt: number) => Promise<DebugLoopTrialResult>;
  readonly rollbackTrial: (fix: DebugLoopFix, attempt: number) => Promise<void>;
}

export interface DebugLoopAttemptRecord {
  readonly attempt: number;
  readonly exitCode: number | null;
  readonly cancelled: boolean;
  /** The trial fix this run was testing, when the run was a re-run. */
  readonly fix?: DebugLoopFix;
  /** True when that trial fix was rolled back after this run failed. */
  readonly rolledBack: boolean;
}

export interface DebugLoopReceipt {
  readonly attempts: number;
  readonly rollbackPerformed: boolean;
  readonly fixesTried: DebugLoopFix[];
}

export interface DebugLoopRunResult {
  readonly outcome: "succeeded" | "failed";
  readonly tries: number;
  readonly maxTries: number;
  readonly attempts: DebugLoopAttemptRecord[];
  readonly receipt: DebugLoopReceipt;
  readonly summary: string;
}

export interface RunDebugLoopOptions {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly maxTries: number;
  readonly executor?: CommandExecutor | undefined;
  readonly proposeFix: DebugLoopFixProposer;
  readonly trialApplier: DebugLoopTrialApplier;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}

export async function runDebugLoop(options: RunDebugLoopOptions): Promise<DebugLoopRunResult> {
  const executor = options.executor ?? executeCommand;
  const maxTries = clampMaxTries(options.maxTries);
  const attempts: DebugLoopAttemptRecord[] = [];
  const fixesTried: DebugLoopFix[] = [];
  let rollbackPerformed = false;
  /** The fix currently applied to the workspace and under test, if any. */
  let fixUnderTest: { readonly fix: DebugLoopFix; readonly appliedAtAttempt: number } | undefined;

  for (let attempt = 1; attempt <= maxTries; attempt += 1) {
    const execution = await executor(options.command, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      gate: {
        kind: "validation",
        name: "debug.loop.run",
        command: options.command,
        required: true
      },
      signal: options.signal
    });

    if (execution.exitCode === 0 && execution.cancelled !== true) {
      attempts.push({
        attempt,
        exitCode: execution.exitCode,
        cancelled: execution.cancelled === true,
        ...(fixUnderTest ? { fix: fixUnderTest.fix } : {}),
        rolledBack: false
      });
      const receipt: DebugLoopReceipt = { attempts: attempt, rollbackPerformed, fixesTried };
      return {
        outcome: "succeeded",
        tries: attempt,
        maxTries,
        attempts,
        receipt,
        summary: fixUnderTest
          ? `debug loop succeeded on attempt ${attempt} of ${maxTries} after applying trial fix "${fixUnderTest.fix.summary}".`
          : `debug loop succeeded on attempt ${attempt} of ${maxTries}.`
      };
    }

    // The run failed: a fix under test lost — roll it back before proposing the next one.
    let rolledBack = false;
    if (fixUnderTest) {
      await options.trialApplier.rollbackTrial(fixUnderTest.fix, fixUnderTest.appliedAtAttempt);
      rollbackPerformed = true;
      rolledBack = true;
    }

    attempts.push({
      attempt,
      exitCode: execution.exitCode,
      cancelled: execution.cancelled === true,
      ...(fixUnderTest ? { fix: fixUnderTest.fix } : {}),
      rolledBack
    });
    fixUnderTest = undefined;

    // No proposal after the final try: nothing would re-run it.
    if (attempt === maxTries) {
      break;
    }

    const fix = await options.proposeFix({
      attempt,
      command: options.command,
      stdout: execution.stdout,
      stderr: execution.stderr,
      priorFixes: fixesTried
    });

    await options.trialApplier.applyTrial(fix, attempt);
    fixesTried.push(fix);
    fixUnderTest = { fix, appliedAtAttempt: attempt };
  }

  const receipt: DebugLoopReceipt = { attempts: maxTries, rollbackPerformed, fixesTried };
  return {
    outcome: "failed",
    tries: maxTries,
    maxTries,
    attempts,
    receipt,
    summary:
      `fail receipt: debug loop exhausted maxTries=${maxTries} without a passing run; ` +
      `${fixesTried.length} trial fix(es) proposed and every applied trial rolled back.`
  };
}

function clampMaxTries(maxTries: number): number {
  if (!Number.isFinite(maxTries) || maxTries < 1) {
    return DEBUG_LOOP_DEFAULT_MAX_TRIES;
  }

  return Math.min(Math.trunc(maxTries), DEBUG_LOOP_MAX_TRIES_CEILING);
}

/**
 * IDEA-F10-DEBUG-LOOP-01 — bounded debug loop engine.
 *
 * Runs a command, and on failure proposes a fix into a pending trial, applies
 * the trial, and re-runs — up to a structural `maxTries` ceiling. Every terminal
 * state resolves to an explicit receipt; the loop never silently reports success
 * and never runs an unbounded number of attempts.
 *
 * The engine is deliberately free of any model or shell dependency: the command
 * runner, fix proposer, and trial applier are all injected interfaces. That keeps
 * the loop independent (no borrowed framework/CLI runs it) and makes the implicit
 * "spend" of a model call an explicit, gating seam (hard limit #2 — no unapproved
 * spend). A $0/stub proposer is the default in tests; a live model proposer is an
 * explicit, owned adapter wired at the tool layer.
 *
 * Rollback is preservation-first (hard limit #1): a `TrialApplier` may return a
 * closure that reverses its trial, and the engine invokes it whenever the trial
 * did not produce a passing run, so a failed fix is undone before the next
 * attempt instead of accumulating damage.
 */

/** A single command execution's captured output. */
export interface CommandRunResult {
  /** Process exit code. `0` is success; `null` means the run did not yield one (e.g. killed). */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Whether a run succeeded. Exit code 0 is success; anything else (incl. null) is failure. */
export function runSucceeded(result: CommandRunResult): boolean {
  return result.exitCode === 0;
}

/** Runs the target command once and returns its captured output. */
export type CommandRunner = () => Promise<CommandRunResult>;

/** Context handed to a fix proposer after a failing run. */
export interface FailureContext {
  readonly attempt: number;
  readonly command: string;
  readonly lastResult: CommandRunResult;
  /** The fix attempted on the prior iteration, if any (and whether it was rolled back). */
  readonly priorFix?: DebugFix | null;
}

/** A proposed fix. `patch` is opaque to the engine — the applier interprets it. */
export interface DebugFix {
  readonly description: string;
  readonly patch: string;
}

/**
 * Proposes a fix for the most recent failure, or returns `null` when no fix can
 * be proposed. Returning `null` ends the loop in the unresolved state (a stated
 * outcome, not a dead-end: the receipt records it).
 */
export type FixProposer = (context: FailureContext) => Promise<DebugFix | null>;

/**
 * Optional closure returned by a {@link TrialApplier} that reverses the trial.
 * Invoked by the engine only when the trial's subsequent run did not succeed.
 */
export type Rollback = () => Promise<void> | void;

/**
 * Applies a proposed fix as a pending trial. May return a {@link Rollback} to be
 * invoked if the trial does not lead to a passing run.
 *
 * @param fix the fix to apply
 * @param attempt the 1-based attempt number this trial corresponds to
 */
export type TrialApplier = (fix: DebugFix, attempt: number) => Promise<Rollback | void> | Rollback | void;

/** Input shape accepted by {@link runDebugLoop}. */
export interface RunDebugLoopInput {
  /** The command string to run on each attempt. */
  readonly Command: string;
  /** Maximum number of run attempts. Clamped to at least 1. */
  readonly MaxTries: number;
}

/** Terminal status of a debug loop. */
export type DebugLoopStatus = "succeeded" | "failed";

/** The explicit receipt every loop run resolves to. */
export interface DebugLoopReceipt {
  readonly status: DebugLoopStatus;
  readonly command: string;
  /** Number of run attempts actually made. */
  readonly tries: number;
  /** The structural ceiling that bounded the loop. */
  readonly maxTries: number;
  /** Human-readable summary of the terminal state. */
  readonly message: string;
  /** Outputs of the final attempt. */
  readonly lastExitCode: number | null;
  readonly lastStdout: string;
  readonly lastStderr: string;
  /** The fix attempted on the final iteration, if any. */
  readonly lastFix: DebugFix | null;
}

export interface RunDebugLoopOptions {
  readonly run: CommandRunner;
  readonly propose: FixProposer;
  readonly apply: TrialApplier;
  readonly input: RunDebugLoopInput;
}

/**
 * Execute the bounded debug loop. Returns a receipt for every terminal state.
 *
 * Semantics:
 * - Attempt 1 runs the command as-is. Success → receipt, tries=1.
 * - On failure, the proposer is consulted. `null` → fail-closed receipt.
 * - Otherwise the fix is applied as a trial and the command re-runs.
 * - If the new run fails, any returned rollback is invoked before the next proposal.
 * - The loop stops at the first success or at `maxTries` attempts, whichever first.
 */
export async function runDebugLoop(options: RunDebugLoopOptions): Promise<DebugLoopReceipt> {
  const { run, propose, apply, input } = options;
  const command = input.Command;
  const maxTries = clampMaxTries(input.MaxTries);

  let lastResult: CommandRunResult = { exitCode: null, stdout: "", stderr: "" };
  let lastFix: DebugFix | null = null;
  let attempt = 0;

  while (attempt < maxTries) {
    attempt += 1;

    const pendingRollback =
      attempt > 1 && lastFix ? await maybeApply(apply, lastFix, attempt) : undefined;
    lastResult = await run();

    if (runSucceeded(lastResult)) {
      return receipt({
        status: "succeeded",
        command,
        tries: attempt,
        maxTries,
        message: attempt === 1 ? "Command succeeded on the first try." : `Command succeeded on try ${attempt}.`,
        lastResult,
        lastFix
      });
    }

    // Trial did not pass — undo it before considering the next move.
    if (pendingRollback) {
      await pendingRollback();
    }

    if (attempt >= maxTries) {
      return receipt({
        status: "failed",
        command,
        tries: attempt,
        maxTries,
        message: `Debug loop exhausted: command failed after ${attempt} attempt${attempt === 1 ? "" : "s"}.`,
        lastResult,
        lastFix
      });
    }

    const proposed = await propose({
      attempt: attempt + 1,
      command,
      lastResult,
      priorFix: lastFix
    });

    if (!proposed) {
      return receipt({
        status: "failed",
        command,
        tries: attempt,
        maxTries,
        message: "Debug loop stopped: no fix could be proposed for the failure.",
        lastResult,
        lastFix
      });
    }

    lastFix = proposed;
  }

  // Defensive: the loop above always returns within maxTries. This is unreachable
  // for valid input but keeps the function total for the type checker.
  return receipt({
    status: "failed",
    command,
    tries: attempt,
    maxTries,
    message: "Debug loop ended without resolution.",
    lastResult,
    lastFix
  });
}

async function maybeApply(
  apply: TrialApplier,
  fix: DebugFix,
  attempt: number
): Promise<Rollback | undefined> {
  const rollback = await apply(fix, attempt);
  return rollback ?? undefined;
}

interface ReceiptArgs {
  readonly status: DebugLoopStatus;
  readonly command: string;
  readonly tries: number;
  readonly maxTries: number;
  readonly message: string;
  readonly lastResult: CommandRunResult;
  readonly lastFix: DebugFix | null;
}

function receipt(args: ReceiptArgs): DebugLoopReceipt {
  return {
    status: args.status,
    command: args.command,
    tries: args.tries,
    maxTries: args.maxTries,
    message: args.message,
    lastExitCode: args.lastResult.exitCode,
    lastStdout: args.lastResult.stdout,
    lastStderr: args.lastResult.stderr,
    lastFix: args.lastFix
  };
}

/** Structural ceiling: a loop with maxTries < 1 still gets exactly one attempt. */
export function clampMaxTries(maxTries: number): number {
  if (!Number.isFinite(maxTries) || maxTries < 1) {
    return 1;
  }
  return Math.floor(maxTries);
}

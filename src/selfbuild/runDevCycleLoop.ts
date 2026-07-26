import { runDevCycle, type DevCycleReport, type RunDevCycleInput } from "./runDevCycle.js";
import { selectNextTask, type SelectableTask, type TaskOutcomeHistory } from "./selectTask.js";

/**
 * The UNATTENDED multi-cycle driver (self-build P7). Loops `runDevCycle` over the ready
 * task set: SELECT picks the best task, the cycle runs it, and its LEARN outcome updates the
 * history so the NEXT SELECT deprioritises a just-blocked task and never re-picks a processed
 * one. Terminates when no task is eligible or a hard cycle cap is hit — the loop is finite by
 * construction (every cycle removes one task from eligibility), and each cycle stays bounded +
 * spend-gated by its own DevCycleBudget.
 */

export type DevCycleFn = (input: RunDevCycleInput) => Promise<DevCycleReport>;

export interface DevCycleLoopInput {
  readonly tasks: readonly SelectableTask[];
  /** Shared per-cycle deps (executor, budget, askModel, policy, …). */
  readonly baseInput?: RunDevCycleInput;
  /** Injectable cycle runner (defaults to runDevCycle) — the seam tests stub. */
  readonly cycle?: DevCycleFn;
  /** Hard cap on total cycles (defaults to the task count). */
  readonly maxCycles?: number;
  readonly onCycle?: (report: DevCycleReport, taskId: string) => void;
}

export interface DevCycleLoopReport {
  readonly cycles: readonly DevCycleReport[];
  readonly completed: readonly string[];
  readonly blocked: readonly string[];
  readonly stoppedReason: "no-ready-task" | "max-cycles";
}

export async function runDevCycleLoop(input: DevCycleLoopInput): Promise<DevCycleLoopReport> {
  const cycle = input.cycle ?? runDevCycle;
  const maxCycles = input.maxCycles ?? input.tasks.length;
  // Seed in-memory sets from the persisted history so the LEARN→SELECT feedback arc
  // survives cold starts after a prior invocation shipped or blocked tasks.
  const persistedHistory = input.baseInput?.history;
  const completed = new Set<string>(persistedHistory?.completed ?? []);
  const blocked = new Set<string>(persistedHistory?.recentBlockers ?? []);
  // Processed = shipped OR blocked → ineligible for re-pick, so the loop is guaranteed finite.
  const processed = new Set<string>([...completed, ...blocked]);
  const cycles: DevCycleReport[] = [];

  const historyNow = (): TaskOutcomeHistory => ({
    recentBlockers: new Set(blocked),
    completed: new Set(processed)
  });

  for (let i = 0; i < maxCycles; i += 1) {
    const chosen = selectNextTask(input.tasks, historyNow());
    if (!chosen) {
      break;
    }
    const report = await cycle({
      ...input.baseInput,
      executorOptions: { ...input.baseInput?.executorOptions, taskId: chosen.id }
    });
    cycles.push(report);
    input.onCycle?.(report, chosen.id);
    processed.add(chosen.id);
    if (report.terminal === "done") {
      completed.add(chosen.id);
    } else {
      blocked.add(chosen.id);
    }
  }

  // Anything still eligible after the loop means the cycle cap stopped us early.
  const stoppedReason = selectNextTask(input.tasks, historyNow()) ? "max-cycles" : "no-ready-task";
  return { cycles, completed: [...completed], blocked: [...blocked], stoppedReason };
}

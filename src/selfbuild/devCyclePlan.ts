import type { ValidationCommand } from "../config/schema.js";
import { RunDevCycleConfigSchema, type DevStage, type RunDevCycleConfig } from "./devCycle.js";
import { discoverGates, type DiscoverGatesOptions } from "./discoverGates.js";

/**
 * Dev-cycle DRY-RUN planner (self-build P7 surface). Discovers what the loop WOULD do —
 * the project's own gates and the 0→7 stage plan — and renders it, executing NOTHING. This
 * is the `--dry-run` preview: it never spawns a model, runs a gate, or mutates a file, so a
 * fresh machine can inspect exactly what `--run` will attempt before spending anything.
 */

export interface DevCyclePlanStage {
  readonly stage: DevStage;
  readonly action: string;
  /** False when a dependency is unwired (the stage will degrade to a legible YELLOW). */
  readonly willRun: boolean;
}

export interface DevCyclePlan {
  readonly cwd: string;
  readonly taskId: string;
  readonly gates: readonly ValidationCommand[];
  readonly stages: readonly DevCyclePlanStage[];
  readonly budget: RunDevCycleConfig;
  readonly notes: readonly string[];
}

export interface BuildDevCyclePlanInput {
  readonly cwd: string;
  readonly taskId?: string;
  readonly budget?: Partial<RunDevCycleConfig>;
  readonly hasReviewer?: boolean;
  readonly hasSmoke?: boolean;
  readonly hasGitDelivery?: boolean;
  readonly discover?: DiscoverGatesOptions;
}

export function buildDevCyclePlan(input: BuildDevCyclePlanInput): DevCyclePlan {
  const gates = discoverGates(input.cwd, input.discover ?? {});
  const budget = RunDevCycleConfigSchema.parse(input.budget ?? {});
  const taskId = input.taskId ?? "unnamed-task";
  const gateList = gates.map((gate) => gate.command.join(" ")).join(", ");

  const stages: DevCyclePlanStage[] = [
    { stage: "select", action: `pick the next ready task (or use "${taskId}")`, willRun: true },
    { stage: "build", action: "plan + apply the change via the executor, gated by the fail-closed mandate policy", willRun: true },
    {
      stage: "test",
      action: gates.length > 0 ? `run ${gates.length} discovered gate(s): ${gateList}` : "no gates discovered → YELLOW (never RED-by-absence)",
      willRun: gates.length > 0
    },
    { stage: "smoke", action: input.hasSmoke ? "capability-smoke + one bounded self-call" : "not wired → YELLOW", willRun: Boolean(input.hasSmoke) },
    { stage: "debug", action: "on RED: parse the failure → re-plan (bounded by the attempt + token budget)", willRun: true },
    { stage: "review", action: input.hasReviewer ? "guru's live native critic panel (RED blocks ship)" : "no reviewer wired → YELLOW (not a pass)", willRun: Boolean(input.hasReviewer) },
    {
      stage: "ship",
      action: input.hasGitDelivery ? "git commit/push (+ PR iff gh present)" : "git absent/unwired → durable on-disk change-record",
      willRun: true
    },
    { stage: "learn", action: "record one validated/parked fact; a block feeds the next SELECT", willRun: true }
  ];

  const notes = [
    "DRY RUN — nothing is executed: no model call, no gate run, no file mutation.",
    `spend ceiling: $${budget.spend.ceilingUsd} (0 denies all spend), attempts ≤ ${budget.maxIterations}, tokens ≤ ${budget.tokenBudget}, wall-clock ≤ ${budget.wallClockMs}ms.`
  ];

  return { cwd: input.cwd, taskId, gates, stages, budget, notes };
}

export function renderDevCyclePlan(plan: DevCyclePlan): string {
  const lines: string[] = [];
  lines.push(`Dev-cycle plan for task "${plan.taskId}" (cwd: ${plan.cwd})`);
  lines.push("");
  for (const [index, stage] of plan.stages.entries()) {
    const marker = stage.willRun ? "•" : "○";
    lines.push(`  ${index}. ${marker} ${stage.stage.toUpperCase().padEnd(7)} ${stage.action}`);
  }
  lines.push("");
  for (const note of plan.notes) {
    lines.push(`  ${note}`);
  }
  return lines.join("\n");
}

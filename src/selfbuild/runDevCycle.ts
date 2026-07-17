import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import {
  runSelfBuildExecutor,
  type MandatePolicyFn,
  type RunSelfBuildExecutorOptions,
  type SelfBuildExecutorReport
} from "../executor/selfBuildExecutor.js";
import { evaluateToolMandate } from "../mandates/evaluate.js";
import { MandateStateSchema, type MandateState } from "../mandates/schema.js";
import type { CommandGate, NativeReviewer } from "../review/gates.js";
import type { AskModel } from "../review/nativeCriticPanel.js";
import { ledgerRecordingPolicy, type ApprovalLedger, type LedgerEntry } from "./approvalLedger.js";
import { runDiscoveredValidation } from "./discoverGates.js";
import { makeDevCycleReviewer, type ReviewContextGatherer } from "./devCycleReview.js";
import { makeGatedGitDelivery } from "./gitDelivery.js";
import { deriveLearning, type LearnedFact } from "./learn.js";
import { parseGateFailure, type GateFailureNote } from "./parseGateFailure.js";
import { EMPTY_HISTORY, selectNextTask, type SelectableTask, type TaskOutcomeHistory } from "./selectTask.js";
import { ChangeRecordSchema, runShipStage, type ShipStageDeps } from "./shipStage.js";
import { runSmokeStage, type SmokeStageDeps } from "./smokeStage.js";
import {
  DevCycleBudget,
  RunDevCycleConfigSchema,
  isTerminal,
  nextStage,
  type BudgetSnapshot,
  type Clock,
  type DevStage,
  type RunDevCycleConfig,
  type StageOutcome,
  type StageVerdict
} from "./devCycle.js";
import { DevCycleCheckpointSchema, type DevCycleCheckpoint } from "./devCycleCheckpoint.js";

/**
 * runDevCycle (P7) — the orchestrator that WRAPS `runSelfBuildExecutor` and drives one
 * task through the 0→7 loop SELECT→BUILD→TEST→SMOKE→(DEBUG)→REVIEW→SHIP→LEARN as pure
 * transitions, bounded by a budget and gated by an injected mandate/spend policy.
 *
 * Its first act closes the load-bearing gap: it injects a fail-closed mandate policy into
 * the executor runtime (the executor path had no spend gate). TEST runs the project's OWN
 * discovered gates (never assumed), SMOKE runs capability-smoke + a bounded self-call,
 * REVIEW runs guru's live native critic panel. DEBUG/SHIP/LEARN are named seams that
 * default to a legible no-op so P3/P5/P4 plug in without touching the spine.
 */

/**
 * The fail-closed autonomous policy: an empty mandate with NO YOLO. Read-only tools are
 * allowed; every mutation / spend / hard-edge call escalates — and on the non-interactive
 * executor path an escalate is a block. Grants must be explicit; spend is never auto-allowed.
 */
export function failClosedMandatePolicy(state: MandateState = MandateStateSchema.parse({})): MandatePolicyFn {
  return (toolId, input, cwd) => evaluateToolMandate(toolId, input, { cwd, state, yolo: false });
}

/**
 * A YOLO policy: ordinary permission gates are lifted, but the hard edges — spend,
 * destructive, secret-edge, auth-edge — STILL escalate (block on the non-interactive path).
 * Spend is the one gate YOLO can never lift; this is the law an autonomous run relies on.
 */
export function yoloMandatePolicy(state: MandateState = MandateStateSchema.parse({})): MandatePolicyFn {
  return (toolId, input, cwd) => evaluateToolMandate(toolId, input, { cwd, state, yolo: true });
}

export type SelfBuildExecutorFn = (options: RunSelfBuildExecutorOptions) => Promise<SelfBuildExecutorReport>;

export interface StageResult {
  readonly verdict: StageVerdict;
  readonly evidence: string;
  /** Model tokens this stage consumed, to draw down the budget. */
  readonly tokens?: number;
}
export type StageRunner = () => Promise<StageResult>;

export interface RunDevCycleInput {
  /** Pass-through executor options (cwd, taskId, plannerModel, stores, commandExecutor, git, …). */
  readonly executorOptions?: RunSelfBuildExecutorOptions;
  readonly budget?: Partial<RunDevCycleConfig>;
  readonly mandatePolicy?: MandatePolicyFn;
  readonly mandateState?: MandateState;
  /** Records every mandate decision (persist with saveLedger → survives restart). */
  readonly ledger?: ApprovalLedger;
  /** Live native critic panel for REVIEW; absent → REVIEW is a legible YELLOW (never a silent pass). */
  readonly nativeReviewer?: NativeReviewer;
  /** Convenience: build the native reviewer from a single-turn model call (used when `nativeReviewer` is absent). */
  readonly askModel?: AskModel;
  readonly reviewContext?: ReviewContextGatherer;
  /** Capability-smoke + bounded self-call for SMOKE; absent → SMOKE is YELLOW. */
  readonly smoke?: SmokeStageDeps;
  /** Full DEBUG override; else the default parses the failure and calls `repair`. */
  readonly debug?: StageRunner;
  /**
   * Repair a parsed gate failure (P3). Returns whether it made a fix worth re-validating.
   * Absent → the default re-plans via BUILD carrying the failure note forward. The
   * DevCycleBudget (attempt cap + token budget) bounds the repair loop — no fix ever runs
   * unbounded.
   */
  readonly repair?: (note: GateFailureNote) => Promise<{ readonly repaired: boolean; readonly evidence: string; readonly tokens?: number }>;
  /** SELECT scoring (P4): the ready-task set + stored outcomes. Absent → the provided task is used. */
  readonly tasks?: readonly SelectableTask[];
  readonly history?: TaskOutcomeHistory;
  readonly learn?: StageRunner;
  /** LEARN sink (P4): persist the derived fact. Absent → the fact is still returned on the report. */
  readonly recordFact?: (fact: LearnedFact) => Promise<void> | void;
  /** Full SHIP override; else the default presence-detecting SHIP stage runs with these deps. */
  readonly ship?: StageRunner;
  readonly shipDeps?: Omit<ShipStageDeps, "cwd" | "payload">;
  readonly clock?: Clock;
  /** Injectable executor + per-stage overrides (defaults to the real organs) — the seams tests stub. */
  readonly executor?: SelfBuildExecutorFn;
  readonly stages?: Partial<Record<DevStage, StageRunner>>;
  /** Progress sink: fires once per completed stage (0→7), so an unattended run is observable. */
  readonly onStage?: (event: DevStageEvent) => void;
  /** Optional project-local checkpoint seam. The CLI supplies a store-backed controller. */
  readonly checkpoint?: DevCycleCheckpointController;
}

export interface DevCycleCheckpointController {
  readonly cycleId: string;
  readonly resume?: DevCycleCheckpoint;
  readonly now?: () => Date;
  save(checkpoint: DevCycleCheckpoint): Promise<void> | void;
}

export interface DevStageEvent {
  readonly index: number;
  readonly stage: DevStage;
  readonly verdict: StageVerdict;
  readonly evidence: string;
  readonly budget: BudgetSnapshot;
}

export interface DevCycleReport {
  readonly cycleId: string;
  readonly verdict: StageVerdict;
  readonly terminal: "done" | "blocked";
  readonly stages: readonly StageOutcome[];
  readonly budget: BudgetSnapshot;
  readonly executor: SelfBuildExecutorReport | null;
  /** The single fact this cycle learned (feeds the next SELECT's history). */
  readonly learned: LearnedFact | null;
  /** The mandate decisions this cycle recorded (empty unless a ledger was provided). */
  readonly ledger: readonly LedgerEntry[];
  readonly summary: string;
}

const NATIVE_REVIEW_GATE: CommandGate = {
  kind: "review",
  name: "native-critic-panel",
  command: [],
  required: true,
  native: true
};

// A model loop (BUILD re-plans, DEBUG re-plans) consumes an attempt; gating stages do not.
const CONSUMES_ATTEMPT = new Set<DevStage>(["build", "debug"]);

export async function runDevCycle(input: RunDevCycleInput = {}): Promise<DevCycleReport> {
  const cwd = input.executorOptions?.cwd ?? process.cwd();
  const canonicalCwd = realpathSync(resolve(cwd));
  const resumed = input.checkpoint?.resume ? DevCycleCheckpointSchema.parse(input.checkpoint.resume) : null;
  const cycleId = input.checkpoint?.cycleId ?? randomUUID();

  if (resumed) {
    if (resumed.cycleId !== cycleId) {
      throw new Error(`Dev-cycle checkpoint id mismatch: expected ${cycleId}.`);
    }
    if (realpathSync(resolve(resumed.cwd)) !== canonicalCwd) {
      throw new Error(`Dev-cycle checkpoint cwd mismatch for cycle ${cycleId}.`);
    }
    if (input.executorOptions?.taskId && input.executorOptions.taskId !== resumed.selectedTaskId) {
      throw new Error(`Dev-cycle checkpoint task mismatch for cycle ${cycleId}.`);
    }
  }

  const resumedBudgetConfig = resumed
    ? RunDevCycleConfigSchema.parse({
        maxIterations: resumed.budget.maxIterations,
        tokenBudget: resumed.budget.tokenBudget,
        wallClockMs: resumed.budget.wallClockMs,
        spend: { ceilingUsd: resumed.budget.ceilingUsd, spentUsd: resumed.budget.spentUsd }
      })
    : null;
  const budgetConfig = resumedBudgetConfig ?? RunDevCycleConfigSchema.parse(input.budget ?? {});
  if (resumed && input.budget) {
    const requested = RunDevCycleConfigSchema.parse(input.budget);
    if (
      requested.maxIterations !== budgetConfig.maxIterations ||
      requested.tokenBudget !== budgetConfig.tokenBudget ||
      requested.wallClockMs !== budgetConfig.wallClockMs ||
      requested.spend.ceilingUsd !== budgetConfig.spend.ceilingUsd
    ) {
      throw new Error(`Dev-cycle checkpoint budget mismatch for cycle ${cycleId}; resume cannot reset limits.`);
    }
  }

  const budget = new DevCycleBudget(
    budgetConfig,
    input.clock,
    resumed
      ? {
          attempts: resumed.budget.attempts,
          tokens: resumed.budget.tokens,
          spentUsd: resumed.budget.spentUsd,
          elapsedMs: resumed.budget.elapsedMs
        }
      : undefined
  );
  const basePolicy =
    input.mandatePolicy ?? failClosedMandatePolicy(input.mandateState ?? MandateStateSchema.parse({}));
  // Wrap the policy so every decision is recorded into the audit ledger (decisions unchanged).
  const policy = input.ledger ? ledgerRecordingPolicy(basePolicy, input.ledger) : basePolicy;
  const runExecutor = input.executor ?? runSelfBuildExecutor;
  const stages: StageOutcome[] = resumed ? [...resumed.completedStages] : [];
  let executorReport: SelfBuildExecutorReport | null = null;
  // The most recent RED gate, parsed into a structured note for DEBUG to repair.
  let lastFailure: GateFailureNote | null = resumed?.lastFailure ?? null;
  // The task this cycle is building (SELECT may re-pick from the ready set), and what it learned.
  let selectedTaskId = resumed?.selectedTaskId ?? input.executorOptions?.taskId ?? "unnamed-task";
  let learnedFact: LearnedFact | null = resumed?.learned
    ? {
        taskId: resumed.learned.taskId,
        outcome: resumed.learned.outcome,
        verdict: resumed.learned.verdict,
        confidence: resumed.learned.confidence,
        fact: resumed.learned.fact,
        ...(resumed.learned.blockerNote === undefined ? {} : { blockerNote: resumed.learned.blockerNote })
      }
    : null;
  let executorSessionId: string | null = resumed?.executorSessionId ?? null;
  const resumeReruns = resumed ? [...resumed.resumeReruns] : [];
  const now = input.checkpoint?.now ?? (() => new Date());
  const createdAt = resumed?.createdAt ?? now().toISOString();
  let stage: DevStage = resumed?.stage ?? "select";
  let continuationStage: "build" | "debug" | null = null;
  let continuationSessionId: string | null = null;
  let preserveAttemptForInterruptedStage = false;

  const saveCheckpoint = async (options: {
    readonly stage: DevStage;
    readonly stageState: "pending" | "running" | "completed";
    readonly status: "running" | "done" | "blocked";
    readonly verdict: StageVerdict | null;
  }): Promise<void> => {
    if (!input.checkpoint) {
      return;
    }
    const checkpoint = DevCycleCheckpointSchema.parse({
      schemaVersion: 1,
      cycleId,
      cwd: canonicalCwd,
      selectedTaskId,
      stage: options.stage,
      stageState: options.stageState,
      completedStages: stages,
      lastFailure,
      executorSessionId,
      budget: budget.snapshot(),
      status: options.status,
      verdict: options.verdict,
      learned: learnedFact,
      resumeReruns,
      createdAt,
      updatedAt: now().toISOString()
    });
    await input.checkpoint.save(checkpoint);
  };

  if (resumed && resumed.status !== "running") {
    return {
      cycleId,
      verdict: resumed.verdict ?? (resumed.status === "done" ? "GREEN" : "RED"),
      terminal: resumed.status,
      stages,
      budget: budget.snapshot(),
      executor: null,
      learned: learnedFact,
      ledger: input.ledger?.entries() ?? [],
      summary: `dev cycle restored from terminal checkpoint ${cycleId}; no stages executed.`
    };
  }

  if (resumed?.stageState === "running") {
    if (stage === "test" || stage === "smoke" || stage === "review") {
      resumeReruns.push({ stage, interruptedAt: resumed.updatedAt, resumedAt: now().toISOString() });
      await saveCheckpoint({ stage, stageState: "pending", status: "running", verdict: null });
    } else if ((stage === "build" || stage === "debug") && executorSessionId) {
      continuationStage = stage;
      continuationSessionId = executorSessionId;
      preserveAttemptForInterruptedStage = true;
    } else {
      const interruptedStage = stage;
      const evidence =
        interruptedStage === "ship" || interruptedStage === "learn"
          ? `resume blocked: uncertain in-flight ${interruptedStage.toUpperCase()} is never replayed`
          : `resume blocked: interrupted ${interruptedStage.toUpperCase()} has no safe continuation session id`;
      stages.push({ stage: interruptedStage, verdict: "RED", evidence });
      stage = "blocked";
      learnedFact = deriveLearning({
        taskId: selectedTaskId,
        terminal: "blocked",
        verdict: "RED",
        note: evidence
      });
      // SELECT-RED and LEARN-RED reduce to `done`, so manufacturing a persisted
      // `blocked` terminal would itself be an impossible history. Preserve the
      // interrupted checkpoint unchanged for recovery instead.
      if (interruptedStage !== "select" && interruptedStage !== "learn") {
        await saveCheckpoint({ stage, stageState: "completed", status: "blocked", verdict: "RED" });
      }
      return {
        cycleId,
        verdict: "RED",
        terminal: "blocked",
        stages,
        budget: budget.snapshot(),
        executor: null,
        learned: learnedFact,
        ledger: input.ledger?.entries() ?? [],
        summary: `dev cycle resume blocked for ${cycleId}: ${evidence}`
      };
    }
  } else if (!resumed) {
    await saveCheckpoint({ stage, stageState: "pending", status: "running", verdict: null });
  }

  const boundedRetries = Math.min(
    input.executorOptions?.maxPlannerRetries ?? budgetConfig.maxIterations,
    budgetConfig.maxIterations
  );

  const withSessionBreadcrumb = (
    executorStage: "build" | "debug",
    options: RunSelfBuildExecutorOptions
  ): RunSelfBuildExecutorOptions => {
    const requestedResumeId = continuationStage === executorStage ? continuationSessionId : null;
    const outerBreadcrumb = input.executorOptions?.onSessionStarted;
    return {
      ...options,
      ...(requestedResumeId ? { resumeSessionId: requestedResumeId } : {}),
      onSessionStarted: async (sessionId) => {
        executorSessionId = sessionId;
        await saveCheckpoint({ stage: executorStage, stageState: "running", status: "running", verdict: null });
        await outerBreadcrumb?.(sessionId);
      }
    };
  };

  // Default repair: re-plan via BUILD carrying the failure note forward so the planner
  // fixes exactly what failed. Bounded by the budget's attempt cap (DEBUG consumes an attempt).
  const defaultRepair = async (note: GateFailureNote): Promise<{ repaired: boolean; evidence: string; tokens?: number }> => {
    const base = input.executorOptions?.objective ?? selectedTaskId;
    const objective = `${base}\n\nThe previous attempt FAILED the ${note.gate} gate (${note.kind}):\n${note.summary}\n${note.failures.join("\n")}\nProduce a plan that fixes exactly these failures.`;
    const report = await runExecutor(
      withSessionBreadcrumb("debug", {
        ...input.executorOptions,
        taskId: selectedTaskId,
        objective,
        mandatePolicy: policy,
        includeReviewGate: false,
        maxPlannerRetries: boundedRetries
      })
    );
    executorReport = report;
    if (report.session.id) {
      executorSessionId = report.session.id;
    }
    continuationStage = null;
    continuationSessionId = null;
    return {
      repaired: report.planner.status === "completed",
      evidence: `re-plan ${report.planner.status}`,
      tokens: report.plannerUsage.totalTokens
    };
  };

  const defaults: Record<DevStage, StageRunner> = {
    select: async () => {
      // Scored SELECT (P4): pick the best ready task from stored outcomes; none → done.
      if (input.tasks) {
        const chosen = selectNextTask(input.tasks, input.history ?? EMPTY_HISTORY);
        if (!chosen) {
          return { verdict: "RED", evidence: "SELECT: no ready task (DAG exhausted / all blocked)" };
        }
        selectedTaskId = chosen.id;
        return { verdict: "GREEN", evidence: `SELECT chose ${chosen.id}` };
      }
      return { verdict: "GREEN", evidence: `task provided (${selectedTaskId})` };
    },
    build: async () => {
      const options = withSessionBreadcrumb("build", {
        ...input.executorOptions,
        taskId: selectedTaskId,
        mandatePolicy: policy,
        // runDevCycle OWNS review (live native panel) — turn off the executor's own review gate.
        includeReviewGate: false,
        maxPlannerRetries: Math.min(
          input.executorOptions?.maxPlannerRetries ?? budgetConfig.maxIterations,
          budgetConfig.maxIterations
        )
      });
      executorReport = await runExecutor(options);
      if (executorReport.session.id) {
        executorSessionId = executorReport.session.id;
      }
      continuationStage = null;
      continuationSessionId = null;
      const built = executorReport.planner.status === "completed";
      return {
        verdict: built ? "GREEN" : "RED",
        evidence: `planner ${executorReport.planner.status}`,
        tokens: executorReport.plannerUsage.totalTokens
      };
    },
    test: async () => {
      const report = await runDiscoveredValidation(cwd, {
        ...(input.executorOptions?.commandExecutor ? { executor: input.executorOptions.commandExecutor } : {})
      });
      if (report.verdict === "RED") {
        const failed =
          report.results.find((result) => result.status === "failed" && result.required) ??
          report.results.find((result) => result.status === "failed");
        if (failed) {
          lastFailure = parseGateFailure(failed);
        }
      }
      return { verdict: report.verdict, evidence: report.summary };
    },
    smoke: async () => {
      if (!input.smoke) {
        return { verdict: "YELLOW", evidence: "SMOKE not wired (no capability-smoke / self-call deps)" };
      }
      const result = await runSmokeStage(input.smoke);
      if (result.verdict === "RED") {
        lastFailure = { gate: "smoke", kind: "generic", summary: result.summary, failures: [result.summary], raw: result.summary };
      }
      return { verdict: result.verdict, evidence: result.summary };
    },
    review: async () => {
      // Use an explicit reviewer, else build one from an askModel; only YELLOW if neither exists.
      const reviewer =
        input.nativeReviewer ??
        makeDevCycleReviewer({
          ...(input.askModel ? { askModel: input.askModel } : {}),
          ...(input.reviewContext ? { getReviewContext: input.reviewContext } : {}),
          ...(input.executorOptions?.objective ? { objective: input.executorOptions.objective } : {})
        });
      if (!reviewer) {
        return { verdict: "YELLOW", evidence: "REVIEW not wired (no native reviewer / model) — not a pass" };
      }
      const result = await reviewer(NATIVE_REVIEW_GATE, cwd);
      const verdict: StageVerdict = result.verdict ?? (result.status === "passed" ? "GREEN" : "RED");
      return {
        verdict,
        evidence: result.summary,
        ...(result.tokens !== undefined ? { tokens: result.tokens } : {})
      };
    },
    debug: async () => {
      if (input.debug) {
        return input.debug();
      }
      if (!lastFailure) {
        return { verdict: "RED", evidence: "DEBUG: no captured failure to repair — giving up" };
      }
      const note = lastFailure;
      const outcome = input.repair ? await input.repair(note) : await defaultRepair(note);
      // Repaired → GREEN routes back to TEST to re-validate; the budget bounds re-entries.
      return {
        verdict: outcome.repaired ? "GREEN" : "RED",
        evidence: `DEBUG ${note.gate} (${note.kind}): ${outcome.evidence}`,
        ...(outcome.tokens ? { tokens: outcome.tokens } : {})
      };
    },
    ship: async () => {
      if (input.ship) {
        return input.ship();
      }
      // Presence-detecting SHIP: git → gated delivery (default), else a durable on-disk record.
      // Roll up the stages recorded so far so the change-record carries a real verdict,
      // not the schema default (any RED → RED, any YELLOW → YELLOW, else GREEN).
      const shipVerdict: StageVerdict = stages.some((s) => s.verdict === "RED")
        ? "RED"
        : stages.some((s) => s.verdict === "YELLOW")
          ? "YELLOW"
          : "GREEN";
      const payload = ChangeRecordSchema.parse({
        taskId: selectedTaskId,
        summary: `dev-cycle delivery for ${selectedTaskId}`,
        overallVerdict: shipVerdict,
        stages: stages.map((s) => ({ stage: s.stage, verdict: s.verdict, evidence: s.evidence }))
      });
      // Default: compose gated git delivery so SHIP can actually push when granted.
      // Callers still override via shipDeps.gitDelivery (tests inject fakes).
      const gitDelivery =
        input.shipDeps?.gitDelivery ??
        makeGatedGitDelivery({
          cwd,
          policy,
          payload,
          runGit: (args, gitCwd) => {
            try {
              const stdout = execFileSync("git", [...args], {
                cwd: gitCwd,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
                // Bound stalled push/fetch so SHIP cannot hang the cycle forever.
                timeout: 120_000,
                maxBuffer: 8 * 1024 * 1024
              });
              return { exitCode: 0, stdout, stderr: "" };
            } catch (error) {
              const err = error as { status?: number; stdout?: string; stderr?: string; message?: string };
              return {
                exitCode: typeof err.status === "number" ? err.status : 1,
                stdout: typeof err.stdout === "string" ? err.stdout : "",
                stderr: typeof err.stderr === "string" ? err.stderr : (err.message ?? String(error))
              };
            }
          }
        });
      const result = await runShipStage({
        cwd,
        payload,
        ...input.shipDeps,
        gitDelivery
      });
      return { verdict: result.verdict, evidence: `${result.evidence}${result.recordPath ? ` → ${result.recordPath}` : ""}` };
    },
    learn: async () => {
      if (input.learn) {
        return input.learn();
      }
      // Reaching LEARN means the cycle shipped. Record one fact (validated iff clean-GREEN).
      const softVerdict: StageVerdict = stages.some((s) => s.verdict === "YELLOW") ? "YELLOW" : "GREEN";
      learnedFact = deriveLearning({ taskId: selectedTaskId, terminal: "done", verdict: softVerdict });
      if (input.recordFact) {
        await input.recordFact(learnedFact);
      }
      // Carry the cycle's rolled-up verdict so a clean run can actually report GREEN.
      return { verdict: softVerdict, evidence: `LEARN: ${learnedFact.fact} (${learnedFact.confidence})` };
    },
    done: async () => ({ verdict: "GREEN", evidence: "done" }),
    blocked: async () => ({ verdict: "RED", evidence: "blocked" })
  };
  const runners: Record<DevStage, StageRunner> = { ...defaults, ...input.stages };

  const overallFor = (terminalStage: DevStage): StageVerdict => {
    if (terminalStage !== "done") {
      return "RED";
    }
    const reachedWork = stages.some((outcome) => outcome.stage !== "select");
    if (!reachedWork) {
      return "YELLOW";
    }
    return stages.some((outcome) => outcome.verdict === "YELLOW") ? "YELLOW" : "GREEN";
  };

  let guard = 0;
  let canPersistTerminalCheckpoint = true;
  // Hard backstop against a malformed transition table (the budget is the real bound).
  for (; !isTerminal(stage) && guard < 100; guard += 1) {
    const resumingCapturedAttempt =
      preserveAttemptForInterruptedStage &&
      continuationStage === stage &&
      continuationSessionId !== null &&
      executorSessionId === continuationSessionId;
    const snapshot = budget.snapshot();
    const exhausted = resumingCapturedAttempt
      ? snapshot.tokens >= snapshot.tokenBudget
        ? `token budget exhausted (${snapshot.tokens}/${snapshot.tokenBudget})`
        : snapshot.elapsedMs >= snapshot.wallClockMs
          ? `wall-clock exceeded (${snapshot.elapsedMs}ms/${snapshot.wallClockMs}ms)`
          : null
      : budget.exhaustedReason();
    if (exhausted) {
      stages.push({ stage, verdict: "RED", evidence: `budget exhausted: ${exhausted}` });
      stage = "blocked";
      // Budget exhaustion occurs before the current stage runs, so it is not a
      // reducer outcome. Preserve the last valid pending/running checkpoint
      // rather than forge a terminal history that never transitioned here.
      canPersistTerminalCheckpoint = false;
      break;
    }

    if (CONSUMES_ATTEMPT.has(stage) && !preserveAttemptForInterruptedStage) {
      budget.recordAttempt();
    }
    if ((stage === "build" || stage === "debug") && continuationStage !== stage) {
      executorSessionId = null;
    }

    const completedStage = stage;
    await saveCheckpoint({ stage: completedStage, stageState: "running", status: "running", verdict: null });
    const result = await runners[completedStage]();
    stages.push({ stage: completedStage, verdict: result.verdict, evidence: result.evidence });
    if (result.tokens) {
      budget.recordTokens(result.tokens);
    }
    preserveAttemptForInterruptedStage = false;
    stage = nextStage(completedStage, result.verdict);
    if (isTerminal(stage)) {
      await saveCheckpoint({
        stage,
        stageState: "completed",
        status: stage === "done" ? "done" : "blocked",
        verdict: overallFor(stage)
      });
    } else {
      await saveCheckpoint({ stage, stageState: "pending", status: "running", verdict: null });
    }
    input.onStage?.({
      index: stages.length - 1,
      stage: completedStage,
      verdict: result.verdict,
      evidence: result.evidence,
      budget: budget.snapshot()
    });
  }

  if (!isTerminal(stage)) {
    stages.push({ stage, verdict: "RED", evidence: "dev-cycle transition guard exhausted" });
    stage = "blocked";
    canPersistTerminalCheckpoint = false;
  }

  const blocked = stage !== "done";
  // A "done" cycle that never got past SELECT (no ready task) did no work — that is YELLOW,
  // not a false GREEN. A DEBUG-recovered cycle DID reach work and ends clean, so its healed
  // TEST-RED (still in `stages`) must not drag the verdict to RED — hence the reachedWork guard.
  const reachedWork = stages.some((s) => s.stage !== "select");
  const overall: StageVerdict = blocked ? "RED" : !reachedWork ? "YELLOW" : overallFor(stage);

  // A blocked cycle still learns: record the blocker so the next SELECT deprioritises this task.
  if (blocked && !learnedFact) {
    const lastStage = stages[stages.length - 1];
    learnedFact = deriveLearning({
      taskId: selectedTaskId,
      terminal: "blocked",
      verdict: "RED",
      note: lastStage ? `${lastStage.stage}: ${lastStage.evidence}` : "no stages ran"
    });
    if (input.recordFact) {
      await input.recordFact(learnedFact);
    }
  }

  if (canPersistTerminalCheckpoint) {
    await saveCheckpoint({
      stage,
      stageState: "completed",
      status: blocked ? "blocked" : "done",
      verdict: overall
    });
  }

  return {
    cycleId,
    verdict: overall,
    terminal: blocked ? "blocked" : "done",
    stages,
    budget: budget.snapshot(),
    executor: executorReport,
    learned: learnedFact,
    ledger: input.ledger?.entries() ?? [],
    summary: `dev cycle ${blocked ? "blocked" : "completed"} (${overall}) after ${stages.length} stage(s).`
  };
}

import { loadHarnessConfig } from "../config/loadConfig.js";
import type { PlannerModelConfig } from "../model/schemas.js";
import { createDonePacket } from "../core/donePacket.js";
import type { DonePacket } from "../core/types.js";
import { runGitPrAutomation, type GitPrAutomationReport } from "../git/prAutomation.js";
import { createSelfBuildState, type SelfBuildTask } from "../kernel/selfBuildLoop.js";
import { createInMemoryOperationalStore, type OperationalStore } from "../operational/store.js";
import type { OperationalImplementation, RecordedBlocker } from "../operational/schemas.js";
import { createPlannerModelFromConfig, type PlannerModelFetch } from "../model/openAiCompatiblePlannerModel.js";
import type { PlannerModel } from "../planner/runtime.js";
import type { PlannerRunReport } from "../planner/schemas.js";
import { runReviewGates, type CommandExecutor, type ReviewGatesReport } from "../review/gates.js";
import {
  buildSessionObservabilitySummary,
  createOperationalSessionPersistenceStore,
  type PersistedRunProgressStatus,
  type SessionObservabilitySummary,
  type SessionPersistenceStore
} from "../runtime/persistence.js";
import { createHarnessRuntime } from "../runtime/session.js";
import type { HarnessSession, StartHarnessSessionOptions } from "../runtime/schemas.js";
import { detectPotentialSecrets, isRiskyPath } from "../safety/policyGuard.js";

type PlannerModelCandidate = Readonly<{
  readonly label: string;
  readonly model: PlannerModel;
}>;

export interface SelfBuildExecutorGitOptions {
  readonly enabled?: boolean;
  readonly dryRun?: boolean;
  readonly baseBranch?: string;
  readonly branchName?: string;
  readonly commitMessage?: string;
  readonly prTitle?: string;
  readonly prBody?: string;
  readonly paths?: readonly string[];
}

export interface RunSelfBuildExecutorOptions {
  readonly cwd?: string;
  readonly configPath?: string;
  readonly targetPath?: string;
  readonly taskId?: string;
  readonly objective?: string;
  readonly projectSlug?: string;
  readonly plannerModel?: PlannerModel;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: PlannerModelFetch;
  readonly operationalStore?: OperationalStore;
  readonly sessionPersistenceStore?: SessionPersistenceStore;
  readonly commandExecutor?: CommandExecutor;
  readonly includeReviewGate?: boolean;
  readonly maxPlannerSteps?: number;
  readonly maxPlannerRetries?: number;
  readonly git?: SelfBuildExecutorGitOptions;
  readonly allowDirtyWorkspace?: boolean;
  readonly allowRiskyPaths?: boolean;
  readonly resumeSessionId?: string;
}

export interface PlannerFallbackAttempt {
  readonly attempt: number;
  readonly providerLabel: string;
  readonly candidateIndex: number;
  readonly retryIndex: number;
  readonly status: PlannerRunReport["status"];
  readonly failureReason?: PlannerRunReport["failureReason"];
  readonly blockerCount: number;
}

export interface PlannerFallbackAlarm {
  readonly severity: "info" | "warning" | "critical";
  readonly code: "provider-retry-used" | "provider-fallback-used" | "provider-fallback-exhausted";
  readonly message: string;
}

export interface PlannerFallbackPlaybook {
  readonly strategy: "primary-then-retry-then-fallback";
  readonly totalAttempts: number;
  readonly selectedProviderLabel: string | null;
  readonly usedFallbackProvider: boolean;
  readonly exhausted: boolean;
  readonly alarms: readonly PlannerFallbackAlarm[];
  readonly recoveryNarrative: string;
  readonly attempts: readonly PlannerFallbackAttempt[];
}

export interface SelfBuildExecutorReport {
  readonly verdict: "GREEN" | "YELLOW" | "RED";
  readonly session: HarnessSession;
  readonly planner: PlannerRunReport;
  readonly plannerFallback: PlannerFallbackPlaybook | null;
  readonly observability: SessionObservabilitySummary;
  readonly reviewGates: ReviewGatesReport | null;
  readonly gitPr: GitPrAutomationReport | null;
  readonly implementation: OperationalImplementation;
  readonly blocker: RecordedBlocker | null;
  readonly donePacket: DonePacket;
  readonly summary: string;
  readonly nextActions: readonly string[];
}

const DEFAULT_PROJECT_SLUG = "guruharness";
const EXECUTOR_SOURCE = "self-build-executor";

interface PlannerRunMetadata {
  readonly providerLabel: string;
  readonly attempts: number;
  readonly playbook: PlannerFallbackPlaybook;
}

export async function runSelfBuildExecutor(options: RunSelfBuildExecutorOptions): Promise<SelfBuildExecutorReport> {
  const cwd = options.cwd ?? process.cwd();
  const projectSlug = options.projectSlug ?? DEFAULT_PROJECT_SLUG;
  const operationalStore = options.operationalStore ?? createInMemoryOperationalStore();
  const sessionPersistenceStore = options.sessionPersistenceStore ?? createOperationalSessionPersistenceStore(operationalStore, projectSlug);
  const configResult = loadHarnessConfig({
    cwd,
    ...(options.configPath ? { configPath: options.configPath } : {})
  });

  const runtime = createHarnessRuntime({
    operationalStore,
    sessionPersistenceStore,
    ...(options.commandExecutor ? { commandExecutor: options.commandExecutor } : {})
  });
  return runSelfBuildExecutorWithRuntime(runtime, configResult, options, { cwd, projectSlug, operationalStore, sessionPersistenceStore });
}

interface ExecutorRuntimeContext {
  readonly cwd: string;
  readonly projectSlug: string;
  readonly operationalStore: OperationalStore;
  readonly sessionPersistenceStore: SessionPersistenceStore;
}

async function runSelfBuildExecutorWithRuntime(
  runtime: ReturnType<typeof createHarnessRuntime>,
  configResult: ReturnType<typeof loadHarnessConfig>,
  options: RunSelfBuildExecutorOptions,
  context: ExecutorRuntimeContext
): Promise<SelfBuildExecutorReport> {
  const { cwd, projectSlug, operationalStore, sessionPersistenceStore } = context;

  const startSessionOptions: StartHarnessSessionOptions = {
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.targetPath ? { targetPath: options.targetPath } : {}),
    ...(options.taskId ? { taskId: options.taskId } : {}),
    projectSlug,
    cwd
  };

  const { session, resumed } = await startOrResumeSession(runtime, {
    ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
    options: startSessionOptions
  });

  if (options.resumeSessionId && !resumed) {
    await recordProgressBeacon(sessionPersistenceStore, session.id, "session-continuity", "blocked", "Requested resume session was not found; started a new blocked continuity report.", {
      requestedSessionId: options.resumeSessionId
    });

    return recordDonePacketAndReturn(
      await buildBlockedReport({
        session,
        planner: createBlockedPlannerReport(
          session,
          "Self-build executor blocked because the requested resume session was not found.",
          [
            `Requested resumeSessionId was not found: ${options.resumeSessionId}`,
            "Start a new run without --resume-session, or provide an existing persisted session id."
          ],
          "missing-session"
        ),
        operationalStore,
        projectSlug,
        stage: "session-continuity"
      }),
      sessionPersistenceStore
    );
  }

  await recordProgressBeacon(sessionPersistenceStore, session.id, "session", "completed", resumed ? "Harness session resumed." : "Harness session started.", {
    resumed
  });

  const task = session.task ? findSelfBuildTask(session.task.id) : null;
  const objective = options.objective ?? buildTaskObjective(task, session);

  const safetyBlockers = collectRunSafetyBlockers({
    session,
    task,
    objective,
    ...(options.targetPath ? { targetPath: options.targetPath } : {}),
    allowDirtyWorkspace: options.allowDirtyWorkspace ?? configResult.config.runtimeHardening.allowDirtyWorkspace,
    allowRiskyPaths: options.allowRiskyPaths ?? configResult.config.runtimeHardening.allowRiskyPaths,
    riskyPathPatterns: configResult.config.runtimeHardening.riskyPathPatterns,
    secretAllowList: configResult.config.runtimeHardening.secretAllowList,
    ...(options.git ? { gitOptions: options.git } : {})
  });

  if (safetyBlockers.length > 0) {
    await recordProgressBeacon(sessionPersistenceStore, session.id, "safety-check", "blocked", "Runtime safety gates blocked planner execution.", {
      blockerCount: safetyBlockers.length
    });

    return recordDonePacketAndReturn(
      await buildBlockedReport({
        session,
        planner: createBlockedPlannerReport(session, "Self-build executor blocked during safety-check before planner execution.", safetyBlockers, "unknown"),
        operationalStore,
        projectSlug,
        stage: "safety-check"
      }),
      sessionPersistenceStore
    );
  }

  const plannerModelCandidates = resolvePlannerModelCandidates(
    options.plannerModel,
    configResult.config.plannerModel,
    configResult.config.plannerModelFallbacks,
    {
      ...(options.env ? { env: options.env } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {})
    }
  );

  if (plannerModelCandidates.length === 0) {
    await recordProgressBeacon(sessionPersistenceStore, session.id, "model-adapter", "blocked", "No planner model candidates resolved for this run.", {});

    return recordDonePacketAndReturn(
      await buildMissingModelReport({
        session,
        operationalStore,
        projectSlug,
        objective,
        configStatus: configResult.status,
        configDiagnostics: configResult.diagnostics
      }),
      sessionPersistenceStore
    );
  }

  await recordProgressBeacon(sessionPersistenceStore, session.id, "planner", "started", "Planner execution started.", {
    candidateCount: plannerModelCandidates.length
  });

  const planner = await runPlannerWithRetries({
    session,
    objective,
    ...(options.maxPlannerSteps !== undefined ? { maxSteps: options.maxPlannerSteps } : {}),
    planners: plannerModelCandidates,
    sameProviderRetries: options.maxPlannerRetries ?? configResult.config.runtimeHardening.plannerMaxRetries,
    operationalStore,
    sessionPersistenceStore,
    ...(options.commandExecutor ? { commandExecutor: options.commandExecutor } : {})
  });

  if (planner.report.status === "blocked") {
    await recordProgressBeacon(sessionPersistenceStore, session.id, "planner", "blocked", "Planner execution blocked.", {
      providerLabel: planner.providerLabel,
      attempts: planner.attempts,
      failureReason: planner.report.failureReason ?? "unknown"
    });

    return recordDonePacketAndReturn(
      await buildBlockedReport({
        session,
        planner: planner.report,
        operationalStore,
        projectSlug,
        stage: `planner (${planner.providerLabel})`,
        plannerFallback: planner.playbook,
        extraRisks: planner.attempts > 1 ? [`Planner retried ${planner.attempts - 1} time(s) before blocking.`] : []
      }),
      sessionPersistenceStore
    );
  }

  await recordProgressBeacon(sessionPersistenceStore, session.id, "planner", "completed", "Planner execution completed.", {
    providerLabel: planner.providerLabel,
    attempts: planner.attempts
  });
  await recordProgressBeacon(sessionPersistenceStore, session.id, "review-gates", "started", "Review gates started.", {});

  const reviewGates = await runReviewGates(configResult.config, {
    cwd,
    includeReviewGate: options.includeReviewGate ?? true,
    ...(options.commandExecutor ? { executor: options.commandExecutor } : {})
  });

  if (reviewGates.verdict === "RED") {
    await recordProgressBeacon(sessionPersistenceStore, session.id, "review-gates", "blocked", "Review gates blocked handoff.", {
      verdict: reviewGates.verdict
    });

    return recordDonePacketAndReturn(
      await buildBlockedReport({
        session,
        planner: planner.report,
        reviewGates,
        operationalStore,
        projectSlug,
        stage: "review-gates",
        plannerFallback: planner.playbook,
        extraRisks: [
          "Review gates failed; handoff remains pending."
        ]
      }),
      sessionPersistenceStore
    );
  }

  await recordProgressBeacon(sessionPersistenceStore, session.id, "review-gates", "completed", "Review gates completed.", {
    verdict: reviewGates.verdict
  });

  if (options.git?.enabled && options.git.dryRun === false && !configResult.config.approvalPolicy.autoCommitPushPr) {
    await recordProgressBeacon(sessionPersistenceStore, session.id, "git-pr-approval", "blocked", "Live git/PR automation is disabled by approval policy.", {});

    return recordDonePacketAndReturn(
      await buildBlockedReport({
        session,
        planner: planner.report,
        reviewGates,
        operationalStore,
        projectSlug,
        stage: "git-pr-approval",
        plannerFallback: planner.playbook,
        extraRisks: ["Live git/PR automation is disabled by approvalPolicy.autoCommitPushPr."]
      }),
      sessionPersistenceStore
    );
  }

  if (options.git?.enabled) {
    await recordProgressBeacon(sessionPersistenceStore, session.id, "git-pr", "started", "Git/PR automation started.", {
      dryRun: options.git.dryRun ?? true
    });
  }

  const gitPr = options.git?.enabled
    ? await runGitPrAutomation(
        {
          repoRoot: session.repo?.repoRoot ?? cwd,
          baseBranch: options.git.baseBranch ?? "main",
          branchName: options.git.branchName ?? `feat/${session.task?.id ?? "self-build"}`,
          commitMessage: options.git.commitMessage ?? `feat: ${session.task?.title ?? "self-build task"}`,
          prTitle: options.git.prTitle ?? `feat: ${session.task?.title ?? "self-build task"}`,
          prBody: options.git.prBody ?? buildPrBody(session, planner.report, reviewGates),
          paths: options.git.paths ?? [],
          dryRun: options.git.dryRun ?? true
        },
        { ...(options.commandExecutor ? { executor: options.commandExecutor } : {}) }
      )
    : null;

  if (gitPr?.verdict === "RED") {
    await recordProgressBeacon(sessionPersistenceStore, session.id, "git-pr", "blocked", "Git/PR automation blocked handoff.", {
      verdict: gitPr.verdict
    });

    return recordDonePacketAndReturn(
      await buildBlockedReport({
        session,
        planner: planner.report,
        reviewGates,
        gitPr,
        operationalStore,
        projectSlug,
        stage: "git-pr",
        plannerFallback: planner.playbook,
        extraRisks: [
          "Git/PR automation failed; resolve git blockers before continuing."
        ]
      }),
      sessionPersistenceStore
    );
  }

  await recordProgressBeacon(sessionPersistenceStore, session.id, options.git?.enabled ? "git-pr" : "run", "completed", options.git?.enabled ? "Git/PR automation completed." : "Run completed without git/PR automation.", {
    ...(gitPr ? { verdict: gitPr.verdict, dryRun: gitPr.dryRun } : {})
  });

  const completedReport = await buildCompletedReport({
    session,
    planner: planner.report,
    reviewGates,
    gitPr,
    operationalStore,
    projectSlug,
    plannerMetadata: planner
  });

  return recordDonePacketAndReturn(completedReport, sessionPersistenceStore);
}

async function startOrResumeSession(runtime: ReturnType<typeof createHarnessRuntime>, options: {
  readonly resumeSessionId?: string;
  readonly options: StartHarnessSessionOptions;
}): Promise<{ session: HarnessSession; resumed: boolean }> {
  if (!options.resumeSessionId) {
    const session = await runtime.startSession(options.options);
    return { session, resumed: false };
  }

  const resumed = await runtime.resumeSession(options.resumeSessionId, options.options);
  if (resumed) {
    return { session: resumed, resumed: true };
  }

  // Explicit fallback: caller will decide whether to treat as YELLOW/RED for continuity
  const session = await runtime.startSession(options.options);
  return { session, resumed: false };
}

function resolvePlannerModelCandidates(
  injectedModel: PlannerModel | undefined,
  primaryConfig: PlannerModelConfig | undefined,
  fallbackConfigs: readonly PlannerModelConfig[],
  fetchContext: { readonly env?: Readonly<Record<string, string | undefined>>; readonly fetch?: PlannerModelFetch }
): readonly PlannerModelCandidate[] {
  const candidates: PlannerModelCandidate[] = [];

  if (injectedModel) {
    candidates.push({ label: "injected", model: injectedModel });

    return candidates;
  }

  const primaryModel = createPlannerModelFromConfig(primaryConfig, fetchContext);
  if (primaryModel) {
    candidates.push({ label: "config-primary", model: primaryModel });
  }

  for (const [index, config] of fallbackConfigs.entries()) {
    const fallbackModel = createPlannerModelFromConfig(config, fetchContext);
    if (fallbackModel) {
      candidates.push({ label: `config-fallback-${index + 1}`, model: fallbackModel });
    }
  }

  return candidates;
}

async function runPlannerWithRetries(options: {
  readonly session: HarnessSession;
  readonly objective: string;
  readonly maxSteps?: number;
  readonly planners: readonly PlannerModelCandidate[];
  readonly sameProviderRetries: number;
  readonly operationalStore: OperationalStore;
  readonly sessionPersistenceStore: SessionPersistenceStore;
  readonly commandExecutor?: CommandExecutor;
}): Promise<{ readonly report: PlannerRunReport; readonly providerLabel: string; readonly attempts: number; readonly playbook: PlannerFallbackPlaybook }> {
  let attempts = 0;
  const attemptRecords: PlannerFallbackAttempt[] = [];

  for (const [candidateIndex, plannerCandidate] of options.planners.entries()) {
    const maxSameProviderAttempts = Math.max(1, options.sameProviderRetries);

    for (let retry = 0; retry < maxSameProviderAttempts; retry += 1) {
      attempts += 1;
      const plannerRuntime = createHarnessRuntime({
        operationalStore: options.operationalStore,
        sessionPersistenceStore: options.sessionPersistenceStore,
        ...(options.commandExecutor ? { commandExecutor: options.commandExecutor } : {}),
        plannerModel: plannerCandidate.model
      });
      const resumed = await plannerRuntime.resumeSession(options.session.id);
      if (!resumed) {
        const report = createBlockedPlannerReport(
          options.session,
          options.objective,
          [`Planner runtime could not resume session before planning: ${options.session.id}`],
          "missing-session"
        );
        attemptRecords.push(buildPlannerFallbackAttempt(report, plannerCandidate.label, candidateIndex, retry, attempts));

        return {
          report,
          providerLabel: plannerCandidate.label,
          attempts,
          playbook: buildPlannerFallbackPlaybook({ attempts: attemptRecords, selectedProviderLabel: null, exhausted: true })
        };
      }

      const planner = await plannerRuntime.runPlanner(options.session.id, {
        objective: options.objective,
        ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {})
      });
      attemptRecords.push(buildPlannerFallbackAttempt(planner, plannerCandidate.label, candidateIndex, retry, attempts));

      if (planner.status === "completed") {
        return {
          report: planner,
          providerLabel: plannerCandidate.label,
          attempts,
          playbook: buildPlannerFallbackPlaybook({ attempts: attemptRecords, selectedProviderLabel: plannerCandidate.label, exhausted: false })
        };
      }

      if (!shouldRetrySameProvider(planner) || retry >= maxSameProviderAttempts - 1) {
        if (!shouldTryFallbackProvider(planner)) {
          return {
            report: planner,
            providerLabel: plannerCandidate.label,
            attempts,
            playbook: buildPlannerFallbackPlaybook({ attempts: attemptRecords, selectedProviderLabel: null, exhausted: true })
          };
        }

        break;
      }
    }
  }

  const fallbackError: PlannerRunReport = {
    sessionId: options.session.id,
    objective: options.objective,
    status: "blocked",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 0,
    plan: null,
    observations: [],
    blockers: ["No planner model candidates were available to retry this run."],
    failureReason: "missing-model",
    nextActions: ["Add a valid planner candidate or inject a PlannerModel before rerunning."]
  };

  return {
    report: fallbackError,
    providerLabel: "none",
    attempts,
    playbook: buildPlannerFallbackPlaybook({ attempts: attemptRecords, selectedProviderLabel: null, exhausted: true })
  };
}

function buildPlannerFallbackAttempt(
  report: PlannerRunReport,
  providerLabel: string,
  candidateIndex: number,
  retryIndex: number,
  attempt: number
): PlannerFallbackAttempt {
  return {
    attempt,
    providerLabel,
    candidateIndex,
    retryIndex,
    status: report.status,
    ...(report.failureReason ? { failureReason: report.failureReason } : {}),
    blockerCount: report.blockers.length
  };
}

function buildPlannerFallbackPlaybook(options: {
  readonly attempts: readonly PlannerFallbackAttempt[];
  readonly selectedProviderLabel: string | null;
  readonly exhausted: boolean;
}): PlannerFallbackPlaybook {
  const usedFallbackProvider = options.selectedProviderLabel?.startsWith("config-fallback-") ?? false;
  const retriedProvider = options.attempts.some((attempt) => attempt.retryIndex > 0);
  const alarms: PlannerFallbackAlarm[] = [];

  if (retriedProvider) {
    alarms.push({
      severity: "info",
      code: "provider-retry-used",
      message: "Planner recovered or continued after retrying a provider candidate."
    });
  }

  if (usedFallbackProvider) {
    alarms.push({
      severity: "warning",
      code: "provider-fallback-used",
      message: "Planner completed by rotating to a configured fallback provider."
    });
  }

  if (options.exhausted) {
    alarms.push({
      severity: "critical",
      code: "provider-fallback-exhausted",
      message: "Planner exhausted all retry and fallback candidates without completing."
    });
  }

  return {
    strategy: "primary-then-retry-then-fallback",
    totalAttempts: options.attempts.length,
    selectedProviderLabel: options.selectedProviderLabel,
    usedFallbackProvider,
    exhausted: options.exhausted,
    alarms,
    recoveryNarrative: buildPlannerFallbackRecoveryNarrative({
      attempts: options.attempts,
      selectedProviderLabel: options.selectedProviderLabel,
      usedFallbackProvider,
      exhausted: options.exhausted
    }),
    attempts: [...options.attempts]
  };
}

function buildPlannerFallbackRecoveryNarrative(options: {
  readonly attempts: readonly PlannerFallbackAttempt[];
  readonly selectedProviderLabel: string | null;
  readonly usedFallbackProvider: boolean;
  readonly exhausted: boolean;
}): string {
  if (options.exhausted) {
    return "All planner providers failed. Inspect failure reasons, repair provider credentials/model output, add another fallback, then rerun from the persisted session.";
  }

  if (options.usedFallbackProvider) {
    return "The primary planner path failed but a configured fallback completed the run. Treat the primary provider as degraded before starting long-running autonomous work.";
  }

  if (options.attempts.some((attempt) => attempt.retryIndex > 0)) {
    return "The selected planner provider completed after retry. Monitor for recurring transient model failures before scaling the run duration.";
  }

  return `Planner completed without provider rotation via ${options.selectedProviderLabel ?? "the selected provider"}.`;
}

function buildPlannerFallbackRiskSummaries(playbook: PlannerFallbackPlaybook | null): string[] {
  return playbook?.alarms.map((alarm) => `Planner fallback ${alarm.severity} alarm (${alarm.code}): ${alarm.message}`) ?? [];
}

function shouldRetrySameProvider(planner: PlannerRunReport): boolean {
  return planner.failureReason === "model-threw";
}

function shouldTryFallbackProvider(planner: PlannerRunReport): boolean {
  return planner.failureReason === "model-threw" || planner.failureReason === "invalid-plan" || planner.failureReason === "missing-model";
}

async function recordDonePacketAndReturn(
  report: SelfBuildExecutorReport,
  sessionPersistenceStore: SessionPersistenceStore
): Promise<SelfBuildExecutorReport> {
  await sessionPersistenceStore.recordDonePacket(report.session.id, report.donePacket);
  const events = await sessionPersistenceStore.listEvents(report.session.id);

  return { ...report, observability: buildSessionObservabilitySummary(report.session.id, events) };
}

async function recordProgressBeacon(
  sessionPersistenceStore: SessionPersistenceStore,
  sessionId: string,
  stage: string,
  status: PersistedRunProgressStatus,
  message: string,
  metadata: Readonly<Record<string, unknown>>
): Promise<void> {
  await sessionPersistenceStore.recordRunProgress(sessionId, {
    stage,
    status,
    message,
    recordedAt: new Date().toISOString(),
    metadata: { ...metadata }
  });
}

async function buildMissingModelReport(options: {
  readonly session: HarnessSession;
  readonly operationalStore: OperationalStore;
  readonly projectSlug: string;
  readonly objective: string;
  readonly configStatus: string;
  readonly configDiagnostics: readonly string[];
}): Promise<SelfBuildExecutorReport> {
  const blockerBody = [
    "No planner model was injected and no usable plannerModel config is available.",
    ...options.configDiagnostics
  ].filter(Boolean);

  const planner = {
    sessionId: options.session.id,
    objective: options.objective ?? options.session.task?.description ?? options.session.task?.title ?? options.session.task?.id ?? "Run self-build task.",
    status: "blocked" as const,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 0,
    plan: null,
    observations: [],
    blockers: blockerBody.length > 0 ? blockerBody : [
      `No planner model was injected and no usable plannerModel config is available (config status: ${options.configStatus}).`
    ],
    failureReason: "missing-model",
    nextActions: ["Configure plannerModel / plannerModelFallbacks or inject a PlannerModel, then rerun the self-build executor."]
  } satisfies PlannerRunReport;

  return buildBlockedReport({
    session: options.session,
    planner,
    operationalStore: options.operationalStore,
    projectSlug: options.projectSlug,
    stage: "model-adapter"
  });
}

function findSelfBuildTask(taskId: string): SelfBuildTask | null {
  return createSelfBuildState().tasks.find((task) => task.id === taskId) ?? null;
}

function buildTaskObjective(task: SelfBuildTask | null, session: HarnessSession): string {
  if (!task) {
    return `Execute GuruHarness session task ${session.task?.id ?? "unknown"}.`;
  }

  return `${task.title}: ${task.description} Contribution toward THERE: ${task.thereContribution}`;
}

function createBlockedPlannerReport(
  session: HarnessSession,
  objective: string,
  blockers: readonly string[],
  failureReason: PlannerRunReport["failureReason"] = "unknown"
): PlannerRunReport {
  return {
    sessionId: session.id,
    objective,
    status: "blocked",
    failureReason,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 0,
    plan: null,
    observations: [],
    blockers: [...blockers],
    nextActions: ["Resolve the blocker, then rerun the self-build executor."]
  };
}

function collectRunSafetyBlockers(options: {
  readonly session: HarnessSession;
  readonly task: SelfBuildTask | null;
  readonly objective: string;
  readonly targetPath?: string;
  readonly allowDirtyWorkspace: boolean;
  readonly allowRiskyPaths: boolean;
  readonly riskyPathPatterns: readonly string[];
  readonly secretAllowList: readonly string[];
  readonly gitOptions?: SelfBuildExecutorGitOptions;
}): string[] {
  const blockers: string[] = [];

  if (!options.allowDirtyWorkspace && options.session.repo && isWorkingDirectoryDirty(options.session.repo.gitStatus)) {
    blockers.push("Refusing to run on dirty workspace; set --allow-dirty-workspace or runtimeHardening.allowDirtyWorkspace only after reviewing the diff.");
  }

  const riskyPath = options.targetPath ?? options.session.repo?.targetPath;
  if (!options.allowRiskyPaths && riskyPath && isRiskyPath(riskyPath, options.riskyPathPatterns)) {
    blockers.push("Target path is blocked by risky-path policy (path redacted); set --allow-risky-paths or runtimeHardening.allowRiskyPaths only after reviewing the path.");
  }

  // Also guard explicit git paths (e.g. --git-path .env) before git automation.
  for (const gitPath of options.gitOptions?.paths ?? []) {
    if (!options.allowRiskyPaths && isRiskyPath(gitPath, options.riskyPathPatterns)) {
      blockers.push("Git path is blocked by risky-path policy (path redacted); set --allow-risky-paths or runtimeHardening.allowRiskyPaths only after reviewing the path.");
    }
  }

  const riskyInputs = detectPotentialSecrets(
    [
      { name: "objective", value: options.objective ?? "" },
      { name: "task-id", value: options.task?.id ?? "" },
      { name: "branch-name", value: options.gitOptions?.branchName ?? "" },
      { name: "commit-message", value: options.gitOptions?.commitMessage ?? "" },
      { name: "pr-title", value: options.gitOptions?.prTitle ?? "" },
      { name: "pr-body", value: options.gitOptions?.prBody ?? "" },
      ...(options.gitOptions?.paths?.map((path) => ({ name: "git-path", value: path })) ?? [])
    ],
    options.secretAllowList
  );

  for (const detection of riskyInputs) {
    // Never leak the actual value into persisted records or operator output.
    blockers.push(`Potential secret or sensitive value detected in ${detection.name} (${detection.kind}; value redacted)`);
  }

  return blockers;
}

function isWorkingDirectoryDirty(gitStatus: string): boolean {
  return gitStatus
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith("##")).length > 0;
}

async function buildBlockedReport(options: {
  readonly session: HarnessSession;
  readonly planner: PlannerRunReport;
  readonly plannerFallback?: PlannerFallbackPlaybook;
  readonly reviewGates?: ReviewGatesReport;
  readonly gitPr?: GitPrAutomationReport;
  readonly operationalStore: OperationalStore;
  readonly projectSlug: string;
  readonly stage: string;
  readonly extraRisks?: readonly string[];
}): Promise<SelfBuildExecutorReport> {
  const collectedBlockers = collectBlockers(options.planner, options.reviewGates ?? null, options.gitPr ?? null);
  const fallbackRisks = buildPlannerFallbackRiskSummaries(options.plannerFallback ?? null);
  const risks = [...collectedBlockers, ...(options.extraRisks ?? []), ...fallbackRisks];
  const blockerBody = risks.join("\n");
  const metadata = {
    sessionId: options.session.id,
    stage: options.stage,
    ...(options.plannerFallback ? { plannerFallback: options.plannerFallback } : {})
  };
  const blocker = await options.operationalStore.recordBlocker({
    projectSlug: options.projectSlug,
    title: `Self-build executor blocked at ${options.stage}`,
    body: blockerBody || `Self-build executor blocked at ${options.stage}.`,
    source: EXECUTOR_SOURCE,
    metadata
  });
  const implementation = await options.operationalStore.createImplementation({
    projectSlug: options.projectSlug,
    title: options.session.task?.title ?? "Self-build executor run",
    status: "blocked",
    summary: blockerBody || `Self-build executor blocked at ${options.stage}.`,
    metadata
  });
  const donePacket = createDonePacket({
    verdict: "RED",
    objective: options.planner.objective,
    changedFiles: [],
    verification: buildVerificationEvidence(options.reviewGates ?? null),
    review: buildReviewEvidence(options.reviewGates ?? null),
    risks,
    nextSteps: ["Resolve the blocker, then rerun the self-build executor."]
  });

  return {
    verdict: "RED",
    session: options.session,
    planner: options.planner,
    plannerFallback: options.plannerFallback ?? null,
    observability: buildSessionObservabilitySummary(options.session.id, []),
    reviewGates: options.reviewGates ?? null,
    gitPr: options.gitPr ?? null,
    implementation,
    blocker,
    donePacket,
    summary: `RED: self-build executor blocked at ${options.stage}.`,
    nextActions: ["Resolve the blocker, then rerun the self-build executor."]
  };
}

async function buildCompletedReport(options: {
  readonly session: HarnessSession;
  readonly planner: PlannerRunReport;
  readonly reviewGates: ReviewGatesReport;
  readonly gitPr: GitPrAutomationReport | null;
  readonly operationalStore: OperationalStore;
  readonly projectSlug: string;
  readonly plannerMetadata: PlannerRunMetadata;
}): Promise<SelfBuildExecutorReport> {
  const verdict = deriveCompletedVerdict(options.reviewGates, options.gitPr);
  const fallbackRisks = buildPlannerFallbackRiskSummaries(options.plannerMetadata.playbook);
  const implementation = await options.operationalStore.createImplementation({
    projectSlug: options.projectSlug,
    title: options.session.task?.title ?? "Self-build executor run",
    status: verdict === "GREEN" ? "in_review" : "in_progress",
    branchName: extractBranchName(options.gitPr),
    summary: buildImplementationSummary(options.planner, options.reviewGates, options.gitPr),
    metadata: {
      sessionId: options.session.id,
      plannerStatus: options.planner.status,
      plannerProvider: options.plannerMetadata.providerLabel,
      plannerAttempts: options.plannerMetadata.attempts,
      plannerFallback: options.plannerMetadata.playbook
    }
  });
  const nextSteps = buildCompletedNextSteps(verdict, options.plannerMetadata.playbook);
  const donePacket = createDonePacket({
    verdict,
    objective: options.planner.objective,
    changedFiles: buildChangedFiles(options.gitPr),
    verification: buildVerificationEvidence(options.reviewGates),
    review: buildReviewEvidence(options.reviewGates),
    risks: verdict === "GREEN" ? fallbackRisks : ["Git/PR automation was not executed live; handoff remains pending.", ...fallbackRisks],
    nextSteps
  });

  return {
    verdict,
    session: options.session,
    planner: options.planner,
    plannerFallback: options.plannerMetadata.playbook,
    observability: buildSessionObservabilitySummary(options.session.id, []),
    reviewGates: options.reviewGates,
    gitPr: options.gitPr,
    implementation,
    blocker: null,
    donePacket,
    summary: `${verdict}: self-build executor completed planner and review workflow.`,
    nextActions: donePacket.nextSteps
  };
}

function buildCompletedNextSteps(verdict: "GREEN" | "YELLOW" | "RED", playbook: PlannerFallbackPlaybook): string[] {
  const nextSteps =
    verdict === "GREEN"
      ? ["Monitor the upstream PR and merge gates."]
      : ["Enable non-dry-run git/PR automation after reviewing the planned delivery steps."];

  if (playbook.alarms.length > 0) {
    nextSteps.push("Review planner fallback playbook alarms before the next long-running run.");
  }

  return nextSteps;
}

function deriveCompletedVerdict(reviewGates: ReviewGatesReport, gitPr: GitPrAutomationReport | null): "GREEN" | "YELLOW" | "RED" {
  if (reviewGates.verdict === "RED" || gitPr?.verdict === "RED") {
    return "RED";
  }

  if (reviewGates.verdict === "YELLOW" || !gitPr || gitPr.dryRun) {
    return "YELLOW";
  }

  return "GREEN";
}

function buildVerificationEvidence(reviewGates: ReviewGatesReport | null): DonePacket["verification"] {
  if (!reviewGates) {
    return [];
  }

  return reviewGates.results
    .filter((result) => result.kind === "validation")
    .map((result) => ({
      command: result.command.join(" "),
      result: result.summary,
      passed: result.status === "passed"
    }));
}

function buildReviewEvidence(reviewGates: ReviewGatesReport | null): DonePacket["review"] {
  if (!reviewGates) {
    return [];
  }

  return reviewGates.results
    .filter((result) => result.kind === "review")
    .map((result) => ({
      reviewer: result.name,
      status: result.status === "passed" ? "passed" : "blocked",
      summary: result.summary
    }));
}

function buildChangedFiles(gitPr: GitPrAutomationReport | null): DonePacket["changedFiles"] {
  const gitAddStep = gitPr?.steps.find((step) => step.name === "git-add");
  const separatorIndex = gitAddStep?.command.indexOf("--") ?? -1;
  const paths = separatorIndex >= 0 ? gitAddStep?.command.slice(separatorIndex + 1) ?? [] : [];

  return paths.map((path) => ({ path, summary: "Included in self-build executor delivery." }));
}

function collectBlockers(
  planner: PlannerRunReport,
  reviewGates: ReviewGatesReport | null,
  gitPr: GitPrAutomationReport | null
): string[] {
  return [
    ...planner.blockers,
    ...(reviewGates?.results.filter((result) => result.status === "failed").map((result) => result.summary) ?? []),
    ...(gitPr?.steps.filter((step) => step.status === "failed").map((step) => step.summary) ?? [])
  ];
}

function extractBranchName(gitPr: GitPrAutomationReport | null): string | undefined {
  const pushStep = gitPr?.steps.find((step) => step.name === "git-push");

  return pushStep?.command.at(-1);
}

function buildImplementationSummary(
  planner: PlannerRunReport,
  reviewGates: ReviewGatesReport,
  gitPr: GitPrAutomationReport | null
): string {
  return [planner.status, reviewGates.summary, gitPr?.summary ?? "Git/PR automation not requested."].join(" | ");
}

function buildPrBody(session: HarnessSession, planner: PlannerRunReport, reviewGates: ReviewGatesReport): string {
  return [
    "## Summary",
    `- Self-build task: ${session.task?.id ?? "unknown"}`,
    `- Planner status: ${planner.status}`,
    `- Review gates: ${reviewGates.summary}`,
    "",
    "## Next",
    "- Monitor upstream merge gates."
  ].join("\n");
}

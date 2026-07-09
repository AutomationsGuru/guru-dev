import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

import { loadHarnessConfig } from "../config/loadConfig.js";
import type { RuntimeHardeningConfig } from "../config/schema.js";
import type { MandateDecision } from "../mandates/evaluate.js";
import { createDirectionAlignmentReport } from "../direction/hereThere.js";
import { applySelfBuildProgress, createSelfBuildState, planNextSelfBuildTask, type SelfBuildTask } from "../kernel/selfBuildLoop.js";
import { createInMemoryOperationalStore, type OperationalStore } from "../operational/store.js";
import { createBlockedPlannerRunReport, runPlannerExecution, type PlannerModel } from "../planner/runtime.js";
import {
  createOperationalSessionPersistenceStore,
  type PersistedSessionEvent,
  type PersistedSessionListItem,
  type PersistedSessionListOptions,
  type SessionPersistenceStore
} from "./persistence.js";
import { PlannerRunOptionsSchema, type PlannerRunOptions, type PlannerRunReport } from "../planner/schemas.js";
import { resolveRepositoryContext, type RepositoryContext } from "../repo/context.js";
import { discoverSkills, loadSkill } from "../skills/loader.js";
import type { SkillCatalog, SkillDocument, SkillLoaderOptions } from "../skills/schemas.js";
import { createFileEditTool } from "../tools/builtins/fileEditTool.js";
import { createGitPrAutomationTool } from "../tools/builtins/gitPrAutomationTool.js";
import { createGitHubPrCommentTool, createGitHubPrReviewTool, createGitHubPrStatusTool } from "../tools/builtins/githubPrTools.js";
import { createMaintenanceAuditTool } from "../tools/builtins/maintenanceAuditTool.js";
import {
  createCreateOperationalBacklogItemTool,
  createCreateOperationalImplementationTool,
  createGetOperationalProjectTool,
  createListOperationalBacklogItemsTool,
  createListOperationalStateSnapshotsTool,
  createRecordOperationalBlockerTool,
  createUpsertOperationalDecisionTool,
  createWriteOperationalStateSnapshotTool
} from "../tools/builtins/operationalStoreTools.js";
import { createRepoContextTool } from "../tools/builtins/repoContextTool.js";
import { createBaseTools } from "../tools/builtins/baseToolFactory.js";
import { createReviewGatesTool } from "../tools/builtins/reviewGatesTool.js";
import { createListSkillsTool, createLoadSkillTool } from "../tools/builtins/skillLoaderTools.js";
import { createShellExecTool } from "../tools/builtins/shellExecTool.js";
import { BashOptimizerConfigSchema, type BashOptimizerConfig } from "../tools/bashOptimizer.js";
import { createToolRegistry, executeRegisteredTool, type ToolObservation, type ToolRegistry } from "../tools/registry.js";
import { collectExtensionTools } from "../extensions/initExtensions.js";
import type { CommandExecutor } from "../review/gates.js";
import {
  HarnessSessionSchema,
  StartHarnessSessionOptionsSchema,
  type HarnessSession,
  type StartHarnessSessionOptions
} from "./schemas.js";

export interface HarnessRuntimeDependencies {
  readonly operationalStore?: OperationalStore;
  readonly sessionPersistenceStore?: SessionPersistenceStore;
  readonly commandExecutor?: CommandExecutor;
  readonly plannerModel?: PlannerModel;
  /**
   * Mandate enforcement policy (ADR 2026-07-05-composer-completion). When set,
   * executeTool evaluates evaluateToolMandate BEFORE running a tool and BLOCKS
   * (returns a failed observation, never executes) on deny/escalate — so the
   * mandate applies at EVERY surface, not just the REPL. The REPL leaves this
   * unset (its interactive approveTool governs); the api attaches the secure
   * headless floor. Returning null for a call = no policy for it (allowed).
   */
  readonly mandatePolicy?: (toolId: string, input: unknown, cwd: string) => MandateDecision | null;
}

export interface HarnessRuntime {
  startSession(options?: StartHarnessSessionOptions): Promise<HarnessSession>;
  resumeSession(sessionId: string, options?: StartHarnessSessionOptions): Promise<HarnessSession | undefined>;
  /**
   * Execute a tool for a session. The optional signal (review 2026-07-08) carries
   * the turn's abort so a long-running tool (bash) can kill its child on operator
   * cancel; absent for callers that don't track cancellation.
   */
  executeTool(sessionId: string, toolId: string, input: unknown, signal?: AbortSignal): Promise<ToolObservation>;
  /** Full tool definitions (with schemas) registered for a session — for model tool-calling. */
  getSessionTools(sessionId: string): readonly import("../tools/registry.js").ToolDefinition[];
  runPlanner(sessionId: string, options: PlannerRunOptions): Promise<PlannerRunReport>;
  listSessionEvents(sessionId: string): Promise<readonly PersistedSessionEvent[]>;
  listSessions(options?: PersistedSessionListOptions): Promise<readonly PersistedSessionListItem[]>;
}

interface BuiltHarnessSession {
  readonly session: HarnessSession;
  readonly registry: ToolRegistry;
}

interface RebuiltHarnessSessionDependencies {
  readonly operationalStore: OperationalStore;
  readonly commandExecutor?: CommandExecutor;
}

type MemoryProvider = "in-memory-operational-store" | "injected-operational-store";

interface BuildHarnessSessionDependencies {
  readonly operationalStore: OperationalStore;
  readonly memoryProvider: MemoryProvider;
  readonly commandExecutor?: CommandExecutor;
}

interface CreateDefaultHarnessToolRegistryOptions {
  readonly skillLoaderOptions: Partial<SkillLoaderOptions>;
  readonly operationalStore: OperationalStore;
  readonly runtimeHardening: RuntimeHardeningConfig;
  readonly commandExecutor?: CommandExecutor;
  readonly bashOptimizer?: BashOptimizerConfig;
}

const DEFAULT_RUNTIME_STARTED_BY = "guruharness-runtime";

export function createHarnessRuntime(dependencies: HarnessRuntimeDependencies = {}): HarnessRuntime {
  const sessions = new Map<string, BuiltHarnessSession>();
  const operationalStore = dependencies.operationalStore ?? createInMemoryOperationalStore();
  const sessionPersistenceStore = dependencies.sessionPersistenceStore ?? createOperationalSessionPersistenceStore(operationalStore);
  const memoryProvider: MemoryProvider = dependencies.operationalStore ? "injected-operational-store" : "in-memory-operational-store";

  const runtime: HarnessRuntime = {
    async startSession(options = {}) {
      const builtSession = await buildHarnessSession(options, {
        operationalStore,
        memoryProvider,
        ...(dependencies.commandExecutor ? { commandExecutor: dependencies.commandExecutor } : {})
      });
      sessions.set(builtSession.session.id, builtSession);
      await sessionPersistenceStore.recordSessionStarted(builtSession.session);

      return builtSession.session;
    },
    async resumeSession(sessionId, options = {}) {
      const loadedSession = await sessionPersistenceStore.loadSession(sessionId);

      if (!loadedSession) {
        return undefined;
      }

      const rebuiltSession = rebuildHarnessSession(loadedSession, options, {
        operationalStore,
        ...(dependencies.commandExecutor ? { commandExecutor: dependencies.commandExecutor } : {})
      });
      sessions.set(rebuiltSession.session.id, rebuiltSession);
      await sessionPersistenceStore.recordSessionResumed(rebuiltSession.session, sessionId);

      return rebuiltSession.session;
    },
    async executeTool(sessionId, toolId, input, signal) {
      const builtSession = sessions.get(sessionId);

      if (!builtSession) {
        return createMissingSessionObservation(sessionId, toolId);
      }

      // Mandate floor (ADR 2026-07-05): the same evaluator the REPL uses, now
      // enforced for EVERY caller — headless api and SDK included. A blocked
      // call NEVER reaches the registry.
      if (dependencies.mandatePolicy) {
        const cwd = builtSession.session.repo?.repoRoot ?? process.cwd();
        const decision = dependencies.mandatePolicy(toolId, input, cwd);
        if (decision && decision.outcome !== "allow") {
          const blocked = createFailedRuntimeObservation(toolId, `Blocked by mandate: ${decision.reason} (verbs: ${decision.verbs.join("+") || "none"}).`);
          await sessionPersistenceStore.recordToolObservation(sessionId, blocked);
          return blocked;
        }
      }

      const observation = await executeRegisteredTool(builtSession.registry, toolId, input, {
        runId: builtSession.session.id,
        ...(builtSession.session.repo ? { cwd: builtSession.session.repo.repoRoot } : {}),
        startedBy: DEFAULT_RUNTIME_STARTED_BY,
        metadata: {
          ...(builtSession.session.task ? { taskId: builtSession.session.task.id } : {}),
          runtimeName: builtSession.session.runtimeName
        },
        // Forward the turn abort so bash can kill its child on operator cancel.
        ...(signal ? { signal } : {})
      });
      await sessionPersistenceStore.recordToolObservation(sessionId, observation);

      return observation;
    },
    async runPlanner(sessionId, options) {
      const parsedOptions = PlannerRunOptionsSchema.parse(options);
      const builtSession = sessions.get(sessionId);

      if (!builtSession) {
        return createBlockedPlannerRunReport(sessionId, parsedOptions, `Harness session not found: ${sessionId}`, "missing-session");
      }

      if (!dependencies.plannerModel) {
        return createBlockedPlannerRunReport(sessionId, parsedOptions, "No planner model is configured for this harness runtime.", "missing-model");
      }

      const report = await runPlannerExecution({
        session: builtSession.session,
        registry: builtSession.registry,
        model: dependencies.plannerModel,
        objective: parsedOptions.objective,
        maxSteps: parsedOptions.maxSteps,
        // Same mandate floor as executeTool — planner steps are gated too.
        ...(dependencies.mandatePolicy ? { mandatePolicy: dependencies.mandatePolicy } : {})
      });
      await sessionPersistenceStore.recordPlannerRun(report);

      return report;
    },
    getSessionTools(sessionId) {
      const builtSession = sessions.get(sessionId);

      return builtSession ? builtSession.registry.list() : [];
    },
    async listSessionEvents(sessionId) {
      return sessionPersistenceStore.listEvents(sessionId);
    },
    async listSessions(options = {}) {
      return sessionPersistenceStore.listSessions(options);
    }
  };
  return runtime;
}

export async function startHarnessSession(options: StartHarnessSessionOptions = {}): Promise<HarnessSession> {
  return (
    await buildHarnessSession(options, {
      operationalStore: createInMemoryOperationalStore(),
      memoryProvider: "in-memory-operational-store"
    })
  ).session;
}

export function createDefaultHarnessToolRegistry(options: CreateDefaultHarnessToolRegistryOptions): ToolRegistry {
  return createToolRegistry([
    createRepoContextTool(),
    ...createBaseTools({
      write: {
        riskyPathPatterns: options.runtimeHardening.riskyPathPatterns,
        secretAllowList: options.runtimeHardening.secretAllowList,
        allowRiskyPaths: options.runtimeHardening.allowRiskyPaths
      },
      edit: {
        riskyPathPatterns: options.runtimeHardening.riskyPathPatterns,
        secretAllowList: options.runtimeHardening.secretAllowList,
        allowRiskyPaths: options.runtimeHardening.allowRiskyPaths
      },
      bash: {
        ...(options.commandExecutor ? { executor: options.commandExecutor } : {}),
        shellAllowlist: options.runtimeHardening.shellAllowlist,
        secretAllowList: options.runtimeHardening.secretAllowList,
        ...(options.bashOptimizer ? { optimizer: options.bashOptimizer } : {})
      },
      read: { secretAllowList: options.runtimeHardening.secretAllowList }
    }),
    createMaintenanceAuditTool(),
    createFileEditTool({
      riskyPathPatterns: options.runtimeHardening.riskyPathPatterns,
      secretAllowList: options.runtimeHardening.secretAllowList,
      allowRiskyPaths: options.runtimeHardening.allowRiskyPaths
    }),
    createShellExecTool({
      ...(options.commandExecutor ? { executor: options.commandExecutor } : {}),
      shellAllowlist: options.runtimeHardening.shellAllowlist,
      secretAllowList: options.runtimeHardening.secretAllowList
    }),
    createReviewGatesTool(options.commandExecutor),
    createGitPrAutomationTool(options.commandExecutor),
    createGitHubPrStatusTool({
      ...(options.commandExecutor ? { executor: options.commandExecutor } : {}),
      secretAllowList: options.runtimeHardening.secretAllowList
    }),
    createGitHubPrCommentTool({
      ...(options.commandExecutor ? { executor: options.commandExecutor } : {}),
      secretAllowList: options.runtimeHardening.secretAllowList
    }),
    createGitHubPrReviewTool({
      ...(options.commandExecutor ? { executor: options.commandExecutor } : {}),
      secretAllowList: options.runtimeHardening.secretAllowList
    }),
    createListSkillsTool(options.skillLoaderOptions),
    createLoadSkillTool(options.skillLoaderOptions),
    createGetOperationalProjectTool(options.operationalStore),
    createRecordOperationalBlockerTool(options.operationalStore),
    createWriteOperationalStateSnapshotTool(options.operationalStore, { secretAllowList: options.runtimeHardening.secretAllowList }),
    createListOperationalStateSnapshotsTool(options.operationalStore),
    createUpsertOperationalDecisionTool(options.operationalStore, { secretAllowList: options.runtimeHardening.secretAllowList }),
    createCreateOperationalBacklogItemTool(options.operationalStore, { secretAllowList: options.runtimeHardening.secretAllowList }),
    createListOperationalBacklogItemsTool(options.operationalStore),
    createCreateOperationalImplementationTool(options.operationalStore, { secretAllowList: options.runtimeHardening.secretAllowList }),
    ...collectExtensionTools()
  ]);
}

function rebuildHarnessSession(
  session: HarnessSession,
  options: StartHarnessSessionOptions,
  dependencies: RebuiltHarnessSessionDependencies
): BuiltHarnessSession {
  const parsedOptions = StartHarnessSessionOptionsSchema.parse(options);
  const cwd = parsedOptions.cwd ?? session.repo?.repoRoot ?? process.cwd();
  const configResult = loadHarnessConfig({
    ...(parsedOptions.configPath ? { configPath: parsedOptions.configPath } : {}),
    cwd
  });
  const configCwd = configResult.status === "loaded" ? dirname(configResult.path) : cwd;
  const registry = createDefaultHarnessToolRegistry({
    skillLoaderOptions: { directories: configResult.config.skillDirectories, cwd: configCwd },
    operationalStore: dependencies.operationalStore,
    runtimeHardening: configResult.config.runtimeHardening,
    bashOptimizer: configResult.config.bashOptimizer,
    ...(dependencies.commandExecutor ? { commandExecutor: dependencies.commandExecutor } : {})
  });

  return { session: HarnessSessionSchema.parse(session), registry };
}

async function buildHarnessSession(
  options: StartHarnessSessionOptions,
  dependencies: BuildHarnessSessionDependencies
): Promise<BuiltHarnessSession> {
  const parsedOptions = StartHarnessSessionOptionsSchema.parse(options);
  const cwd = parsedOptions.cwd ?? process.cwd();
  const configResult = loadHarnessConfig({
    ...(parsedOptions.configPath ? { configPath: parsedOptions.configPath } : {}),
    cwd
  });
  const configCwd = configResult.status === "loaded" ? dirname(configResult.path) : cwd;
  const baseState = createSelfBuildState();
  const state = applySelfBuildProgress(baseState, configResult.config.selfBuild.completedTaskIds);
  const selectedTask = selectSessionTask(state.tasks, parsedOptions.taskId);
  const task = parsedOptions.taskId ? selectedTask ?? null : planNextSelfBuildTask(state) ?? null;
  const direction = createDirectionAlignmentReport({
    here: state.here,
    there: state.there,
    ...(task ? { task } : {})
  });
  const blockers: string[] = [];
  const repo = resolveSessionRepositoryContext(parsedOptions.targetPath, cwd, blockers);
  const catalog = discoverSessionSkills(configResult.config.skillDirectories, configCwd, blockers);
  const loadedSkills = loadSessionSkills(parsedOptions.skillIds, configResult.config.skillDirectories, configCwd, blockers);
  const registry = createDefaultHarnessToolRegistry({
    skillLoaderOptions: { directories: configResult.config.skillDirectories, cwd: configCwd },
    operationalStore: dependencies.operationalStore,
    runtimeHardening: configResult.config.runtimeHardening,
    bashOptimizer: configResult.config.bashOptimizer,
    ...(dependencies.commandExecutor ? { commandExecutor: dependencies.commandExecutor } : {})
  });

  if (configResult.verdict === "RED") {
    blockers.push(...configResult.diagnostics);
  }

  if (parsedOptions.taskId && !selectedTask) {
    blockers.push(`Self-build task not found: ${parsedOptions.taskId}`);
  } else if (!task) {
    blockers.push("No self-build task is selected for this session.");
  }

  if (direction.verdict === "RED") {
    blockers.push(direction.summary);
  }

  const session = HarnessSessionSchema.parse({
    id: randomUUID(),
    runtimeName: configResult.config.runtimeName,
    status: blockers.length === 0 ? "ready" : "blocked",
    startedAt: new Date().toISOString(),
    task: task ? materializeTask(task) : null,
    here: state.here,
    there: state.there,
    direction,
    config: {
      status: configResult.status,
      verdict: configResult.verdict,
      path: configResult.path,
      diagnostics: [...configResult.diagnostics],
      runtimeName: configResult.config.runtimeName,
      referenceRuntime: configResult.config.referenceRuntime
    },
    repo: repo ? materializeRepositoryContext(repo) : null,
    skills: {
      catalog,
      loaded: loadedSkills
    },
    memory: {
      provider: dependencies.memoryProvider,
      status: "available",
      projectSlug: parsedOptions.projectSlug
    },
    policy: {
      validationCommands: configResult.config.validationCommands.map((command) => command.name),
      reviewGate: {
        provider: configResult.config.reviewGate.provider,
        required: configResult.config.reviewGate.required
      },
      approvalPolicy: configResult.config.approvalPolicy
    },
    tools: registry.list().map((tool) => ({
      id: tool.id,
      title: tool.title,
      description: tool.description
    })),
    blockers,
    nextActions: buildNextActions(blockers, task)
  });

  return { session, registry };
}

function createMissingSessionObservation(sessionId: string, toolId: string): ToolObservation {
  const now = new Date().toISOString();

  return {
    toolId,
    status: "failed",
    startedAt: now,
    endedAt: now,
    durationMs: 0,
    error: `Harness session not found: ${sessionId}`
  };
}

/** Failed observation for a mandate-blocked call (never reached the registry). */
function createFailedRuntimeObservation(toolId: string, error: string): ToolObservation {
  const now = new Date().toISOString();
  return { toolId, status: "failed", startedAt: now, endedAt: now, durationMs: 0, error };
}

function selectSessionTask(tasks: readonly SelfBuildTask[], taskId: string | undefined): SelfBuildTask | undefined {
  return taskId ? tasks.find((task) => task.id === taskId) : undefined;
}

function resolveSessionRepositoryContext(targetPath: string | undefined, cwd: string, blockers: string[]): RepositoryContext | null {
  try {
    return resolveRepositoryContext({ ...(targetPath ? { targetPath } : {}), cwd });
  } catch (error) {
    blockers.push(`Repository context unavailable: ${formatError(error)}`);

    return null;
  }
}

function discoverSessionSkills(directories: readonly string[], cwd: string, blockers: string[]): SkillCatalog {
  try {
    return discoverSkills({ directories: [...directories], cwd });
  } catch (error) {
    blockers.push(`Skill catalog unavailable: ${formatError(error)}`);

    return { skills: [], directories: [], diagnostics: [formatError(error)] };
  }
}

function loadSessionSkills(
  skillIds: readonly string[],
  directories: readonly string[],
  cwd: string,
  blockers: string[]
): readonly SkillDocument[] {
  return skillIds.flatMap((skillId) => {
    try {
      return [loadSkill({ directories: [...directories], cwd, skillId })];
    } catch (error) {
      blockers.push(`Skill ${skillId} unavailable: ${formatError(error)}`);

      return [];
    }
  });
}

function buildNextActions(blockers: readonly string[], task: SelfBuildTask | null): readonly string[] {
  if (blockers.length > 0) {
    return ["Resolve session blocker(s), then restart the harness session."];
  }

  return [
    task ? `Use the assembled runtime context to work on ${task.id}.` : "Select a task before executing harness work.",
    "Dispatch typed tools through the session registry as needed.",
    "Run validation and CodeRabbit before repository handoff."
  ];
}

function materializeTask(task: SelfBuildTask) {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    thereContribution: task.thereContribution
  };
}

function materializeRepositoryContext(repo: RepositoryContext): RepositoryContext {
  return {
    ...repo,
    agentsChain: repo.agentsChain.map((agentsFile) => ({ ...agentsFile }))
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

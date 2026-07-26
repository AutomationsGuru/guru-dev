import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { loadHarnessConfig } from "../config/loadConfig.js";
import type { MemoryConfig, RuntimeHardeningConfig } from "../config/schema.js";
import type { MandateDecision } from "../mandates/evaluate.js";
import { getGuruHomePaths } from "../home/paths.js";
import { createDirectionAlignmentReport } from "../direction/hereThere.js";
import { applySelfBuildProgress, createSelfBuildState, planNextSelfBuildTask, type SelfBuildTask } from "../kernel/selfBuildLoop.js";
import { attachConfiguredMcpServers, type McpAttachment } from "../mcp/attach.js";
import { createMcpMetaDispatchTools } from "../mcp/metaDispatch.js";
import type { McpServerConfig, McpServerStatus } from "../mcp/schemas.js";
import { createInMemoryOperationalStore, type OperationalStore } from "../operational/store.js";
import { createBlockedPlannerRunReport, runPlannerExecution, type PlannerModel } from "../planner/runtime.js";
import { createCertifiedPlanModePolicy, executePlanModeTool as runPlanModeTool, PLAN_MODE_DEFAULT_TOOL_IDS, type PlanModePolicy } from "../planner/planMode.js";
import {
  DEFAULT_APPROVAL_POSTURE,
  DEFAULT_WORK_MODE,
  PLAN_FLOOR_DENIED_CODE,
  evaluatePlanFloor,
  resolvePosture,
  type ApprovalPosture,
  type ResolvedPosture,
  type ToolEffectCategory,
  type WorkMode
} from "../planner/workApprovalAxes.js";
import {
  PLAN_ARTIFACT_INVALID_CODE,
  parsePlanArtifact,
  verdictLiftsPlanFloor,
  type PlanArtifact,
  type PlanArtifactDecision,
  type PlanArtifactVerdict
} from "../planner/planArtifact.js";
import { RuntimePlanPostureSummarySchema, type RuntimePlanPostureSummary } from "./schemas.js";
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
import { resetBackgroundTasks, scheduleBackgroundNotification } from "../tools/builtins/backgroundTaskRegistry.js";
import { createReviewGatesTool } from "../tools/builtins/reviewGatesTool.js";
import { createListSkillsTool, createLoadSkillTool } from "../tools/builtins/skillLoaderTools.js";
import { createShellExecTool } from "../tools/builtins/shellExecTool.js";
import { BashOptimizerConfigSchema, type BashOptimizerConfig } from "../tools/bashOptimizer.js";
import { createToolRegistry, executeRegisteredTool, type ToolDefinition, type ToolObservation, type ToolRegistry } from "../tools/registry.js";
import { initExtensions } from "../extensions/initExtensions.js";
import { bootstrapProjectHarness, refreshProjectHarnessManifest } from "../project-harness/bootstrap.js";
import type { CommandExecutor } from "../review/gates.js";
import {
  HarnessSessionSchema,
  StartHarnessSessionOptionsSchema,
  type HarnessSession,
  type StartHarnessSessionOptions
} from "./schemas.js";

export type { StartHarnessSessionOptions } from "./schemas.js";

export interface HarnessRuntimeDependencies {
  readonly operationalStore?: OperationalStore;
  readonly sessionPersistenceStore?: SessionPersistenceStore;
  readonly commandExecutor?: CommandExecutor;
  readonly plannerModel?: PlannerModel;
  readonly interactiveCallbacks?: {
    readonly askQuestion?: (questions: any, context: { sessionId: string }) => Promise<string[][]>;
    readonly schedule?: (message: string) => Promise<void>;
  };
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
  /**
   * Read-only plan-mode tool definitions certified for a live session (G1004
   * runtime gate). The surface is frozen at session start/resume to exactly the
   * tools that declared `effect === "read-only"`. Unknown or closed sessions
   * return an empty list, matching {@link getSessionTools}.
   */
  getSessionPlanModeTools(sessionId: string): readonly ToolDefinition[];
  /**
   * Execute a read-only plan-mode tool for a session. The signal forwards the
   * turn abort like {@link executeTool}. Refusals (non-certified tool ids)
   * return a failed observation WITHOUT invoking the underlying tool, general
   * extension execution hooks, or a planner/provider call.
   */
  executePlanModeTool(sessionId: string, toolId: string, input: unknown, signal?: AbortSignal): Promise<ToolObservation>;
  /** MCP readiness/discovery results for a live session. Unknown or closed sessions return an empty list. */
  getSessionMcpStatuses(sessionId: string): readonly McpServerStatus[];
  /** Close retained MCP clients and forget one live session. Returns false when the id is not live. */
  closeSession(sessionId: string): Promise<boolean>;
  /** Close every live session and make this runtime reject future start/resume calls. Idempotent. */
  close(): Promise<void>;
  runPlanner(sessionId: string, options: PlannerRunOptions): Promise<PlannerRunReport>;
  /** Resolved plan-posture summary (IDEA-A1) for a live session. */
  getSessionPosture(sessionId: string): RuntimePlanPostureSummary | undefined;
  /**
   * Update the plan posture for a live session. Either axis may be omitted
   * to preserve its current value. The approval posture can never widen the
   * plan floor; when workMode is set to plan and approvalPosture is set to
   * "full", the floor still binds.
   */
  setSessionPosture(sessionId: string, options: { workMode?: WorkMode; approvalPosture?: ApprovalPosture }): RuntimePlanPostureSummary | undefined;
  /**
   * Record the operator's accept/revise/reject verdict on a plan artifact.
   * "accepted" lifts the plan floor and auto-promotes workMode to "act" so
   * the harness can execute the artifact's approach; "revise" and "rejected"
   * keep the floor and leave workMode unchanged.
   */
  acceptPlanArtifact(sessionId: string, decision: { artifact: unknown; verdict: PlanArtifactVerdict; note?: string; decidedAt?: string }):
    | { readonly ok: true; readonly posture: RuntimePlanPostureSummary; readonly decision: PlanArtifactDecision }
    | { readonly ok: false; readonly code: string; readonly error: string };
  listSessionEvents(sessionId: string): Promise<readonly PersistedSessionEvent[]>;
  listSessions(options?: PersistedSessionListOptions): Promise<readonly PersistedSessionListItem[]>;
}

interface BuiltHarnessSession {
  readonly session: HarnessSession;
  readonly registry: ToolRegistry;
  readonly mcpAttachment: McpAttachment;
  readonly planModePolicy: PlanModePolicy;
  readonly posture: ResolvedPosture;
  /** Latest plan-artifact decision the operator has rendered; absent = none yet. */
  readonly planArtifactDecision?: PlanArtifactDecision;
}

interface RebuiltHarnessSessionDependencies {
  readonly operationalStore: OperationalStore;
  readonly commandExecutor?: CommandExecutor;
  readonly interactiveCallbacks?: HarnessRuntimeDependencies["interactiveCallbacks"];
}

type MemoryProvider = "in-memory-operational-store" | "injected-operational-store";

interface BuildHarnessSessionDependencies {
  readonly operationalStore: OperationalStore;
  readonly memoryProvider: MemoryProvider;
  readonly commandExecutor?: CommandExecutor;
  readonly interactiveCallbacks?: HarnessRuntimeDependencies["interactiveCallbacks"];
}

interface CreateDefaultHarnessToolRegistryOptions {
  readonly skillLoaderOptions: Partial<SkillLoaderOptions>;
  readonly operationalStore: OperationalStore;
  readonly runtimeHardening: RuntimeHardeningConfig;
  readonly memoryConfig: MemoryConfig;
  /** The active Guru home Markdown vault; injectable for portable installs/tests. */
  readonly memoryDirectory?: string;
  readonly commandExecutor?: CommandExecutor;
  readonly bashOptimizer?: BashOptimizerConfig;
  readonly interactiveCallbacks?: HarnessRuntimeDependencies["interactiveCallbacks"];
  /** Allocated session ID — threaded so the ask_question onAsk wrapper can include it in the context. */
  readonly sessionId?: string;
}

const DEFAULT_RUNTIME_STARTED_BY = "guruharness-runtime";

export function createHarnessRuntime(dependencies: HarnessRuntimeDependencies = {}): HarnessRuntime {
  const sessions = new Map<string, BuiltHarnessSession>();
  let closed = false;
  const operationalStore = dependencies.operationalStore ?? createInMemoryOperationalStore();
  const sessionPersistenceStore = dependencies.sessionPersistenceStore ?? createOperationalSessionPersistenceStore(operationalStore);
  const memoryProvider: MemoryProvider = dependencies.operationalStore ? "injected-operational-store" : "in-memory-operational-store";

  const runtime: HarnessRuntime = {
    async startSession(options = {}) {
      assertRuntimeOpen(closed);
      const builtSession = await buildHarnessSession(options, {
        operationalStore,
        memoryProvider,
        ...(dependencies.commandExecutor ? { commandExecutor: dependencies.commandExecutor } : {}),
        interactiveCallbacks: dependencies.interactiveCallbacks
      });
      if (closed) {
        await builtSession.mcpAttachment.closeAll();
        throw new Error("Harness runtime is closed.");
      }

      try {
        await sessionPersistenceStore.recordSessionStarted(builtSession.session);
        initExtensions().host.sendMessage("session:start", { sessionId: builtSession.session.id });
        sessions.set(builtSession.session.id, builtSession);
        return builtSession.session;
      } catch (error) {
        await builtSession.mcpAttachment.closeAll();
        throw error;
      }
    },
    async resumeSession(sessionId, options = {}) {
      assertRuntimeOpen(closed);
      const loadedSession = await sessionPersistenceStore.loadSession(sessionId);

      if (!loadedSession) {
        return undefined;
      }

      const rebuiltSession = await rebuildHarnessSession(loadedSession, options, {
        operationalStore,
        ...(dependencies.commandExecutor ? { commandExecutor: dependencies.commandExecutor } : {}),
        interactiveCallbacks: dependencies.interactiveCallbacks
      });
      if (closed) {
        await rebuiltSession.mcpAttachment.closeAll();
        throw new Error("Harness runtime is closed.");
      }

      try {
        await sessionPersistenceStore.recordSessionResumed(rebuiltSession.session, sessionId);
        initExtensions().host.sendMessage("session:start", { sessionId: rebuiltSession.session.id });
        const previousSession = sessions.get(rebuiltSession.session.id);
        sessions.set(rebuiltSession.session.id, rebuiltSession);
        await previousSession?.mcpAttachment.closeAll();
        return rebuiltSession.session;
      } catch (error) {
        await rebuiltSession.mcpAttachment.closeAll();
        throw error;
      }
    },
    async executeTool(sessionId, toolId, input, signal) {
      const builtSession = sessions.get(sessionId);

      if (!builtSession) {
        return createMissingSessionObservation(sessionId, toolId);
      }

      // Plan-mode floor (IDEA-A1): when workMode === "plan" the session may
      // only run the certified read-only tools. The floor is evaluated BEFORE
      // the mandate floor and BEFORE any approval posture can widen it.
      const toolEffect = classifyToolEffect(builtSession.registry, toolId);
      const planDecision = evaluatePlanFloor(builtSession.posture, toolId, toolEffect);
      if (!planDecision.allowed) {
        const blocked = createFailedRuntimeObservation(
          toolId,
          `Blocked by plan floor (${planDecision.code ?? PLAN_FLOOR_DENIED_CODE}): ${planDecision.reason ?? "tool is not allowlisted in plan mode."}`
        );
        await safeRecordToolObservation(sessionPersistenceStore, sessionId, blocked); // best-effort
        return blocked;
      }

      // Mandate floor (ADR 2026-07-05): the same evaluator the REPL uses, now
      // enforced for EVERY caller — headless api and SDK included. A blocked
      // call NEVER reaches the registry.
      if (dependencies.mandatePolicy) {
        const cwd = builtSession.session.repo?.repoRoot ?? process.cwd();
        const decision = dependencies.mandatePolicy(toolId, input, cwd);
        if (decision && decision.outcome !== "allow") {
          const blocked = createFailedRuntimeObservation(toolId, `Blocked by mandate: ${decision.reason} (verbs: ${decision.verbs.join("+") || "none"}).`);
          await safeRecordToolObservation(sessionPersistenceStore, sessionId, blocked); // best-effort (review 2026-07-08)
          return blocked;
        }
      }

      initExtensions().host.sendMessage("tool:execute", { toolId, input });

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
      await safeRecordToolObservation(sessionPersistenceStore, sessionId, observation); // best-effort (review 2026-07-08)
      try {
        initExtensions().host.sendMessage("tool:result", { toolId, output: observation });
      } catch {
        // Post-observation extensions are best-effort and cannot change or
        // repeat a tool result that already crossed the central sanitizer.
      }

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
      await safeRecordPlannerRun(sessionPersistenceStore, report); // best-effort (review 2026-07-08)

      return report;
    },
    getSessionTools(sessionId) {
      const builtSession = sessions.get(sessionId);

      return builtSession ? builtSession.registry.list() : [];
    },
    getSessionPlanModeTools(sessionId) {
      return sessions.get(sessionId)?.planModePolicy.listTools() ?? [];
    },
    async executePlanModeTool(sessionId, toolId, input, signal) {
      const builtSession = sessions.get(sessionId);

      if (!builtSession) {
        return createMissingSessionObservation(sessionId, toolId);
      }

      const policy = builtSession.planModePolicy;

      // Refusal floor: a non-certified tool id is rejected BEFORE any execution
      // or extension hook fires, so plan mode never invokes a mutating tool or
      // its general extension execution hooks.
      if (!policy.getTool(toolId)) {
        return createFailedRuntimeObservation(toolId, `Tool is not allowlisted for plan mode: ${toolId}`);
      }

      initExtensions().host.sendMessage("tool:execute", { toolId, input });

      const observation = await runPlanModeTool(policy, toolId, input, {
        runId: builtSession.session.id,
        ...(builtSession.session.repo ? { cwd: builtSession.session.repo.repoRoot } : {}),
        startedBy: DEFAULT_RUNTIME_STARTED_BY,
        metadata: {
          ...(builtSession.session.task ? { taskId: builtSession.session.task.id } : {}),
          runtimeName: builtSession.session.runtimeName
        },
        // Forward the turn abort so a long-running read can be cancelled, matching executeTool.
        ...(signal ? { signal } : {})
      });
      await safeRecordToolObservation(sessionPersistenceStore, sessionId, observation); // best-effort audit persistence
      try {
        initExtensions().host.sendMessage("tool:result", { toolId, output: observation });
      } catch {
        // Post-observation extensions are best-effort and cannot change or
        // repeat a tool result that already crossed the central sanitizer.
      }

      return observation;
    },
    getSessionMcpStatuses(sessionId) {
      return sessions.get(sessionId)?.mcpAttachment.statuses ?? [];
    },
    getSessionPosture(sessionId) {
      const builtSession = sessions.get(sessionId);
      if (!builtSession) {
        return undefined;
      }
      return summarizePosture(builtSession.posture);
    },
    setSessionPosture(sessionId, options) {
      const builtSession = sessions.get(sessionId);
      if (!builtSession) {
        return undefined;
      }
      const readOnlyIds = PLAN_MODE_DEFAULT_TOOL_IDS;
      const next = resolvePosture(options, builtSession.posture, readOnlyIds, () => new Date().toISOString());
      const stored: BuiltHarnessSession = { ...builtSession, posture: next };
      sessions.set(sessionId, stored);
      return summarizePosture(next);
    },
    acceptPlanArtifact(sessionId, decisionInput) {
      const builtSession = sessions.get(sessionId);
      if (!builtSession) {
        return { ok: false, code: "missing-session", error: `Harness session not found: ${sessionId}` };
      }
      const parseResult = parsePlanArtifact(decisionInput.artifact);
      if (!parseResult.ok) {
        return { ok: false, code: PLAN_ARTIFACT_INVALID_CODE, error: parseResult.error };
      }
      const decidedAt = decisionInput.decidedAt ?? new Date().toISOString();
      const artifact: PlanArtifact = parseResult.artifact;
      const stored: PlanArtifactDecision = {
        artifactId: artifact.id,
        verdict: decisionInput.verdict,
        ...(decisionInput.note !== undefined ? { note: decisionInput.note } : {}),
        decidedAt
      };
      let posture = builtSession.posture;
      if (verdictLiftsPlanFloor(decisionInput.verdict) && posture.workMode === "plan") {
        // Acceptance promotes the session out of plan mode WITHOUT auto-executing
        // any of the artifact's approach steps — execution still requires a
        // separate tool call which the mandate + plan floor then allow.
        posture = resolvePosture({ workMode: "act" }, posture, Array.from(posture.effectiveReadOnlyToolIds), () => decidedAt);
      }
      const next: BuiltHarnessSession = { ...builtSession, posture, planArtifactDecision: stored };
      sessions.set(sessionId, next);
      return { ok: true, posture: summarizePosture(posture), decision: stored };
    },
    async closeSession(sessionId) {
      const builtSession = sessions.get(sessionId);
      if (!builtSession) {
        return false;
      }

      sessions.delete(sessionId);
      await builtSession.mcpAttachment.closeAll();
      return true;
    },
    async close() {
      if (closed) {
        return;
      }

      closed = true;
      resetBackgroundTasks();
      const liveSessions = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(liveSessions.map((session) => session.mcpAttachment.closeAll()));
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
  const builtSession = await buildHarnessSession(options, {
    operationalStore: createInMemoryOperationalStore(),
    memoryProvider: "in-memory-operational-store"
  });

  try {
    return builtSession.session;
  } finally {
    await builtSession.mcpAttachment.closeAll();
  }
}

export function createDefaultHarnessToolRegistry(options: CreateDefaultHarnessToolRegistryOptions): ToolRegistry {
  const scheduleDelivery = options.interactiveCallbacks?.schedule;
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
      read: { secretAllowList: options.runtimeHardening.secretAllowList },
      // TUI/RPC can inject ask_question; otherwise the tool falls back to its own TTY prompt.
      // When a sessionId is allocated, wrap the callback so it receives the typed context.
      ...(options.interactiveCallbacks?.askQuestion
        ? { askQuestion: { onAsk: options.sessionId
            ? (questions: any) => options.interactiveCallbacks!.askQuestion!(questions, { sessionId: options.sessionId! })
            : (questions: any) => options.interactiveCallbacks!.askQuestion!(questions, { sessionId: "" }) } }
        : {}),
      ...(scheduleDelivery
        ? {
            schedule: {
              onSchedule: async (input) => {
                if (input.CronExpression !== undefined) {
                  throw new Error("Recurring cron schedules are not supported by the in-process scheduler.");
                }
                if (input.MaxIterations !== undefined) {
                  throw new Error("MaxIterations is not supported by the one-shot in-process scheduler.");
                }
                if (input.TimerCondition !== undefined && input.TimerCondition !== "never") {
                  throw new Error("Conditional timers are not supported; TimerCondition may only be 'never'.");
                }

                const delaySeconds = Number(input.DurationSeconds);
                return scheduleBackgroundNotification(
                  delaySeconds,
                  input.Prompt,
                  scheduleDelivery
                );
              }
            }
          }
        : {}),
      ...(options.commandExecutor ? { readDiagnostics: { executor: options.commandExecutor } } : {})
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
    ...initExtensions({
      memoryConfig: options.memoryConfig,
      ...(options.memoryDirectory ? { memoryDirectory: options.memoryDirectory } : {})
    }).tools
  ]);
}

async function rebuildHarnessSession(
  session: HarnessSession,
  options: StartHarnessSessionOptions,
  dependencies: RebuiltHarnessSessionDependencies
): Promise<BuiltHarnessSession> {
  const parsedOptions = StartHarnessSessionOptionsSchema.parse(options);
  const cwd = parsedOptions.cwd ?? session.repo?.repoRoot ?? process.cwd();
  const projectRoot = session.repo?.repoRoot ?? resolveProjectRoot(parsedOptions.targetPath, cwd);
  const projectHarness = bootstrapProjectHarness({
    projectRoot,
    ...(parsedOptions.guruHomeDirectory ? { homeDirectory: parsedOptions.guruHomeDirectory } : {})
  });
  const homePaths = getGuruHomePaths(parsedOptions.guruHomeDirectory);
  const configResult = loadHarnessConfig({
    ...(parsedOptions.configPath ? { configPath: parsedOptions.configPath } : {}),
    cwd,
    ...(parsedOptions.guruHomeDirectory ? { homeDirectory: parsedOptions.guruHomeDirectory } : {})
  });
  const configCwd = configResult.status === "loaded" ? dirname(configResult.path) : cwd;
  const catalog = discoverSessionSkills(configResult.config.skillDirectories, configCwd, []);
  const { registry, mcpAttachment, planModePolicy } = await createSessionTooling({
    skillLoaderOptions: { directories: configResult.config.skillDirectories, cwd: configCwd },
    operationalStore: dependencies.operationalStore,
    runtimeHardening: configResult.config.runtimeHardening,
    memoryConfig: configResult.config.memory,
    memoryDirectory: homePaths.memoryDirectory,
    bashOptimizer: configResult.config.bashOptimizer,
    mcpServers: configResult.config.mcpServers,
    sessionId: session.id,
    ...(dependencies.commandExecutor ? { commandExecutor: dependencies.commandExecutor } : {}),
    ...(dependencies.interactiveCallbacks ? { interactiveCallbacks: dependencies.interactiveCallbacks } : {})
  });

  // IDEA-A1: rebuild posture from persisted summary if available; otherwise
  // resolve a fresh one from current options. Either way the floor allowlist
  // is rebuilt from the live planModePolicy.
  const readOnlyIds = planModePolicy.listTools().map((definition) => definition.id);
  const rebuiltPosture = resolvePosture(
    {
      workMode: parsedOptions.workMode ?? session.posture?.workMode ?? DEFAULT_WORK_MODE,
      approvalPosture: parsedOptions.approvalPosture ?? session.posture?.approvalPosture ?? DEFAULT_APPROVAL_POSTURE
    },
    undefined,
    readOnlyIds,
    () => new Date().toISOString()
  );

  const rebuiltSession = HarnessSessionSchema.parse({
    ...session,
    config: materializeConfigSummary(configResult),
    projectHarness: refreshProjectHarnessManifest({
      report: projectHarness,
      toolIds: registry.list().map((tool) => tool.id),
      skillIds: catalog.skills.map((skill) => skill.id)
    }),
    skills: {
      ...session.skills,
      catalog
    },
    tools: materializeTools(registry),
    posture: summarizePosture(rebuiltPosture)
  });

  return { session: rebuiltSession, registry, mcpAttachment, planModePolicy, posture: rebuiltPosture };
}

async function buildHarnessSession(
  options: StartHarnessSessionOptions,
  dependencies: BuildHarnessSessionDependencies
): Promise<BuiltHarnessSession> {
  const parsedOptions = StartHarnessSessionOptionsSchema.parse(options);
  const cwd = parsedOptions.cwd ?? process.cwd();
  const blockers: string[] = [];
  // Guru is useful in a new/plain directory too. A missing Git context is
  // surfaced as absent repo metadata, not as a reason to prevent the project
  // harness from starting and creating its .guru overlay.
  const repo = resolveSessionRepositoryContext(parsedOptions.targetPath, cwd, []);
  const projectRoot = repo?.repoRoot ?? resolveProjectRoot(parsedOptions.targetPath, cwd);
  const projectHarness = bootstrapProjectHarness({
    projectRoot,
    ...(parsedOptions.guruHomeDirectory ? { homeDirectory: parsedOptions.guruHomeDirectory } : {})
  });
  const homePaths = getGuruHomePaths(parsedOptions.guruHomeDirectory);
  const configResult = loadHarnessConfig({
    ...(parsedOptions.configPath ? { configPath: parsedOptions.configPath } : {}),
    cwd,
    ...(parsedOptions.guruHomeDirectory ? { homeDirectory: parsedOptions.guruHomeDirectory } : {})
  });
  const configCwd = configResult.status === "loaded" ? dirname(configResult.path) : cwd;
  const baseState = createSelfBuildState();
  const state = applySelfBuildProgress(baseState, configResult.config.selfBuild.completedTaskIds);
  const chatSession = parsedOptions.purpose === "chat";
  const selectedTask = selectSessionTask(state.tasks, parsedOptions.taskId);
  const task = chatSession ? null : parsedOptions.taskId ? selectedTask ?? null : planNextSelfBuildTask(state) ?? null;
  const direction = createDirectionAlignmentReport({
    here: state.here,
    there: state.there,
    ...(task ? { task } : {})
  });
  // Allocate the session ID before tooling so the ask_question onAsk wrapper
  // can include it in the typed context on every callback invocation.
  const sessionId = randomUUID();
  const catalog = discoverSessionSkills(configResult.config.skillDirectories, configCwd, blockers);
  const loadedSkills = loadSessionSkills(parsedOptions.skillIds, configResult.config.skillDirectories, configCwd, blockers);
  const { registry, mcpAttachment, planModePolicy } = await createSessionTooling({
    skillLoaderOptions: { directories: configResult.config.skillDirectories, cwd: configCwd },
    operationalStore: dependencies.operationalStore,
    runtimeHardening: configResult.config.runtimeHardening,
    memoryConfig: configResult.config.memory,
    memoryDirectory: homePaths.memoryDirectory,
    bashOptimizer: configResult.config.bashOptimizer,
    mcpServers: configResult.config.mcpServers,
    sessionId,
    ...(dependencies.commandExecutor ? { commandExecutor: dependencies.commandExecutor } : {}),
    ...(dependencies.interactiveCallbacks ? { interactiveCallbacks: dependencies.interactiveCallbacks } : {})
  });

  if (configResult.verdict === "RED") {
    blockers.push(...configResult.diagnostics);
  }

  // Chat sessions are conversational: self-build task selection and direction
  // alignment are planner scaffolding and must not block them. Config-RED,
  // skill-load, and repo-context blockers above still apply.
  if (!chatSession) {
    if (parsedOptions.taskId && !selectedTask) {
      blockers.push(`Self-build task not found: ${parsedOptions.taskId}`);
    } else if (!task) {
      blockers.push("No self-build task is selected for this session.");
    }

    if (direction.verdict === "RED") {
      blockers.push(direction.summary);
    }
  }

  // IDEA-A1: initial posture is built from the operator-supplied options +
  // the certified plan-mode policy's allowlist so the floor matches the
  // surface the session actually exposes. Defaults are fail-closed (plan+ask).
  const initialPosture = resolvePosture(
    {
      workMode: parsedOptions.workMode ?? DEFAULT_WORK_MODE,
      approvalPosture: parsedOptions.approvalPosture ?? DEFAULT_APPROVAL_POSTURE
    },
    undefined,
    planModePolicy.listTools().map((definition) => definition.id),
    () => new Date().toISOString()
  );

  const session = HarnessSessionSchema.parse({
    id: sessionId,
    runtimeName: configResult.config.runtimeName,
    status: blockers.length === 0 ? "ready" : "blocked",
    startedAt: new Date().toISOString(),
    task: task ? materializeTask(task) : null,
    here: state.here,
    there: state.there,
    direction,
    config: materializeConfigSummary(configResult),
    projectHarness: refreshProjectHarnessManifest({
      report: projectHarness,
      toolIds: registry.list().map((tool) => tool.id),
      skillIds: catalog.skills.map((skill) => skill.id)
    }),
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
    tools: materializeTools(registry),
    posture: summarizePosture(initialPosture),
    blockers,
    nextActions: buildNextActions(blockers, task, projectHarness)
  });

  return { session, registry, mcpAttachment, planModePolicy, posture: initialPosture };
}

interface CreateSessionToolingOptions extends CreateDefaultHarnessToolRegistryOptions {
  readonly mcpServers: readonly McpServerConfig[];
}

async function createSessionTooling(options: CreateSessionToolingOptions): Promise<Pick<BuiltHarnessSession, "registry" | "mcpAttachment" | "planModePolicy">> {
  const registry = createDefaultHarnessToolRegistry(options);
  const mcpAttachment = await attachConfiguredMcpServers({ servers: options.mcpServers });

  try {
    for (const tool of mcpAttachment.tools) {
      registry.register(tool);
    }
    for (const tool of createMcpMetaDispatchTools(registry)) {
      registry.register(tool);
    }
    // Certify and snapshot the plan-mode policy AFTER the registry is final so
    // later mutation or registration cannot enlarge/replace the frozen surface.
    const planModePolicy = createCertifiedPlanModePolicy(registry);
    return { registry, mcpAttachment, planModePolicy };
  } catch (error) {
    await mcpAttachment.closeAll();
    throw error;
  }
}

function materializeTools(registry: ToolRegistry): readonly { id: string; title: string; description: string }[] {
  return registry.list().map((tool) => ({
    id: tool.id,
    title: tool.title,
    description: tool.description
  }));
}

function assertRuntimeOpen(closed: boolean): void {
  if (closed) {
    throw new Error("Harness runtime is closed.");
  }
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

/**
 * Best-effort tool-observation persistence (review 2026-07-08): the observation is
 * the load-bearing value of executeTool. A persistence write failure (DB down, disk
 * full, permission) used to reject executeTool's promise — turning a SUCCESSFUL tool
 * into a hard failure the agent loop reads as an error. These wrappers swallow the
 * store error (logging it) so the real result always reaches the caller.
 */
async function safeRecordToolObservation(store: SessionPersistenceStore, sessionId: string, observation: ToolObservation): Promise<void> {
  try {
    await store.recordToolObservation(sessionId, observation);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`[runtime] persistence: could not record tool observation for ${sessionId} (${error instanceof Error ? error.message : String(error)}). The tool result is preserved; only the audit trail missed this entry.`);
  }
}

async function safeRecordPlannerRun(store: SessionPersistenceStore, report: PlannerRunReport): Promise<void> {
  try {
    await store.recordPlannerRun(report);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`[runtime] persistence: could not record planner run for ${report.sessionId} (${error instanceof Error ? error.message : String(error)}). The report is preserved; only the audit trail missed this run.`);
  }
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

function buildNextActions(blockers: readonly string[], task: SelfBuildTask | null, projectHarness?: { readonly status: "ready" | "degraded"; readonly nextActions: readonly string[] }): readonly string[] {
  if (blockers.length > 0) {
    return ["Resolve session blocker(s), then restart the harness session."];
  }

  return [
    ...(projectHarness?.status === "degraded" ? projectHarness.nextActions : []),
    task ? `Use the assembled runtime context to work on ${task.id}.` : "Select a task before executing harness work.",
    "Dispatch typed tools through the session registry as needed.",
    "Run validation and peer/native review before repository handoff."
  ];
}

function materializeConfigSummary(configResult: ReturnType<typeof loadHarnessConfig>) {
  return {
    status: configResult.status,
    verdict: configResult.verdict,
    source: configResult.source,
    path: configResult.path,
    diagnostics: [...configResult.diagnostics],
    runtimeName: configResult.config.runtimeName,
    referenceRuntime: configResult.config.referenceRuntime
  };
}

/** A project overlay is useful in an ordinary folder too; a Git repo is optional. */
function resolveProjectRoot(targetPath: string | undefined, cwd: string): string {
  const candidate = resolve(targetPath ?? cwd);
  try {
    return statSync(candidate).isFile() ? dirname(candidate) : candidate;
  } catch {
    return candidate;
  }
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

/**
 * Classify a registered tool's effect for the plan-mode floor. Pure: returns
 * "read-only" when the tool explicitly declares it; defaults to "mutating"
 * when unmarked (the safe default — unmarked tools cannot be widened by an
 * approval posture).
 */
function classifyToolEffect(registry: ToolRegistry, toolId: string): ToolEffectCategory {
  const definition = registry.get(toolId);
  if (!definition) {
    // Unknown tool ids are denied at the registry layer; the plan floor
    // reports them as mutating so the deny code stays stable.
    return "mutating";
  }
  return definition.effect === "read-only" ? "read-only" : "mutating";
}

/**
 * Convert a ResolvedPosture into the wire-stable RuntimePlanPostureSummary
 * carried on the session payload. Pure.
 */
function summarizePosture(posture: ResolvedPosture): RuntimePlanPostureSummary {
  return RuntimePlanPostureSummarySchema.parse({
    workMode: posture.workMode,
    approvalPosture: posture.approvalPosture,
    planFloorActive: posture.planFloorActive,
    readOnlyAllowlist: Array.from(posture.effectiveReadOnlyToolIds).sort(),
    resolvedAt: posture.resolvedAt
  });
}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";

import { runHeadlessBootRitual, type HeadlessBootRitualInput } from "../boot/headless.js";
import type { BootReport } from "../boot/ritual.js";
import { createDirectionAlignmentReport } from "../direction/hereThere.js";
import { createSelfBuildState, applySelfBuildProgress, planNextSelfBuildTask } from "../kernel/selfBuildLoop.js";
import { loadHarnessConfig } from "../config/loadConfig.js";
import { normalizeKnownPathFields } from "../runtime/pathNormalization.js";
import type { HarnessSession } from "../runtime/schemas.js";
import { createHarnessRuntime, type HarnessRuntime } from "../runtime/session.js";
import { evaluateToolMandate } from "../mandates/evaluate.js";
import { MandateStateSchema, type MandateState } from "../mandates/schema.js";
import type { PersistedSessionEvent, PersistedSessionEventType, PersistedSessionListItem } from "../runtime/persistence.js";
import { runSelfBuildExecutor, type RunSelfBuildExecutorOptions, type SelfBuildExecutorReport } from "../executor/selfBuildExecutor.js";
import { runDevCycle, type DevCycleReport, type RunDevCycleInput } from "../selfbuild/runDevCycle.js";
import { makeSmokeDeps } from "../selfbuild/smokeDeps.js";

/**
 * G853 live SSE event streams.
 *
 * Lane A owns `./apiEventStream.js` (the bounded SSE hub): monotonic server-local
 * DECIMAL ids (strings), a fixed-size in-memory replay window (`replayLimit`),
 * session/global subscriber filtering, SSE frame encoding (`event:`/`id:`/`data:`
 * plus `ready`/`reset` control events and `:` comment heartbeats), per-subscriber
 * serialized writes with bounded-lag eviction over a transport-neutral sink, and
 * idempotent subscriber/hub cleanup.
 *
 * Lane B (this module) consumes ONLY these documented exports and adds the thin
 * HTTP transport adapter bridging `ServerResponse` to the hub `ApiEventStreamSink`:
 *   createApiEventStreamHub(options?: ApiEventStreamHubOptions): ApiEventStreamHub
 *   ApiEventStreamHub.publish(event: ApiSessionTimelineEvent): ApiEventStreamRecord
 *   ApiEventStreamHub.subscribe(options: { sink; sessionId?; lastEventId? }): ApiEventStreamSubscription
 *   ApiEventStreamHub.close(): void   // idempotent
 *
 * Per stream connection Lane B owns: committing `text/event-stream; charset=utf-8`
 * (only after the missing-session JSON 404 is ruled out), the sink write/onDrain/
 * close adapter over `ServerResponse`, and detaching the subscription on client
 * disconnect. The hub owns ready/reset/replay ordering, `Last-Event-ID` cursor
 * logic, heartbeats, and backpressure/bounded-lag eviction.
 */
import {
  createApiEventStreamHub,
  type ApiEventStreamHub,
  type ApiEventStreamHubOptions
} from "./apiEventStream.js";

export interface ApiHealthReport {
  runtime: string;
  endpoints: string[];
  /** Retained validated evidence from the one startup boot ritual. */
  boot?: BootReport;
}

export interface ApiSelfBuildPlanRequest {
  configPath?: string;
  cwd?: string;
}

export interface ApiDirectionRequest {
  configPath?: string;
  cwd?: string;
}

export interface ApiSessionStartRequest {
  configPath?: string;
  cwd?: string;
  targetPath?: string;
  taskId?: string;
  skillIds?: string[];
  projectSlug?: string;
}

export interface ApiRunGitOptions {
  enabled?: boolean;
  dryRun?: boolean;
  baseBranch?: string;
  branchName?: string;
  commitMessage?: string;
  prTitle?: string;
  prBody?: string;
  paths?: string[];
}

export interface ApiSessionStatusRequest {
  sessionId?: string;
}

export interface ApiSessionEventsRequest {
  sessionId?: string;
  cursor?: number;
  limit?: number;
}

export interface ApiSessionInspectionRequest {
  sessionId?: string;
}

export interface ApiSessionContinuationRequest {
  sessionId?: string;
}

export interface ApiSessionContinuationCommand {
  readonly label: string;
  readonly description: string;
  readonly argv: readonly string[];
  readonly shell: string;
  readonly risk: "read-only" | "run-lifecycle";
}

export interface ApiSessionContinuationReport {
  readonly route: "session-continue";
  readonly sessionId: string;
  readonly session: ApiSessionInspectionSummary;
  readonly timeline: ApiSessionTimelineSummary;
  readonly commands: readonly ApiSessionContinuationCommand[];
  readonly nextActions: readonly string[];
}

export interface ApiSessionListRequest {
  limit?: number;
}

export interface ApiSessionListReport {
  readonly route: "session-list";
  readonly sessions: readonly PersistedSessionListItem[];
  readonly count: number;
  readonly nextActions: readonly string[];
}

export interface ApiSessionInspectionSummary {
  readonly id: string;
  readonly status: string;
  readonly taskId?: string;
  readonly taskTitle?: string;
  readonly toolCount: number;
}

export interface ApiSessionTimelineEvent {
  readonly type: PersistedSessionEventType;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly summary: string;
  readonly metadata: Record<string, unknown>;
}

export interface ApiSessionTimelineSummary {
  readonly sessionId: string;
  readonly eventCount: number;
  readonly startedAt?: string;
  readonly lastEventAt?: string;
  readonly toolObservations: number;
  readonly resumeBreadcrumbs: number;
  readonly nextActions: readonly string[];
}

export interface ApiSessionInspectionReport {
  readonly route: "session-inspect";
  readonly sessionId: string;
  readonly session: ApiSessionInspectionSummary;
  readonly timeline: ApiSessionTimelineSummary;
  readonly latestEvent?: ApiSessionTimelineEvent;
  readonly nextActions: readonly string[];
}

export interface ApiRunRequest {
  configPath?: string;
  cwd?: string;
  targetPath?: string;
  taskId?: string;
  objective?: string;
  projectSlug?: string;
  maxPlannerSteps?: number;
  maxPlannerRetries?: number;
  allowDirtyWorkspace?: boolean;
  allowRiskyPaths?: boolean;
  resumeSessionId?: string;
  includeReviewGate?: boolean;
  git?: ApiRunGitOptions;
}

export interface ApiToolRunRequest {
  configPath?: string;
  cwd?: string;
  targetPath?: string;
  taskId?: string;
  skillIds?: string[];
  sessionId?: string;
  toolId?: string;
  input?: unknown;
}

export interface ApiHandlers {
  readonly buildPlan?: (request: ApiSelfBuildPlanRequest) => Promise<unknown>;
  readonly directionCheck?: (request: ApiDirectionRequest) => Promise<unknown>;
  readonly startSession?: (request: ApiSessionStartRequest) => Promise<unknown>;
  readonly sessionStatus?: (request: ApiSessionStatusRequest) => Promise<unknown>;
  readonly sessionEvents?: (request: ApiSessionEventsRequest) => Promise<unknown>;
  readonly sessionInspect?: (request: ApiSessionInspectionRequest) => Promise<unknown>;
  readonly sessionContinue?: (request: ApiSessionContinuationRequest) => Promise<unknown>;
  readonly sessionList?: (request: ApiSessionListRequest) => Promise<unknown>;
  readonly toolRun?: (request: ApiToolRunRequest) => Promise<unknown>;
  readonly run?: (request: ApiRunRequest) => Promise<unknown>;
  readonly health?: () => Promise<ApiHealthReport>;
}

type ApiRunExecutor = (options: RunSelfBuildExecutorOptions) => Promise<SelfBuildExecutorReport>;
type ApiRunCycle = (input: RunDevCycleInput) => Promise<DevCycleReport>;
type ApiRunMandatePolicy = NonNullable<RunSelfBuildExecutorOptions["mandatePolicy"]>;

export interface ApiServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly handlers?: ApiHandlers;
  readonly runtime?: HarnessRuntime;
  /** Construct a server-owned runtime. Ignored when `runtime` is supplied. */
  readonly runtimeFactory?: () => HarnessRuntime;
  /** Bounded boot inputs/test seams; the active API process cwd remains authoritative. */
  readonly boot?: Omit<HeadlessBootRitualInput, "cwd" | "sessionNumber"> & {
    readonly sessionNumber?: number;
  };
  readonly allowRunSafetyOverrides?: boolean;
  /**
   * Mandate for headless tool execution (ADR 2026-07-05-composer-completion).
   * The api is a headless surface with no interactive approver, so its DEFAULT
   * is the read-only floor: mutating tools escalate → blocked. Supply grants
   * here for trusted automation. Applies to /tool-run and the default /run
   * executor through the shared evaluator.
   */
  readonly mandate?: MandateState;
  /** Test/integration seam for the default /run handler. Ignored when handlers.run is supplied. */
  readonly runExecutor?: ApiRunExecutor;
  /** Test/integration seam for the P7 default /run cycle. Ignored when handlers.run is supplied. */
  readonly runCycle?: ApiRunCycle;
  /**
   * G853 SSE hub tuning. Omit for the hub's conservative production defaults.
   * Tests inject a small `replayLimit` (bounded replay/reset behavior) and a short
   * `heartbeatIntervalMs` (comment heartbeats) through the hub seam.
   */
  readonly eventStream?: ApiEventStreamHubOptions;
}

/** The secure headless default: no grants, no YOLO → mutations are denied. */
export const HEADLESS_READ_ONLY_MANDATE: MandateState = MandateStateSchema.parse({ grants: [], denies: [] });

/** Build a runtime mandate policy for a headless surface from a mandate state. */
export function headlessMandatePolicy(mandate: MandateState = HEADLESS_READ_ONLY_MANDATE): (toolId: string, input: unknown, cwd: string) => ReturnType<typeof evaluateToolMandate> {
  return (toolId, input, cwd) => evaluateToolMandate(toolId, input, { cwd, state: mandate, yolo: false });
}

class ApiHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

export interface ApiServerHandle {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly server: Server;
  readonly close: () => Promise<void>;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4100;

export async function startHarnessApiServer(options: ApiServerOptions = {}): Promise<ApiServerHandle> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const { sessionNumber = 0, ...bootOptions } = options.boot ?? {};
  const bootReport = runHeadlessBootRitual({
    ...bootOptions,
    cwd: process.cwd(),
    sessionNumber
  });
  const mandatePolicy = headlessMandatePolicy(options.mandate);
  // Headless surface: attach the mandate floor so /tool-run cannot run a
  // mutating tool without a grant (the REPL-only enforcement hole, closed).
  const ownsRuntime = options.runtime === undefined;
  const runtime = options.runtime ?? options.runtimeFactory?.() ?? createHarnessRuntime({ mandatePolicy });
  // G853: one bounded SSE hub per server. Always created so the stream endpoints
  // exist; only the default session lifecycle publishes into it.
  const eventStream = createApiEventStreamHub(options.eventStream);
  const defaultContext = createDefaultApiHandlers(
    runtime,
    mandatePolicy,
    options.runExecutor ?? runSelfBuildExecutor,
    options.runCycle ?? runDevCycle,
    eventStream
  );
  const selectedHealth = options.handlers?.health ?? defaultContext.handlers.health;
  const handlers: Required<ApiHandlers> = {
    buildPlan: options.handlers?.buildPlan ?? defaultContext.handlers.buildPlan,
    directionCheck: options.handlers?.directionCheck ?? defaultContext.handlers.directionCheck,
    startSession: options.handlers?.startSession ?? defaultContext.handlers.startSession,
    sessionStatus: options.handlers?.sessionStatus ?? defaultContext.handlers.sessionStatus,
    sessionEvents: options.handlers?.sessionEvents ?? defaultContext.handlers.sessionEvents,
    sessionInspect: options.handlers?.sessionInspect ?? defaultContext.handlers.sessionInspect,
    sessionContinue: options.handlers?.sessionContinue ?? defaultContext.handlers.sessionContinue,
    sessionList: options.handlers?.sessionList ?? defaultContext.handlers.sessionList,
    toolRun: options.handlers?.toolRun ?? defaultContext.handlers.toolRun,
    run: options.handlers?.run ?? defaultContext.handlers.run,
    health: async () => ({
      ...await selectedHealth(),
      boot: bootReport
    })
  };
  const routeOptions = {
    allowRunSafetyOverrides: options.allowRunSafetyOverrides ?? false,
    eventStream,
    hasSession: defaultContext.hasSession
  };

  const server = createServer(async (request, response) => {
    await routeRequest(request, response, handlers, routeOptions);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        reject(error);
      };

      server.once("error", onError);
      server.listen(port, host, () => {
        server.off("error", onError);
        resolve();
      });
    });
  } catch (error) {
    if (ownsRuntime) {
      await runtime.close();
    }
    throw error;
  }

  const address = server.address();
  const actualPort = isAddressInfo(address) ? address.port : port;

  return {
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    server,
    async close() {
      try {
        // G853: stop heartbeats and end SSE subscribers first so open event-stream
        // clients never keep server.close() (and this handle) pending.
        eventStream.close();
        await new Promise<void>((resolve, reject) => {
        // Drop keep-alive clients so close() does not hang the next test.
          server.closeAllConnections?.();
          server.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        });
      } finally {
        if (ownsRuntime) {
          await runtime.close();
        }
      }
    }
  };
}

function buildPlanResponse(configPath?: string, cwd?: string): unknown {
  const configResult = loadHarnessConfig({ ...(configPath ? { configPath } : {}), ...(cwd ? { cwd } : {}) });
  const baseState = createSelfBuildState();
  const state = applySelfBuildProgress(baseState, configResult.config.selfBuild.completedTaskIds);
  const nextTask = planNextSelfBuildTask(state);

  return {
    objective: state.objective,
    here: state.here,
    there: state.there,
    referenceRuntime: configResult.config.referenceRuntime,
    config: {
      status: configResult.status,
      verdict: configResult.verdict,
      path: configResult.path,
      diagnostics: configResult.diagnostics
    },
    nextTask,
    direction: createDirectionAlignmentReport({ here: state.here, there: state.there, ...(nextTask ? { task: nextTask } : {}) }),
    taskCount: state.tasks.length,
    completedTaskIds: configResult.config.selfBuild.completedTaskIds,
    constraints: state.constraints,
    validationCommands: configResult.config.validationCommands.map((validationCommand) => validationCommand.name)
  };
}

function directionResponse(configPath?: string, cwd?: string): unknown {
  const configResult = loadHarnessConfig({ ...(configPath ? { configPath } : {}), ...(cwd ? { cwd } : {}) });
  const baseState = createSelfBuildState();
  const state = applySelfBuildProgress(baseState, configResult.config.selfBuild.completedTaskIds);
  const nextTask = planNextSelfBuildTask(state);

  return createDirectionAlignmentReport({ here: state.here, there: state.there, ...(nextTask ? { task: nextTask } : {}) });
}

interface DefaultApiContext {
  readonly handlers: Required<ApiHandlers>;
  /**
   * Parity with the JSON `/sessions/:sessionId/events` 404: true when the default
   * session lifecycle has recorded at least one timeline event for the session.
   * Used to return the existing sanitized JSON 404 before SSE headers commit.
   */
  readonly hasSession: (sessionId: string) => boolean;
}

function createDefaultApiHandlers(
  runtime: HarnessRuntime,
  mandatePolicy: ApiRunMandatePolicy,
  runExecutor: ApiRunExecutor,
  runCycle: ApiRunCycle,
  eventStream: ApiEventStreamHub
): DefaultApiContext {
  const sessions = new Map<string, HarnessSession>();
  const sessionEvents = new Map<string, ApiSessionTimelineEvent[]>();

  return {
    handlers: {
      buildPlan: async (request) => buildPlanResponse(request.configPath, request.cwd),
      directionCheck: async (request) => directionResponse(request.configPath, request.cwd),
      startSession: async (request) => {
        const session = await runtime.startSession(request);
        sessions.set(session.id, session);
        appendSessionEvent(sessionEvents, createSessionStartedEvent(session), eventStream);

        return session;
      },
      sessionStatus: async (request) => defaultSessionStatus(runtime, sessions, sessionEvents, eventStream, request),
      sessionEvents: async (request) => defaultSessionEvents(sessionEvents, request),
      sessionInspect: async (request) => defaultSessionInspection(runtime, sessions, sessionEvents, eventStream, request),
      sessionContinue: async (request) => defaultSessionContinuation(runtime, sessions, sessionEvents, eventStream, request),
      sessionList: async (request) => defaultSessionList(runtime, request),
      toolRun: async (request) => defaultToolRun(runtime, sessions, sessionEvents, eventStream, request),
      run: async (request) => defaultRun(request, mandatePolicy, runExecutor, runCycle),
      health: defaultHealth
    },
    hasSession: (sessionId) => sessionEvents.has(sessionId)
  };
}

async function defaultSessionStatus(
  runtime: HarnessRuntime,
  sessions: Map<string, HarnessSession>,
  sessionEvents: Map<string, ApiSessionTimelineEvent[]>,
  eventStream: ApiEventStreamHub,
  request: ApiSessionStatusRequest
): Promise<unknown> {
  if (!request.sessionId) {
    throw new ApiHttpError(400, "sessionId is required for session status.");
  }

  const localSession = sessions.get(request.sessionId);
  const session = localSession ?? (await runtime.resumeSession(request.sessionId));

  if (!session) {
    throw new ApiHttpError(404, `Harness session not found: ${request.sessionId}`);
  }

  sessions.set(session.id, session);
  if (!localSession) {
    appendSessionEvent(sessionEvents, createSessionResumedEvent(session, request.sessionId), eventStream);
  }

  return { route: "session-status", session };
}

async function defaultSessionList(runtime: HarnessRuntime, request: ApiSessionListRequest): Promise<ApiSessionListReport> {
  const sessions = await runtime.listSessions({ ...(request.limit !== undefined ? { limit: request.limit } : {}) });

  return {
    route: "session-list",
    sessions,
    count: sessions.length,
    nextActions: sessions.length > 0 ? ["Inspect a session by id before resuming it."] : ["Start a session before using session inspection or resume workflows."]
  };
}

async function defaultSessionEvents(sessionEvents: Map<string, ApiSessionTimelineEvent[]>, request: ApiSessionEventsRequest): Promise<unknown> {
  if (!request.sessionId) {
    throw new ApiHttpError(400, "sessionId is required for session events.");
  }

  const events = sessionEvents.get(request.sessionId);

  if (!events) {
    throw new ApiHttpError(404, `Harness session not found: ${request.sessionId}`);
  }

  const totalEventCount = events.length;
  const cursor = Math.min(request.cursor ?? 0, totalEventCount);
  const nextCursor = request.limit === undefined ? totalEventCount : Math.min(cursor + request.limit, totalEventCount);

  return {
    route: "session-events",
    sessionId: request.sessionId,
    summary: buildApiSessionTimelineSummary(request.sessionId, events),
    events: events.slice(cursor, nextCursor),
    cursor,
    nextCursor,
    hasMore: nextCursor < totalEventCount,
    totalEventCount
  };
}

async function defaultSessionInspection(
  runtime: HarnessRuntime,
  sessions: Map<string, HarnessSession>,
  sessionEvents: Map<string, ApiSessionTimelineEvent[]>,
  eventStream: ApiEventStreamHub,
  request: ApiSessionInspectionRequest
): Promise<ApiSessionInspectionReport> {
  if (!request.sessionId) {
    throw new ApiHttpError(400, "sessionId is required for session inspection.");
  }

  const localSession = sessions.get(request.sessionId);
  const session = localSession ?? (await runtime.resumeSession(request.sessionId));

  if (!session) {
    throw new ApiHttpError(404, `Harness session not found: ${request.sessionId}`);
  }

  sessions.set(session.id, session);
  if (!localSession) {
    appendSessionEvent(sessionEvents, createSessionResumedEvent(session, request.sessionId), eventStream);
  }

  const persistedEvents = await runtime.listSessionEvents(session.id);
  const events = persistedEvents.map(createTimelineEventFromPersistedEvent);
  const timeline = buildApiSessionTimelineSummary(session.id, events);
  const latestEvent = events.at(-1);

  return {
    route: "session-inspect",
    sessionId: session.id,
    session: summarizeSessionForInspection(session),
    timeline,
    ...(latestEvent ? { latestEvent } : {}),
    nextActions: timeline.nextActions
  };
}

async function defaultSessionContinuation(
  runtime: HarnessRuntime,
  sessions: Map<string, HarnessSession>,
  sessionEvents: Map<string, ApiSessionTimelineEvent[]>,
  eventStream: ApiEventStreamHub,
  request: ApiSessionContinuationRequest
): Promise<ApiSessionContinuationReport> {
  if (!request.sessionId) {
    throw new ApiHttpError(400, "sessionId is required for session continuation.");
  }

  const localSession = sessions.get(request.sessionId);
  const session = localSession ?? (await runtime.resumeSession(request.sessionId));

  if (!session) {
    throw new ApiHttpError(404, `Harness session not found: ${request.sessionId}`);
  }

  sessions.set(session.id, session);
  if (!localSession) {
    appendSessionEvent(sessionEvents, createSessionResumedEvent(session, request.sessionId), eventStream);
  }

  const persistedEvents = await runtime.listSessionEvents(session.id);
  const timeline = buildApiSessionTimelineSummary(session.id, persistedEvents.map(createTimelineEventFromPersistedEvent));

  return {
    route: "session-continue",
    sessionId: session.id,
    session: summarizeSessionForInspection(session),
    timeline,
    commands: buildSessionContinuationCommands(session.id),
    nextActions: ["Review the suggested command before running it.", "Prefer inspection before resuming long-running work."]
  };
}

async function defaultToolRun(
  runtime: HarnessRuntime,
  sessions: Map<string, HarnessSession>,
  sessionEvents: Map<string, ApiSessionTimelineEvent[]>,
  eventStream: ApiEventStreamHub,
  request: ApiToolRunRequest
): Promise<unknown> {
  if (!request.toolId) {
    throw new Error("toolId is required for /tool-run.");
  }

  const sessionOptions = {
    ...(typeof request.configPath === "string" ? { configPath: request.configPath } : {}),
    ...(typeof request.cwd === "string" ? { cwd: request.cwd } : {}),
    ...(typeof request.targetPath === "string" ? { targetPath: request.targetPath } : {}),
    ...(typeof request.taskId === "string" ? { taskId: request.taskId } : {}),
    ...(request.skillIds ? { skillIds: [...request.skillIds] } : {})
  };
  const localSession = request.sessionId ? sessions.get(request.sessionId) : undefined;
  const session = request.sessionId
    ? localSession ?? (await runtime.resumeSession(request.sessionId, sessionOptions))
    : await runtime.startSession(sessionOptions);

  if (!session) {
    throw new ApiHttpError(404, `Harness session not found: ${request.sessionId}`);
  }

  sessions.set(session.id, session);
  if (request.sessionId && !localSession) {
    appendSessionEvent(sessionEvents, createSessionResumedEvent(session, request.sessionId), eventStream);
  } else if (!request.sessionId) {
    appendSessionEvent(sessionEvents, createSessionStartedEvent(session), eventStream);
  }

  const observation = await runtime.executeTool(session.id, request.toolId, request.input ?? {});
  appendSessionEvent(sessionEvents, createToolObservationEvent(session.id, request.toolId, observation.status, observation.error), eventStream);

  return { session, observation };
}

async function defaultRun(
  request: ApiRunRequest,
  mandatePolicy: ApiRunMandatePolicy,
  runExecutor: ApiRunExecutor,
  runCycle: ApiRunCycle
): Promise<DevCycleReport> {
  const executorOptions: RunSelfBuildExecutorOptions = {
    ...(typeof request.configPath === "string" ? { configPath: request.configPath } : {}),
    ...(typeof request.cwd === "string" ? { cwd: request.cwd } : {}),
    ...(typeof request.targetPath === "string" ? { targetPath: request.targetPath } : {}),
    ...(typeof request.taskId === "string" ? { taskId: request.taskId } : {}),
    ...(typeof request.objective === "string" ? { objective: request.objective } : {}),
    ...(typeof request.projectSlug === "string" ? { projectSlug: request.projectSlug } : {}),
    ...(typeof request.maxPlannerSteps === "number" ? { maxPlannerSteps: request.maxPlannerSteps } : {}),
    ...(typeof request.maxPlannerRetries === "number" ? { maxPlannerRetries: request.maxPlannerRetries } : {}),
    ...(typeof request.allowDirtyWorkspace === "boolean" ? { allowDirtyWorkspace: request.allowDirtyWorkspace } : {}),
    ...(typeof request.allowRiskyPaths === "boolean" ? { allowRiskyPaths: request.allowRiskyPaths } : {}),
    ...(typeof request.resumeSessionId === "string" && request.resumeSessionId.length > 0 ? { resumeSessionId: request.resumeSessionId } : {}),
    ...(request.includeReviewGate !== undefined ? { includeReviewGate: request.includeReviewGate } : {}),
    ...(request.git
      ? {
          git: {
            enabled: request.git.enabled ?? true,
            ...(request.git.dryRun !== undefined ? { dryRun: request.git.dryRun } : {}),
            ...(request.git.baseBranch ? { baseBranch: request.git.baseBranch } : {}),
            ...(request.git.branchName ? { branchName: request.git.branchName } : {}),
            ...(request.git.commitMessage ? { commitMessage: request.git.commitMessage } : {}),
            ...(request.git.prTitle ? { prTitle: request.git.prTitle } : {}),
            ...(request.git.prBody ? { prBody: request.git.prBody } : {}),
            ...(request.git.paths ? { paths: [...request.git.paths] } : {})
          }
        }
      : {})
  };
  const effectiveCwd = executorOptions.cwd ?? process.cwd();

  return runCycle({
    executorOptions,
    mandatePolicy,
    executor: runExecutor,
    smoke: makeSmokeDeps({ cwd: effectiveCwd, timeoutMs: 30_000 })
  });
}

const RUNTIME_NAME = "GuruHarness";

async function defaultHealth(): Promise<ApiHealthReport> {
  return {
    runtime: RUNTIME_NAME,
    endpoints: ["GET /", "GET /health", "GET /self-build-plan", "GET /direction-check", "POST /session-start", "GET /sessions", "GET /events", "GET /sessions/:sessionId", "GET /sessions/:sessionId/events", "GET /sessions/:sessionId/events/stream", "GET /sessions/:sessionId/inspect", "GET /sessions/:sessionId/continue", "POST /tool-run", "POST /run"]
  };
}

interface RouteRequestOptions {
  readonly allowRunSafetyOverrides: boolean;
  readonly eventStream: ApiEventStreamHub;
  readonly hasSession: (sessionId: string) => boolean;
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  handlers: Required<ApiHandlers>,
  options: RouteRequestOptions
): Promise<void> {
  const method = request.method?.toUpperCase() ?? "";
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  const route = requestUrl.pathname;

  try {
    if (method === "GET" && (route === "/" || route === "/health")) {
      return writeJson(response, 200, await handlers.health());
    }

    if (method === "GET" && route === "/self-build-plan") {
      return writeJson(response, 200, await handlers.buildPlan(normalizePlanContext(requestUrl.searchParams)));
    }

    if (method === "GET" && route === "/direction-check") {
      return writeJson(response, 200, await handlers.directionCheck(normalizePlanContext(requestUrl.searchParams)));
    }

    if (method === "POST" && route === "/session-start") {
      const body = await parseJsonBody(request);
      return writeJson(response, 200, await handlers.startSession(normalizeSessionRequest(body)));
    }

    if (method === "GET" && route === "/sessions") {
      return writeJson(response, 200, await handlers.sessionList(normalizeSessionListRequest(requestUrl.searchParams)));
    }

    if (method === "GET" && route === "/events") {
      // Global SSE stream: every default-API session event in publication order.
      const lastEventId = readLastEventId(request);
      attachEventStream(request, response, options.eventStream, { ...(lastEventId !== undefined ? { lastEventId } : {}) });
      return;
    }

    if (method === "GET" && route.startsWith("/sessions/") && route.endsWith("/events")) {
      return writeJson(response, 200, await handlers.sessionEvents(normalizeSessionEventsRequest(route, requestUrl.searchParams)));
    }

    if (method === "GET" && route.startsWith("/sessions/") && route.endsWith("/events/stream")) {
      // Session SSE stream. Missing session → existing sanitized JSON 404 before
      // any SSE header is committed (handled by the shared catch below).
      const sessionId = normalizeSessionEventStreamRequest(route);
      if (!options.hasSession(sessionId)) {
        throw new ApiHttpError(404, `Harness session not found: ${sessionId}`);
      }
      const lastEventId = readLastEventId(request);
      attachEventStream(request, response, options.eventStream, { sessionId, ...(lastEventId !== undefined ? { lastEventId } : {}) });
      return;
    }

    if (method === "GET" && route.startsWith("/sessions/") && route.endsWith("/inspect")) {
      return writeJson(response, 200, await handlers.sessionInspect(normalizeSessionInspectionRequest(route)));
    }

    if (method === "GET" && route.startsWith("/sessions/") && route.endsWith("/continue")) {
      return writeJson(response, 200, await handlers.sessionContinue(normalizeSessionContinuationRequest(route)));
    }

    if (method === "GET" && route.startsWith("/sessions/")) {
      return writeJson(response, 200, await handlers.sessionStatus(normalizeSessionStatusRequest(route)));
    }

    if (method === "POST" && route === "/tool-run") {
      const body = await parseJsonBody(request);
      return writeJson(response, 200, await handlers.toolRun(normalizeToolRunRequest(body)));
    }

    if (method === "POST" && route === "/run") {
      const body = await parseJsonBody(request);
      return writeJson(response, 200, await handlers.run(normalizeRunRequest(body, options)));
    }

    return writeJson(response, 404, { error: "Not found", route, method });
  } catch (error) {
    // Public client surface: never echo stacks (CodeQL js/stack-trace-exposure).
    const statusCode = error instanceof ApiHttpError ? error.statusCode : 400;
    const message = publicApiErrorMessage(error);
    return writeJson(response, statusCode, { error: message, route, method });
  }
}

function normalizePlanContext(params: URLSearchParams): ApiSelfBuildPlanRequest {
  const configPath = params.get("config");
  const cwd = params.get("cwd");
  const request: ApiSelfBuildPlanRequest = {};

  if (configPath !== null) {
    request.configPath = configPath;
  }

  if (cwd !== null) {
    request.cwd = cwd;
  }

  return normalizeKnownPathFields(request);
}

async function parseJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();

  if (raw.length === 0) {
    return {};
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Invalid JSON request body.");
  }
}

function normalizeSessionStatusRequest(route: string): ApiSessionStatusRequest {
  const sessionId = route.slice("/sessions/".length);

  return sessionId.length > 0 ? { sessionId: decodeURIComponent(sessionId) } : {};
}

function normalizeSessionListRequest(params: URLSearchParams): ApiSessionListRequest {
  const limit = params.get("limit");

  if (limit === null) {
    return {};
  }

  const parsedLimit = Number.parseInt(limit, 10);

  return Number.isInteger(parsedLimit) && parsedLimit > 0 ? { limit: parsedLimit } : {};
}

function normalizeSessionEventsRequest(route: string, params: URLSearchParams): ApiSessionEventsRequest {
  const sessionId = route.slice("/sessions/".length, -"/events".length);
  const request: ApiSessionEventsRequest = sessionId.length > 0 ? { sessionId: decodeURIComponent(sessionId) } : {};
  const cursor = normalizeIntegerQueryValue(params.get("cursor"), 0);
  const limit = normalizeIntegerQueryValue(params.get("limit"), 1);

  if (cursor !== undefined) {
    request.cursor = cursor;
  }

  if (limit !== undefined) {
    request.limit = limit;
  }

  return request;
}

function normalizeIntegerQueryValue(value: string | null, minimum: number): number | undefined {
  if (value === null || !/^\d+$/.test(value)) {
    return undefined;
  }

  const parsedValue = Number(value);

  return Number.isSafeInteger(parsedValue) && parsedValue >= minimum ? parsedValue : undefined;
}

function normalizeSessionEventStreamRequest(route: string): string {
  const sessionId = route.slice("/sessions/".length, -"/events/stream".length);

  return sessionId.length > 0 ? decodeURIComponent(sessionId) : "";
}

function readLastEventId(request: IncomingMessage): string | undefined {
  const raw = request.headers["last-event-id"];
  // Pass the single header value through; the hub validates its decimal form and
  // treats anything absent/non-decimal as an absent cursor (full retained replay).
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/**
 * Bridge a Node `ServerResponse` to the hub's transport-neutral sink. The hub owns
 * frame encoding, ordering, heartbeats, and bounded-lag eviction; this adapter only
 * forwards writes / backpressure-drain / close to the HTTP response.
 */
function createServerResponseSink(response: ServerResponse): {
  write: (frame: string) => boolean;
  onDrain: (listener: () => void) => () => void;
  close: () => void;
} {
  return {
    write: (frame) => response.write(frame),
    onDrain: (listener) => {
      response.on("drain", listener);
      return () => {
        response.off("drain", listener);
      };
    },
    close: () => {
      response.end();
    }
  };
}

/**
 * Commit the SSE headers and hand the response to the hub as a sink. Called only
 * after the missing-session JSON 404 is ruled out, so a stream never commits
 * `text/event-stream` for an unknown session. The subscription is detached on
 * request abort, response close, or response error so heartbeats and listeners
 * are released exactly once.
 */
function attachEventStream(
  request: IncomingMessage,
  response: ServerResponse,
  hub: ApiEventStreamHub,
  options: { readonly sessionId?: string; readonly lastEventId?: string }
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache"
  });
  let subscription: { unsubscribe(): void; closed: boolean; close(): void } | undefined;
  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    request.off("aborted", cleanup);
    response.off("close", cleanup);
    response.off("error", cleanup);
    subscription?.unsubscribe();
  };

  request.on("aborted", cleanup);
  response.on("close", cleanup);
  response.on("error", cleanup);
  subscription = hub.subscribe({
    sink: createServerResponseSink(response),
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    ...(options.lastEventId !== undefined ? { lastEventId: options.lastEventId } : {})
  });
  if (cleanedUp) {
    subscription.unsubscribe();
  } else if (subscription.closed) {
    cleanup();
  }
}

function normalizeSessionInspectionRequest(route: string): ApiSessionInspectionRequest {
  const sessionId = route.slice("/sessions/".length, -"/inspect".length);

  return sessionId.length > 0 ? { sessionId: decodeURIComponent(sessionId) } : {};
}

function normalizeSessionContinuationRequest(route: string): ApiSessionContinuationRequest {
  const sessionId = route.slice("/sessions/".length, -"/continue".length);

  return sessionId.length > 0 ? { sessionId: decodeURIComponent(sessionId) } : {};
}

function normalizeSessionRequest(value: unknown): ApiSessionStartRequest {
  if (!isPlainObject(value)) {
    return {};
  }

  const request: ApiSessionStartRequest = {};

  if (typeof value.configPath === "string" && value.configPath.length > 0) {
    request.configPath = value.configPath;
  }

  if (typeof value.cwd === "string" && value.cwd.length > 0) {
    request.cwd = value.cwd;
  }

  if (typeof value.targetPath === "string" && value.targetPath.length > 0) {
    request.targetPath = value.targetPath;
  }

  if (typeof value.taskId === "string" && value.taskId.length > 0) {
    request.taskId = value.taskId;
  }

  if (Array.isArray(value.skillIds)) {
    request.skillIds = value.skillIds.filter((skillId): skillId is string => typeof skillId === "string" && skillId.length > 0);
  }

  if (typeof value.projectSlug === "string" && value.projectSlug.length > 0) {
    request.projectSlug = value.projectSlug;
  }

  return normalizeKnownPathFields(request);
}

function normalizeToolRunRequest(value: unknown): ApiToolRunRequest {
  if (!isPlainObject(value)) {
    return {};
  }

  const request: ApiToolRunRequest = {};

  if (typeof value.configPath === "string" && value.configPath.length > 0) {
    request.configPath = value.configPath;
  }

  if (typeof value.cwd === "string" && value.cwd.length > 0) {
    request.cwd = value.cwd;
  }

  if (typeof value.targetPath === "string" && value.targetPath.length > 0) {
    request.targetPath = value.targetPath;
  }

  if (typeof value.taskId === "string" && value.taskId.length > 0) {
    request.taskId = value.taskId;
  }

  if (Array.isArray(value.skillIds)) {
    request.skillIds = value.skillIds.filter((skillId): skillId is string => typeof skillId === "string" && skillId.length > 0);
  }

  if (typeof value.sessionId === "string" && value.sessionId.length > 0) {
    request.sessionId = value.sessionId;
  }

  if (typeof value.toolId === "string" && value.toolId.length > 0) {
    request.toolId = value.toolId;
  }

  if ("input" in value) {
    request.input = normalizeKnownPathFields(value.input);
  }

  return normalizeKnownPathFields(request);
}

function normalizeRunRequest(value: unknown, options: { readonly allowRunSafetyOverrides: boolean }): ApiRunRequest {
  if (!isPlainObject(value)) {
    return {};
  }

  const request: ApiRunRequest = {};

  if (typeof value.configPath === "string" && value.configPath.length > 0) {
    request.configPath = value.configPath;
  }

  if (typeof value.cwd === "string" && value.cwd.length > 0) {
    request.cwd = value.cwd;
  }

  if (typeof value.targetPath === "string" && value.targetPath.length > 0) {
    request.targetPath = value.targetPath;
  }

  if (typeof value.taskId === "string" && value.taskId.length > 0) {
    request.taskId = value.taskId;
  }

  if (typeof value.objective === "string" && value.objective.length > 0) {
    request.objective = value.objective;
  }

  if (typeof value.projectSlug === "string" && value.projectSlug.length > 0) {
    request.projectSlug = value.projectSlug;
  }

  if (typeof value.maxPlannerSteps === "number" && Number.isInteger(value.maxPlannerSteps) && value.maxPlannerSteps > 0) {
    request.maxPlannerSteps = value.maxPlannerSteps;
  }

  if (typeof value.maxPlannerRetries === "number" && Number.isInteger(value.maxPlannerRetries) && value.maxPlannerRetries > 0) {
    request.maxPlannerRetries = value.maxPlannerRetries;
  }

  if (options.allowRunSafetyOverrides && typeof value.allowDirtyWorkspace === "boolean") {
    request.allowDirtyWorkspace = value.allowDirtyWorkspace;
  }

  if (options.allowRunSafetyOverrides && typeof value.allowRiskyPaths === "boolean") {
    request.allowRiskyPaths = value.allowRiskyPaths;
  }

  if (typeof value.resumeSessionId === "string" && value.resumeSessionId.length > 0) {
    request.resumeSessionId = value.resumeSessionId;
  }

  if (typeof value.includeReviewGate === "boolean") {
    request.includeReviewGate = value.includeReviewGate;
  }

  const git = value.git;
  if (isPlainObject(git)) {
    request.git = {
      enabled: true,
      ...(typeof git.branchName === "string" && git.branchName.length > 0 ? { branchName: git.branchName } : {}),
      ...(typeof git.commitMessage === "string" && git.commitMessage.length > 0 ? { commitMessage: git.commitMessage } : {}),
      ...(typeof git.prTitle === "string" && git.prTitle.length > 0 ? { prTitle: git.prTitle } : {}),
      ...(typeof git.prBody === "string" && git.prBody.length > 0 ? { prBody: git.prBody } : {}),
      ...(git.dryRun === true || git.dryRun === false ? { dryRun: git.dryRun } : {}),
      ...(git.baseBranch && typeof git.baseBranch === "string" && git.baseBranch.length > 0 ? { baseBranch: git.baseBranch } : {}),
      ...(Array.isArray(git.paths) ? { paths: git.paths.filter((path: unknown): path is string => typeof path === "string") } : {})
    };
  }

  return normalizeKnownPathFields(request);
}

function buildSessionContinuationCommands(sessionId: string): readonly ApiSessionContinuationCommand[] {
  return [
    buildContinuationCommand(
      "inspect",
      "Inspect the session timeline before resuming work.",
      ["guruharness", "session-inspect", "--api-url", "<api-url>", "--session-id", sessionId],
      "read-only"
    ),
    buildContinuationCommand(
      "resume-run",
      "Resume the selected session through the guarded run lifecycle.",
      ["guruharness", "run", "--resume-session", sessionId],
      "run-lifecycle"
    )
  ];
}

function buildContinuationCommand(
  label: string,
  description: string,
  argv: readonly string[],
  risk: ApiSessionContinuationCommand["risk"]
): ApiSessionContinuationCommand {
  return {
    label,
    description,
    argv,
    shell: argv.map(quoteShellArg).join(" "),
    risk
  };
}

function quoteShellArg(value: string): string {
  return /^[A-Za-z0-9_./:<>-]+$/.test(value) ? value : `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function summarizeSessionForInspection(session: HarnessSession): ApiSessionInspectionSummary {
  return {
    id: session.id,
    status: session.status,
    ...(session.task?.id ? { taskId: session.task.id } : {}),
    ...(session.task?.title ? { taskTitle: session.task.title } : {}),
    toolCount: session.tools.length
  };
}

function createTimelineEventFromPersistedEvent(event: PersistedSessionEvent): ApiSessionTimelineEvent {
  return {
    type: event.type,
    sessionId: event.sessionId,
    createdAt: event.createdAt,
    summary: summarizePersistedEvent(event),
    metadata: metadataForPersistedEvent(event)
  };
}

function summarizePersistedEvent(event: PersistedSessionEvent): string {
  const payload = isPlainObject(event.payload) ? event.payload : {};

  if (event.type === "tool.observation") {
    const toolId = typeof payload.toolId === "string" ? payload.toolId : "unknown-tool";
    const status = typeof payload.status === "string" ? payload.status : "recorded";
    return `Tool ${toolId} ${status}.`;
  }

  if (event.type === "run.progress") {
    const stage = typeof payload.stage === "string" ? payload.stage : "run";
    const status = typeof payload.status === "string" ? payload.status : "recorded";
    return `Run progress ${stage} ${status}.`;
  }

  if (event.type === "operator.recovery") {
    const action = typeof payload.action === "string" ? payload.action : "recovery";
    return `Operator recovery action recorded: ${action}.`;
  }

  if (event.type === "planner.run") {
    const status = typeof payload.status === "string" ? payload.status : "recorded";
    return `Planner run ${status}.`;
  }

  if (event.type === "done.packet") {
    const verdict = typeof payload.verdict === "string" ? payload.verdict : "recorded";
    return `Done packet ${verdict}.`;
  }

  if (event.type === "session.resumed") {
    return "Session resumed.";
  }

  return "Session started.";
}

function metadataForPersistedEvent(event: PersistedSessionEvent): Record<string, unknown> {
  const payload = isPlainObject(event.payload) ? event.payload : {};

  if (event.type === "session.started") {
    const task = isPlainObject(payload.task) ? payload.task : {};
    const tools = Array.isArray(payload.tools) ? payload.tools : [];
    return {
      status: typeof payload.status === "string" ? payload.status : "unknown",
      taskId: typeof task.id === "string" ? task.id : null,
      toolCount: tools.length
    };
  }

  if (event.type === "session.resumed") {
    return pickStringMetadata(payload, ["requestedSessionId", "resumedSessionId"]);
  }

  if (event.type === "tool.observation") {
    return pickStringMetadata(payload, ["toolId", "status"]);
  }

  if (event.type === "run.progress") {
    return pickStringMetadata(payload, ["stage", "status"]);
  }

  if (event.type === "operator.recovery") {
    return pickStringMetadata(payload, ["action", "requestedBy"]);
  }

  if (event.type === "planner.run") {
    return pickStringMetadata(payload, ["status", "failureReason"]);
  }

  if (event.type === "done.packet") {
    return pickStringMetadata(payload, ["verdict"]);
  }

  return {};
}

function pickStringMetadata(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.flatMap((key) => (typeof value[key] === "string" ? [[key, value[key]]] : [])));
}

function appendSessionEvent(
  events: Map<string, ApiSessionTimelineEvent[]>,
  event: ApiSessionTimelineEvent,
  eventStream?: ApiEventStreamHub
): void {
  const existing = events.get(event.sessionId) ?? [];
  events.set(event.sessionId, [...existing, event]);
  // G853: fan the real timeline event into the bounded SSE hub. JSON polling is
  // unaffected — this only reaches stream subscribers.
  eventStream?.publish(event);
}

function createSessionStartedEvent(session: HarnessSession): ApiSessionTimelineEvent {
  return {
    type: "session.started",
    sessionId: session.id,
    createdAt: new Date().toISOString(),
    summary: `Session started with status ${session.status}.`,
    metadata: {
      status: session.status,
      taskId: session.task?.id ?? null,
      toolCount: session.tools.length
    }
  };
}

function createSessionResumedEvent(session: HarnessSession, requestedSessionId: string): ApiSessionTimelineEvent {
  return {
    type: "session.resumed",
    sessionId: session.id,
    createdAt: new Date().toISOString(),
    summary: `Session resumed from ${requestedSessionId}.`,
    metadata: {
      requestedSessionId,
      status: session.status,
      taskId: session.task?.id ?? null
    }
  };
}

function createToolObservationEvent(sessionId: string, toolId: string, status: string, error: string | undefined): ApiSessionTimelineEvent {
  return {
    type: "tool.observation",
    sessionId,
    createdAt: new Date().toISOString(),
    summary: `Tool ${toolId} ${status}.`,
    metadata: {
      toolId,
      status,
      ...(error ? { error } : {})
    }
  };
}

function buildApiSessionTimelineSummary(sessionId: string, events: readonly ApiSessionTimelineEvent[]): ApiSessionTimelineSummary {
  const firstEvent = events[0];
  const lastEvent = events.at(-1);
  const toolObservations = events.filter((event) => event.type === "tool.observation").length;
  const resumeBreadcrumbs = events.filter((event) => event.type === "session.resumed").length;

  return {
    sessionId,
    eventCount: events.length,
    ...(firstEvent ? { startedAt: firstEvent.createdAt } : {}),
    ...(lastEvent ? { lastEventAt: lastEvent.createdAt } : {}),
    toolObservations,
    resumeBreadcrumbs,
    nextActions: toolObservations > 0 ? ["Inspect the latest tool observation before continuing."] : ["Run a tool against this session to extend the timeline."]
  };
}

function writeJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);

  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(body);
}

/** Single-line operator-facing error text — never `error.stack` or multi-line dumps. */
function publicApiErrorMessage(error: unknown): string {
  if (error instanceof ApiHttpError) {
    return error.message.slice(0, 500);
  }
  if (error instanceof Error) {
    const firstLine = error.message.split(/\r?\n/u, 1)[0] ?? "Request failed";
    return firstLine.slice(0, 500);
  }
  return "Request failed";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAddressInfo(address: ReturnType<Server["address"]>): address is AddressInfo {
  return typeof address === "object" && address !== null;
}

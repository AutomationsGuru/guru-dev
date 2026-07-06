import { randomUUID } from "node:crypto";

import { z } from "zod";

import { DonePacketSchema, type DonePacket } from "../core/types.js";
import type { OperationalStore } from "../operational/store.js";
import { PlannerRunReportSchema, type PlannerRunReport } from "../planner/schemas.js";
import { HarnessSessionSchema, type HarnessSession } from "./schemas.js";
import type { ToolObservation } from "../tools/registry.js";

export const PersistedSessionEventTypeSchema = z.enum([
  "session.started",
  "session.resumed",
  "run.progress",
  "operator.recovery",
  "tool.observation",
  "planner.run",
  "done.packet"
]);
export type PersistedSessionEventType = z.infer<typeof PersistedSessionEventTypeSchema>;

export const PersistedSessionResumeSchema = z
  .object({
    requestedSessionId: z.string().trim().min(1),
    resumedSessionId: z.string().trim().min(1),
    resumedAt: z.string().datetime()
  })
  .strict();
export type PersistedSessionResume = z.infer<typeof PersistedSessionResumeSchema>;

export const PersistedRunProgressStatusSchema = z.enum(["started", "in_progress", "completed", "blocked"]);
export type PersistedRunProgressStatus = z.infer<typeof PersistedRunProgressStatusSchema>;

export const PersistedRunProgressSchema = z
  .object({
    stage: z.string().trim().min(1),
    status: PersistedRunProgressStatusSchema,
    message: z.string().trim().min(1),
    recordedAt: z.string().datetime(),
    metadata: z.record(z.string(), z.unknown()).default({})
  })
  .strict();
export type PersistedRunProgress = z.infer<typeof PersistedRunProgressSchema>;
export type PersistableRunProgress = z.input<typeof PersistedRunProgressSchema>;

export const OperatorRecoveryActionSchema = z.enum(["pause", "resume", "abort", "retry-from-checkpoint", "continue-blocked"]);
export type OperatorRecoveryAction = z.infer<typeof OperatorRecoveryActionSchema>;

export const PersistedOperatorRecoverySchema = z
  .object({
    action: OperatorRecoveryActionSchema,
    reason: z.string().trim().min(1).optional(),
    requestedBy: z.string().trim().min(1).default("operator"),
    requestedAt: z.string().datetime(),
    metadata: z.record(z.string(), z.unknown()).default({})
  })
  .strict();
export type PersistedOperatorRecovery = z.infer<typeof PersistedOperatorRecoverySchema>;
export type PersistableOperatorRecovery = z.input<typeof PersistedOperatorRecoverySchema>;

export const RuntimeRecoveryStateSchema = z.enum(["new", "running", "blocked", "paused", "aborted", "completed"]);
export type RuntimeRecoveryState = z.infer<typeof RuntimeRecoveryStateSchema>;

export interface OperatorRecoveryPlan {
  readonly sessionId: string;
  readonly state: RuntimeRecoveryState;
  readonly recommendedAction: OperatorRecoveryAction | null;
  readonly availableActions: readonly OperatorRecoveryAction[];
  readonly recoverySummary: string;
  readonly nextActions: readonly string[];
}

export interface OperatorRecoveryResult {
  readonly accepted: boolean;
  readonly action: OperatorRecoveryAction;
  readonly blockers: readonly string[];
  readonly planBefore: OperatorRecoveryPlan;
  readonly planAfter: OperatorRecoveryPlan;
  readonly event?: PersistedSessionEvent;
}

export const PersistedToolObservationSchema = z
  .object({
    toolId: z.string().trim().min(1),
    status: z.enum(["succeeded", "failed"]),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
    durationMs: z.number().nonnegative().max(86_400_000),
    output: z.unknown().optional(),
    error: z.string().trim().min(1).optional()
  })
  .strict();
export type PersistedToolObservation = z.infer<typeof PersistedToolObservationSchema>;
export type PersistableToolObservation = ToolObservation | PersistedToolObservation;

export const PersistedSessionEventSchema = z
  .object({
    eventId: z.string().trim().min(1),
    sessionId: z.string().trim().min(1),
    type: PersistedSessionEventTypeSchema,
    createdAt: z.string().datetime(),
    payload: z.unknown()
  })
  .strict();
export type PersistedSessionEvent = z.infer<typeof PersistedSessionEventSchema>;

export interface PersistedSessionListOptions {
  readonly limit?: number;
}

export interface PersistedSessionListItem {
  readonly sessionId: string;
  readonly eventCount: number;
  readonly startedAt?: string;
  readonly lastEventAt?: string;
  readonly latestEventType?: PersistedSessionEventType;
  readonly taskId?: string;
  readonly taskTitle?: string;
}

export interface SessionPersistenceStore {
  recordSessionStarted(session: HarnessSession): Promise<PersistedSessionEvent>;
  recordSessionResumed(session: HarnessSession, requestedSessionId?: string): Promise<PersistedSessionEvent>;
  recordRunProgress(sessionId: string, progress: PersistableRunProgress): Promise<PersistedSessionEvent>;
  recordOperatorRecoveryAction(sessionId: string, recovery: PersistableOperatorRecovery): Promise<PersistedSessionEvent>;
  recordToolObservation(sessionId: string, observation: PersistableToolObservation): Promise<PersistedSessionEvent>;
  recordPlannerRun(report: PlannerRunReport): Promise<PersistedSessionEvent>;
  recordDonePacket(sessionId: string, donePacket: DonePacket): Promise<PersistedSessionEvent>;
  loadSession(sessionId: string): Promise<HarnessSession | undefined>;
  listEvents(sessionId: string): Promise<readonly PersistedSessionEvent[]>;
  listSessions(options?: PersistedSessionListOptions): Promise<readonly PersistedSessionListItem[]>;
}

export interface SessionObservabilitySummary {
  readonly sessionId: string;
  readonly eventCount: number;
  readonly startedAt?: string;
  readonly lastEventAt?: string;
  readonly progressBeacons: number;
  readonly resumeBreadcrumbs: number;
  readonly toolObservations: number;
  readonly plannerRuns: number;
  readonly donePackets: number;
  readonly recoverySummary: string;
  readonly nextActions: readonly string[];
}

const EVENT_SOURCE = "session-persistence";
const EVENT_SCOPE = "runtime-session";
const DEFAULT_PROJECT_SLUG = "guruharness";

export function createInMemorySessionPersistenceStore(): SessionPersistenceStore {
  return new InMemorySessionPersistenceStore();
}

export function createOperationalSessionPersistenceStore(
  operationalStore: OperationalStore,
  projectSlug = DEFAULT_PROJECT_SLUG
): SessionPersistenceStore {
  return new OperationalSessionPersistenceStore(operationalStore, projectSlug);
}

class InMemorySessionPersistenceStore implements SessionPersistenceStore {
  private readonly events: PersistedSessionEvent[] = [];

  async recordSessionStarted(session: HarnessSession): Promise<PersistedSessionEvent> {
    const event = createSessionEvent(session.id, "session.started", HarnessSessionSchema.parse(session));
    this.events.push(event);

    return cloneEvent(event);
  }

  async recordSessionResumed(session: HarnessSession, requestedSessionId = session.id): Promise<PersistedSessionEvent> {
    const event = createSessionEvent(
      session.id,
      "session.resumed",
      PersistedSessionResumeSchema.parse({ requestedSessionId, resumedSessionId: session.id, resumedAt: new Date().toISOString() })
    );
    this.events.push(event);

    return cloneEvent(event);
  }

  async recordRunProgress(sessionId: string, progress: PersistableRunProgress): Promise<PersistedSessionEvent> {
    const event = createSessionEvent(sessionId, "run.progress", PersistedRunProgressSchema.parse(progress));
    this.events.push(event);

    return cloneEvent(event);
  }

  async recordOperatorRecoveryAction(sessionId: string, recovery: PersistableOperatorRecovery): Promise<PersistedSessionEvent> {
    const event = createSessionEvent(sessionId, "operator.recovery", PersistedOperatorRecoverySchema.parse(recovery));
    this.events.push(event);

    return cloneEvent(event);
  }

  async recordToolObservation(sessionId: string, observation: PersistableToolObservation): Promise<PersistedSessionEvent> {
    const event = createSessionEvent(sessionId, "tool.observation", PersistedToolObservationSchema.parse(observation));
    this.events.push(event);

    return cloneEvent(event);
  }

  async recordPlannerRun(report: PlannerRunReport): Promise<PersistedSessionEvent> {
    const parsedReport = PlannerRunReportSchema.parse(report);
    for (const stepObservation of parsedReport.observations) {
      await this.recordToolObservation(parsedReport.sessionId, stepObservation.observation);
    }

    const event = createSessionEvent(parsedReport.sessionId, "planner.run", parsedReport);
    this.events.push(event);

    return cloneEvent(event);
  }

  async recordDonePacket(sessionId: string, donePacket: DonePacket): Promise<PersistedSessionEvent> {
    const event = createSessionEvent(sessionId, "done.packet", DonePacketSchema.parse(donePacket));
    this.events.push(event);

    return cloneEvent(event);
  }

  async loadSession(sessionId: string): Promise<HarnessSession | undefined> {
    const sessionEvents = this.events.filter((event) => event.sessionId === sessionId && event.type === "session.started");
    const event = sessionEvents.at(-1);

    return event ? HarnessSessionSchema.parse(structuredClone(event.payload)) : undefined;
  }

  async listEvents(sessionId: string): Promise<readonly PersistedSessionEvent[]> {
    return this.events.filter((event) => event.sessionId === sessionId).map(cloneEvent);
  }

  async listSessions(options: PersistedSessionListOptions = {}): Promise<readonly PersistedSessionListItem[]> {
    return buildPersistedSessionList(this.events, options.limit);
  }
}

class OperationalSessionPersistenceStore implements SessionPersistenceStore {
  constructor(
    private readonly operationalStore: OperationalStore,
    private readonly projectSlug: string
  ) {}

  async recordSessionStarted(session: HarnessSession): Promise<PersistedSessionEvent> {
    return this.recordEvent(session.id, "session.started", HarnessSessionSchema.parse(session));
  }

  async recordSessionResumed(session: HarnessSession, requestedSessionId = session.id): Promise<PersistedSessionEvent> {
    return this.recordEvent(
      session.id,
      "session.resumed",
      PersistedSessionResumeSchema.parse({ requestedSessionId, resumedSessionId: session.id, resumedAt: new Date().toISOString() })
    );
  }

  async recordRunProgress(sessionId: string, progress: PersistableRunProgress): Promise<PersistedSessionEvent> {
    return this.recordEvent(sessionId, "run.progress", PersistedRunProgressSchema.parse(progress));
  }

  async recordOperatorRecoveryAction(sessionId: string, recovery: PersistableOperatorRecovery): Promise<PersistedSessionEvent> {
    return this.recordEvent(sessionId, "operator.recovery", PersistedOperatorRecoverySchema.parse(recovery));
  }

  async recordToolObservation(sessionId: string, observation: PersistableToolObservation): Promise<PersistedSessionEvent> {
    return this.recordEvent(sessionId, "tool.observation", PersistedToolObservationSchema.parse(observation));
  }

  async recordPlannerRun(report: PlannerRunReport): Promise<PersistedSessionEvent> {
    const parsedReport = PlannerRunReportSchema.parse(report);
    for (const stepObservation of parsedReport.observations) {
      await this.recordToolObservation(parsedReport.sessionId, stepObservation.observation);
    }

    return this.recordEvent(parsedReport.sessionId, "planner.run", parsedReport);
  }

  async recordDonePacket(sessionId: string, donePacket: DonePacket): Promise<PersistedSessionEvent> {
    return this.recordEvent(sessionId, "done.packet", DonePacketSchema.parse(donePacket));
  }

  async loadSession(sessionId: string): Promise<HarnessSession | undefined> {
    const events = await this.listEvents(sessionId);
    const event = [...events].reverse().find((candidate) => candidate.type === "session.started");

    return event ? HarnessSessionSchema.parse(structuredClone(event.payload)) : undefined;
  }

  async listEvents(sessionId: string): Promise<readonly PersistedSessionEvent[]> {
    const snapshots = await this.operationalStore.listStateSnapshots({
      projectSlug: this.projectSlug,
      kinds: ["note"],
      source: EVENT_SOURCE,
      metadata: { scope: EVENT_SCOPE, sessionId }
    });

    return snapshots.flatMap(parsePersistedSessionEvent).sort(compareEventsByCreatedAt);
  }

  async listSessions(options: PersistedSessionListOptions = {}): Promise<readonly PersistedSessionListItem[]> {
    const snapshots = await this.operationalStore.listStateSnapshots({
      projectSlug: this.projectSlug,
      kinds: ["note"],
      source: EVENT_SOURCE,
      metadata: { scope: EVENT_SCOPE }
    });

    return buildPersistedSessionList(snapshots.flatMap(parsePersistedSessionEvent), options.limit);
  }

  private async recordEvent(
    sessionId: string,
    type: PersistedSessionEventType,
    payload: unknown
  ): Promise<PersistedSessionEvent> {
    const event = createSessionEvent(sessionId, type, payload);
    await this.operationalStore.writeStateSnapshot({
      projectSlug: this.projectSlug,
      kind: "note",
      title: `${type}: ${sessionId}`,
      body: JSON.stringify(event),
      source: EVENT_SOURCE,
      metadata: {
        scope: EVENT_SCOPE,
        sessionId,
        eventType: type
      }
    });

    return event;
  }
}

function createSessionEvent(sessionId: string, type: PersistedSessionEventType, payload: unknown): PersistedSessionEvent {
  return PersistedSessionEventSchema.parse({
    eventId: randomUUID(),
    sessionId,
    type,
    createdAt: new Date().toISOString(),
    payload
  });
}

function parsePersistedSessionEvent(snapshot: { readonly body: string }): PersistedSessionEvent[] {
  try {
    return [PersistedSessionEventSchema.parse(JSON.parse(snapshot.body) as unknown)];
  } catch {
    return [];
  }
}

function buildPersistedSessionList(events: readonly PersistedSessionEvent[], limit = 20): readonly PersistedSessionListItem[] {
  const groups = new Map<string, PersistedSessionEvent[]>();

  for (const event of events) {
    groups.set(event.sessionId, [...(groups.get(event.sessionId) ?? []), event]);
  }

  return [...groups.entries()]
    .map(([sessionId, sessionEvents]) => buildPersistedSessionListItem(sessionId, sessionEvents))
    .filter((item): item is PersistedSessionListItem => item !== null)
    .sort((left, right) => Date.parse(right.lastEventAt ?? "") - Date.parse(left.lastEventAt ?? ""))
    .slice(0, limit);
}

function buildPersistedSessionListItem(sessionId: string, events: readonly PersistedSessionEvent[]): PersistedSessionListItem | null {
  const sortedEvents = [...events].sort(compareEventsByCreatedAt);
  const firstEvent = sortedEvents[0];
  const lastEvent = sortedEvents.at(-1);

  if (!firstEvent || !lastEvent) {
    return null;
  }

  const startedSession = sortedEvents.find((event) => event.type === "session.started");
  const parsedSession = startedSession ? HarnessSessionSchema.safeParse(startedSession.payload) : undefined;
  const task = parsedSession?.success ? parsedSession.data.task : undefined;

  return {
    sessionId,
    eventCount: sortedEvents.length,
    startedAt: firstEvent.createdAt,
    lastEventAt: lastEvent.createdAt,
    latestEventType: lastEvent.type,
    ...(task?.id ? { taskId: task.id } : {}),
    ...(task?.title ? { taskTitle: task.title } : {})
  };
}

export function buildSessionObservabilitySummary(
  sessionId: string,
  events: readonly PersistedSessionEvent[]
): SessionObservabilitySummary {
  const sortedEvents = [...events].sort(compareEventsByCreatedAt);
  const progressBeacons = sortedEvents.filter((event) => event.type === "run.progress").length;
  const resumeBreadcrumbs = sortedEvents.filter((event) => event.type === "session.resumed").length;
  const toolObservations = sortedEvents.filter((event) => event.type === "tool.observation").length;
  const plannerRuns = sortedEvents.filter((event) => event.type === "planner.run").length;
  const donePackets = sortedEvents.filter((event) => event.type === "done.packet").length;
  const blockedProgress = sortedEvents.find((event) => {
    if (event.type !== "run.progress") {
      return false;
    }

    const parsed = PersistedRunProgressSchema.safeParse(event.payload);

    return parsed.success && parsed.data.status === "blocked";
  });

  const firstEvent = sortedEvents[0];
  const lastEvent = sortedEvents.at(-1);

  return {
    sessionId,
    eventCount: sortedEvents.length,
    ...(firstEvent ? { startedAt: firstEvent.createdAt } : {}),
    ...(lastEvent ? { lastEventAt: lastEvent.createdAt } : {}),
    progressBeacons,
    resumeBreadcrumbs,
    toolObservations,
    plannerRuns,
    donePackets,
    recoverySummary: buildRecoverySummary({ blocked: Boolean(blockedProgress), donePackets, plannerRuns, progressBeacons, resumeBreadcrumbs }),
    nextActions: buildObservabilityNextActions({ blocked: Boolean(blockedProgress), donePackets, plannerRuns, progressBeacons, resumeBreadcrumbs })
  };
}

export function buildOperatorRecoveryPlan(sessionId: string, events: readonly PersistedSessionEvent[]): OperatorRecoveryPlan {
  const sortedEvents = [...events].sort(compareEventsByCreatedAt);
  const state = deriveRecoveryState(sortedEvents);
  const availableActions = buildAvailableRecoveryActions(state);
  const recommendedAction = availableActions[0] ?? null;

  return {
    sessionId,
    state,
    recommendedAction,
    availableActions,
    recoverySummary: buildOperatorRecoverySummary(state),
    nextActions: buildOperatorRecoveryNextActions(state, recommendedAction)
  };
}

export async function applyOperatorRecoveryAction(
  store: SessionPersistenceStore,
  sessionId: string,
  recovery: Omit<PersistableOperatorRecovery, "requestedAt">
): Promise<OperatorRecoveryResult> {
  const action = OperatorRecoveryActionSchema.parse(recovery.action);
  const eventsBefore = await store.listEvents(sessionId);
  const planBefore = buildOperatorRecoveryPlan(sessionId, eventsBefore);

  if (!planBefore.availableActions.includes(action)) {
    return {
      accepted: false,
      action,
      blockers: [`Recovery action ${action} is not available while session is ${planBefore.state}.`],
      planBefore,
      planAfter: planBefore
    };
  }

  const event = await store.recordOperatorRecoveryAction(sessionId, {
    ...recovery,
    action,
    requestedAt: new Date().toISOString()
  });
  await store.recordRunProgress(sessionId, {
    stage: "operator-recovery",
    status: action === "abort" ? "blocked" : "in_progress",
    message: `Operator recovery action accepted: ${action}.`,
    recordedAt: new Date().toISOString(),
    metadata: { action }
  });
  const eventsAfter = await store.listEvents(sessionId);

  return {
    accepted: true,
    action,
    blockers: [],
    planBefore,
    planAfter: buildOperatorRecoveryPlan(sessionId, eventsAfter),
    event
  };
}

function deriveRecoveryState(events: readonly PersistedSessionEvent[]): RuntimeRecoveryState {
  const latestRecovery = [...events].reverse().find((event) => event.type === "operator.recovery");
  const parsedRecovery = latestRecovery ? PersistedOperatorRecoverySchema.safeParse(latestRecovery.payload) : null;

  if (parsedRecovery?.success && parsedRecovery.data.action === "abort") {
    return "aborted";
  }

  if (parsedRecovery?.success && parsedRecovery.data.action === "pause") {
    return "paused";
  }

  if (events.some((event) => event.type === "done.packet")) {
    return "completed";
  }

  const hasBlockedProgress = events.some((event) => {
    if (event.type !== "run.progress") {
      return false;
    }

    const parsed = PersistedRunProgressSchema.safeParse(event.payload);

    return parsed.success && parsed.data.status === "blocked";
  });

  if (hasBlockedProgress) {
    return "blocked";
  }

  if (events.some((event) => event.type === "run.progress" || event.type === "planner.run" || event.type === "tool.observation")) {
    return "running";
  }

  return "new";
}

function buildAvailableRecoveryActions(state: RuntimeRecoveryState): readonly OperatorRecoveryAction[] {
  switch (state) {
    case "new":
      return ["resume"];
    case "running":
      return ["pause", "abort"];
    case "blocked":
      return ["continue-blocked", "retry-from-checkpoint", "abort"];
    case "paused":
      return ["resume", "abort"];
    case "aborted":
      return ["retry-from-checkpoint"];
    case "completed":
      return ["retry-from-checkpoint"];
  }
}

function buildOperatorRecoverySummary(state: RuntimeRecoveryState): string {
  switch (state) {
    case "new":
      return "Session has not started run work; resume to begin or attach context.";
    case "running":
      return "Session has active progress; pause or abort before changing recovery strategy.";
    case "blocked":
      return "Session is blocked; continue after resolving blockers or retry from the latest checkpoint.";
    case "paused":
      return "Session is paused; resume when ready or abort to stop recovery.";
    case "aborted":
      return "Session was aborted; retry from checkpoint if the operator wants to restart safely.";
    case "completed":
      return "Session completed; retry from checkpoint only if follow-up work should reuse the timeline.";
  }
}

function buildOperatorRecoveryNextActions(state: RuntimeRecoveryState, recommendedAction: OperatorRecoveryAction | null): readonly string[] {
  if (!recommendedAction) {
    return ["No operator recovery action is currently available."];
  }

  return [`Recommended recovery action: ${recommendedAction}.`, `Current recovery state: ${state}.`];
}

function buildRecoverySummary(options: {
  readonly blocked: boolean;
  readonly donePackets: number;
  readonly plannerRuns: number;
  readonly progressBeacons: number;
  readonly resumeBreadcrumbs: number;
}): string {
  if (options.blocked) {
    return "Run recorded a blocked progress beacon; review blockers, resume breadcrumbs, and the latest done packet before continuing.";
  }

  if (options.donePackets > 0) {
    return "Run reached a done packet; use the timeline to audit planner, tool, and review progress before follow-up work.";
  }

  if (options.plannerRuns > 0 || options.progressBeacons > 0) {
    return "Run has partial progress; inspect the latest progress beacon before resuming or retrying.";
  }

  if (options.resumeBreadcrumbs > 0) {
    return "Session was resumed but has no new run output yet; continue from the resumed session context.";
  }

  return "Session has only startup state; begin planning or resume with additional context.";
}

function buildObservabilityNextActions(options: {
  readonly blocked: boolean;
  readonly donePackets: number;
  readonly plannerRuns: number;
  readonly progressBeacons: number;
  readonly resumeBreadcrumbs: number;
}): readonly string[] {
  if (options.blocked) {
    return ["Inspect the latest blocker and progress beacon.", "Rerun with the same session id after resolving the blocker."];
  }

  if (options.donePackets > 0) {
    return ["Review the done packet and timeline before starting the next run."];
  }

  if (options.plannerRuns > 0 || options.progressBeacons > 0 || options.resumeBreadcrumbs > 0) {
    return ["Resume from the latest session id or record a new progress beacon before continuing."];
  }

  return ["Start planner execution for this session."];
}

function compareEventsByCreatedAt(left: PersistedSessionEvent, right: PersistedSessionEvent): number {
  return Date.parse(left.createdAt) - Date.parse(right.createdAt);
}

function cloneEvent(event: PersistedSessionEvent): PersistedSessionEvent {
  return PersistedSessionEventSchema.parse(structuredClone(event));
}

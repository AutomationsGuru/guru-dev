import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyOperatorRecoveryAction,
  buildOperatorRecoveryPlan,
  buildSessionObservabilitySummary,
  createHarnessRuntime,
  createInMemoryOperationalStore,
  createInMemorySessionPersistenceStore,
  createOperationalSessionPersistenceStore,
  runSelfBuildExecutor,
  type PlannerModel,
  type PlannerModelRequest
} from "../../src/index.js";
import type { CommandExecutor } from "../../src/review/gates.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

class FixedPlannerModel implements PlannerModel {
  readonly requests: PlannerModelRequest[] = [];

  constructor(private readonly plan: unknown) {}

  createPlan(request: PlannerModelRequest): unknown {
    this.requests.push(request);

    return this.plan;
  }
}

describe("session persistence", () => {
  it("should persist and resume started sessions", async () => {
    const sessionPersistenceStore = createInMemorySessionPersistenceStore();
    const runtime = createHarnessRuntime({ sessionPersistenceStore });
    const session = await runtime.startSession({ cwd: repoRoot });

    const resumedSession = await runtime.resumeSession(session.id, { cwd: repoRoot });
    const events = await sessionPersistenceStore.listEvents(session.id);

    expect(resumedSession).toMatchObject({ id: session.id, task: { id: "api-startup-dogfood" } });
    expect(events.map((event) => event.type)).toEqual(["session.started", "session.resumed"]);
    expect(events[1]?.payload).toMatchObject({ requestedSessionId: session.id, resumedSessionId: session.id });
  });

  it("should rebuild a resumed session registry and execute tools", async () => {
    const sessionPersistenceStore = createInMemorySessionPersistenceStore();
    const firstRuntime = createHarnessRuntime({ sessionPersistenceStore });
    const session = await firstRuntime.startSession({ cwd: repoRoot });
    const secondRuntime = createHarnessRuntime({ sessionPersistenceStore });

    await secondRuntime.resumeSession(session.id, { cwd: repoRoot });
    const observation = await secondRuntime.executeTool(session.id, "repo.context.resolve", { cwd: repoRoot });

    expect(observation).toMatchObject({ status: "succeeded", output: expect.objectContaining({ repoRoot }) });
  });

  it("should list recent persisted sessions with compact summaries", async () => {
    const sessionPersistenceStore = createInMemorySessionPersistenceStore();
    const runtime = createHarnessRuntime({ sessionPersistenceStore });
    const firstSession = await runtime.startSession({ cwd: repoRoot });
    const secondSession = await runtime.startSession({ cwd: repoRoot });

    await runtime.executeTool(firstSession.id, "repo.context.resolve", { cwd: repoRoot });
    await runtime.executeTool(secondSession.id, "repo.context.resolve", { cwd: repoRoot });
    const sessions = await runtime.listSessions({ limit: 1 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: secondSession.id,
      eventCount: 2,
      latestEventType: "tool.observation",
      taskId: "api-startup-dogfood",
      taskTitle: "Dogfood API startup playbook"
    });
  });

  it("should persist direct tool observations and planner runs", async () => {
    const sessionPersistenceStore = createInMemorySessionPersistenceStore();
    const model = new FixedPlannerModel({
      objective: "Resolve repo context.",
      summary: "Use one tool.",
      steps: [
        {
          id: "repo-context",
          title: "Resolve repository context",
          toolId: "repo.context.resolve",
          input: { cwd: repoRoot }
        }
      ]
    });
    const runtime = createHarnessRuntime({ sessionPersistenceStore, plannerModel: model });
    const session = await runtime.startSession({ cwd: repoRoot });

    await runtime.executeTool(session.id, "repo.context.resolve", { cwd: repoRoot });
    const plannerReport = await runtime.runPlanner(session.id, { objective: "Resolve repo context." });
    const events = await sessionPersistenceStore.listEvents(session.id);

    expect(plannerReport.status).toBe("completed");
    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "tool.observation",
      "tool.observation",
      "planner.run"
    ]);
  });

  it("should persist events through the operational store snapshot API", async () => {
    const operationalStore = createInMemoryOperationalStore();
    const sessionPersistenceStore = createOperationalSessionPersistenceStore(operationalStore);
    const runtime = createHarnessRuntime({ operationalStore, sessionPersistenceStore });
    const session = await runtime.startSession({ cwd: repoRoot });

    await runtime.executeTool(session.id, "repo.context.resolve", { cwd: repoRoot });
    await operationalStore.writeStateSnapshot({
      projectSlug: "guruharness",
      kind: "note",
      title: `corrupted event: ${session.id}`,
      body: "not-json",
      source: "session-persistence",
      metadata: { scope: "runtime-session", sessionId: session.id, eventType: "corrupted" }
    });
    const loadedSession = await sessionPersistenceStore.loadSession(session.id);
    const events = await sessionPersistenceStore.listEvents(session.id);
    const snapshots = await operationalStore.listStateSnapshots({
      projectSlug: "guruharness",
      kinds: ["note"],
      source: "session-persistence",
      metadata: { scope: "runtime-session", sessionId: session.id }
    });

    expect(loadedSession?.id).toBe(session.id);
    expect(events.map((event) => event.type)).toEqual(["session.started", "tool.observation"]);
    expect(await sessionPersistenceStore.listSessions()).toEqual([
      expect.objectContaining({ sessionId: session.id, eventCount: 2, latestEventType: "tool.observation" })
    ]);
    expect(snapshots.map((snapshot) => snapshot.metadata.eventType)).toEqual([
      "session.started",
      "tool.observation",
      "corrupted"
    ]);
  });

  it("should record progress beacons and summarize session recovery state", async () => {
    const sessionPersistenceStore = createInMemorySessionPersistenceStore();
    const runtime = createHarnessRuntime({ sessionPersistenceStore });
    const session = await runtime.startSession({ cwd: repoRoot });

    await sessionPersistenceStore.recordRunProgress(session.id, {
      stage: "planner",
      status: "blocked",
      message: "Planner blocked on missing model.",
      recordedAt: new Date().toISOString(),
      metadata: { failureReason: "missing-model" }
    });
    const events = await sessionPersistenceStore.listEvents(session.id);
    const summary = buildSessionObservabilitySummary(session.id, events);

    expect(events.map((event) => event.type)).toEqual(["session.started", "run.progress"]);
    expect(summary).toMatchObject({
      sessionId: session.id,
      eventCount: 2,
      progressBeacons: 1,
      resumeBreadcrumbs: 0,
      recoverySummary: expect.stringContaining("blocked progress beacon")
    });
    expect(summary.nextActions).toContain("Inspect the latest blocker and progress beacon.");
  });

  it("should plan and record operator recovery actions from a blocked timeline", async () => {
    const sessionPersistenceStore = createInMemorySessionPersistenceStore();
    const runtime = createHarnessRuntime({ sessionPersistenceStore });
    const session = await runtime.startSession({ cwd: repoRoot });

    await sessionPersistenceStore.recordRunProgress(session.id, {
      stage: "planner",
      status: "blocked",
      message: "Planner blocked on missing model.",
      recordedAt: new Date().toISOString(),
      metadata: { failureReason: "missing-model" }
    });
    const beforePlan = buildOperatorRecoveryPlan(session.id, await sessionPersistenceStore.listEvents(session.id));
    const result = await applyOperatorRecoveryAction(sessionPersistenceStore, session.id, {
      action: "continue-blocked",
      reason: "Credentials repaired outside the repo.",
      requestedBy: "test-operator"
    });
    const events = await sessionPersistenceStore.listEvents(session.id);

    expect(beforePlan).toMatchObject({
      state: "blocked",
      recommendedAction: "continue-blocked",
      availableActions: ["continue-blocked", "retry-from-checkpoint", "abort"]
    });
    expect(result).toMatchObject({
      accepted: true,
      action: "continue-blocked",
      blockers: [],
      planBefore: expect.objectContaining({ state: "blocked" }),
      planAfter: expect.objectContaining({ state: "blocked" })
    });
    expect(events.map((event) => event.type)).toEqual(["session.started", "run.progress", "operator.recovery", "run.progress"]);
    expect(events[2]?.payload).toMatchObject({ action: "continue-blocked", requestedBy: "test-operator" });
  });

  it("should reject unavailable operator recovery actions without mutating the timeline", async () => {
    const sessionPersistenceStore = createInMemorySessionPersistenceStore();
    const runtime = createHarnessRuntime({ sessionPersistenceStore });
    const session = await runtime.startSession({ cwd: repoRoot });

    const result = await applyOperatorRecoveryAction(sessionPersistenceStore, session.id, {
      action: "continue-blocked",
      reason: "Not actually blocked."
    });
    const events = await sessionPersistenceStore.listEvents(session.id);

    expect(result).toMatchObject({
      accepted: false,
      action: "continue-blocked",
      blockers: [expect.stringContaining("not available")],
      planBefore: expect.objectContaining({ state: "new", availableActions: ["resume"] }),
      planAfter: expect.objectContaining({ state: "new" })
    });
    expect(events.map((event) => event.type)).toEqual(["session.started"]);
  });

  it("should persist self-build executor done packets", async () => {
    const sessionPersistenceStore = createInMemorySessionPersistenceStore();
    const model = new FixedPlannerModel({ objective: "Execute task.", summary: "No tools needed.", steps: [] });

    const report = await runSelfBuildExecutor({
      cwd: repoRoot,
      taskId: "self-build-executor",
      allowDirtyWorkspace: true,
      plannerModel: model,
      sessionPersistenceStore,
      commandExecutor: createCommandExecutor()
    });
    const events = await sessionPersistenceStore.listEvents(report.session.id);

    expect(report.verdict).toBe("YELLOW");
    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "run.progress",
      "run.progress",
      "session.resumed",
      "planner.run",
      "run.progress",
      "run.progress",
      "run.progress",
      "run.progress",
      "done.packet"
    ]);
    expect(report.observability).toMatchObject({
      sessionId: report.session.id,
      progressBeacons: 6,
      resumeBreadcrumbs: 1,
      plannerRuns: 1,
      donePackets: 1,
      recoverySummary: expect.stringContaining("done packet")
    });
  });
});

function createCommandExecutor(): CommandExecutor {
  return async (command) => ({
    exitCode: 0,
    stdout: command.join(" "),
    stderr: "",
    durationMs: 1
  });
}

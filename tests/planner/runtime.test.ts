import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createHarnessRuntime, type PlannerModel, type PlannerModelRequest } from "../../src/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

class RecordingPlannerModel implements PlannerModel {
  readonly requests: PlannerModelRequest[] = [];

  constructor(private readonly plan: unknown) {}

  createPlan(request: PlannerModelRequest): unknown {
    this.requests.push(request);

    return this.plan;
  }
}

describe("runPlannerExecution", () => {
  it("should ask the model for a plan and execute typed tool steps in order", async () => {
    const model = new RecordingPlannerModel({
      objective: "Inspect GuruHarness repo context.",
      summary: "Resolve repo context, then list skills.",
      steps: [
        {
          id: "repo-context",
          title: "Resolve repository context",
          toolId: "repo.context.resolve",
          input: { cwd: repoRoot }
        },
        {
          id: "list-skills",
          title: "List configured skills",
          toolId: "skills.catalog.list",
          input: {}
        }
      ]
    });
    const runtime = createHarnessRuntime({ plannerModel: model });
    const session = await runtime.startSession({ cwd: repoRoot });

    const report = await runtime.runPlanner(session.id, {
      objective: "Inspect GuruHarness repo context."
    });

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.tools.map((tool) => tool.id)).toEqual(
      expect.arrayContaining(["repo.context.resolve", "skills.catalog.list"])
    );
    expect(report).toMatchObject({
      sessionId: session.id,
      objective: "Inspect GuruHarness repo context.",
      status: "completed",
      blockers: []
    });
    expect(report.observations.map((entry) => entry.step.id)).toEqual(["repo-context", "list-skills"]);
    expect(report.observations.every((entry) => entry.observation.status === "succeeded")).toBe(true);
  });

  it("should block when the model returns an invalid plan", async () => {
    const model = new RecordingPlannerModel({ objective: "missing summary" });
    const runtime = createHarnessRuntime({ plannerModel: model });
    const session = await runtime.startSession({ cwd: repoRoot });

    const report = await runtime.runPlanner(session.id, { objective: "Run bad plan." });

    expect(report.status).toBe("blocked");
    expect(report.failureReason).toBe("invalid-plan");
    expect(report.plan).toBeNull();
    expect(report.blockers[0]).toContain("invalid plan");
  });

  it("should block before execution when a plan references an unregistered tool", async () => {
    const model = new RecordingPlannerModel({
      objective: "Use a missing tool.",
      summary: "This plan should be rejected before dispatch.",
      steps: [
        {
          id: "missing",
          title: "Call missing tool",
          toolId: "missing.tool",
          input: {}
        }
      ]
    });
    const runtime = createHarnessRuntime({ plannerModel: model });
    const session = await runtime.startSession({ cwd: repoRoot });

    const report = await runtime.runPlanner(session.id, { objective: "Use a missing tool." });

    expect(report.status).toBe("blocked");
    expect(report.failureReason).toBe("tool-failed");
    expect(report.observations).toEqual([]);
    expect(report.blockers).toEqual(["Planner step missing references unregistered tool: missing.tool"]);
  });

  it("should block when the planner produces too many steps", async () => {
    const model = new RecordingPlannerModel({
      objective: "Too many steps.",
      summary: "The max step guard should stop this plan.",
      steps: [
        { id: "one", title: "One", toolId: "repo.context.resolve", input: { cwd: repoRoot } },
        { id: "two", title: "Two", toolId: "repo.context.resolve", input: { cwd: repoRoot } }
      ]
    });
    const runtime = createHarnessRuntime({ plannerModel: model });
    const session = await runtime.startSession({ cwd: repoRoot });

    const report = await runtime.runPlanner(session.id, { objective: "Too many steps.", maxSteps: 1 });

    expect(report.status).toBe("blocked");
    expect(report.failureReason).toBe("invalid-plan");
    expect(report.observations).toEqual([]);
    expect(report.blockers).toEqual(["Planner produced 2 step(s), exceeding maxSteps 1."]);
  });
});

describe("createHarnessRuntime planner integration", () => {
  it("should block planner execution when no planner model is configured", async () => {
    const runtime = createHarnessRuntime();
    const session = await runtime.startSession({ cwd: repoRoot });

    const report = await runtime.runPlanner(session.id, { objective: "Plan without a model." });

    expect(report).toMatchObject({
      sessionId: session.id,
      objective: "Plan without a model.",
      status: "blocked",
      failureReason: "missing-model",
      plan: null,
      observations: [],
      blockers: ["No planner model is configured for this harness runtime."]
    });
  });

  it("should block planner execution for an unknown session", async () => {
    const model = new RecordingPlannerModel({ objective: "unused", summary: "unused", steps: [] });
    const runtime = createHarnessRuntime({ plannerModel: model });

    const report = await runtime.runPlanner("missing-session", { objective: "Plan for missing session." });

    expect(report).toMatchObject({
      sessionId: "missing-session",
      status: "blocked",
      failureReason: "missing-session",
      blockers: ["Harness session not found: missing-session"]
    });
    expect(model.requests).toEqual([]);
  });

  it("should allow planner execution against an explicitly provided session and registry", async () => {
    const model = new RecordingPlannerModel({
      objective: "No-op plan.",
      summary: "Model can decide no tools are needed.",
      steps: []
    });
    const runtime = createHarnessRuntime({ plannerModel: model });
    const session = await runtime.startSession({ cwd: repoRoot });

    const report = await runtime.runPlanner(session.id, { objective: "No-op plan." });

    expect(report.status).toBe("completed");
    expect(report.plan?.steps).toEqual([]);
  });
});

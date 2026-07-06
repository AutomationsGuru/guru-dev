import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PlannerModelRequestSchema,
  PlannerPlanSchema,
  PlannerRunOptionsSchema,
  PlannerRunReportSchema,
  PlannerStepObservationSchema,
  PlannerStepSchema,
  PlannerToolObservationSchema,
  startHarnessSession
} from "../../src/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const isoNow = new Date("2026-06-15T00:00:00.000Z").toISOString();
const isoLater = new Date("2026-06-15T00:01:00.000Z").toISOString();

describe("PlannerPlanSchema", () => {
  it("should require explicit tool input for every planner step", () => {
    const result = PlannerPlanSchema.safeParse({
      objective: "Inspect repo.",
      summary: "Missing input should be invalid.",
      steps: [{ id: "one", title: "One", toolId: "repo.context.resolve" }]
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["steps", 0, "input"]);
  });

  it("should allow an empty step list for no-op plans", () => {
    const plan = PlannerPlanSchema.parse({
      objective: "No-op.",
      summary: "The model decided no tools are needed."
    });

    expect(plan.steps).toEqual([]);
  });
});

describe("PlannerStepSchema", () => {
  it("should validate required step fields", () => {
    const step = PlannerStepSchema.parse({
      id: "repo-context",
      title: "Resolve repo context",
      toolId: "repo.context.resolve",
      input: {}
    });

    expect(step.toolId).toBe("repo.context.resolve");
    expect(PlannerStepSchema.safeParse({ id: "", title: "Resolve", toolId: "repo.context.resolve", input: {} }).success).toBe(false);
    expect(PlannerStepSchema.safeParse({ id: "repo-context", title: "Resolve", toolId: "", input: {} }).success).toBe(false);
  });
});

describe("PlannerModelRequestSchema", () => {
  it("should validate model requests with a real harness session and tool summaries", async () => {
    const session = await startHarnessSession({ cwd: repoRoot });
    const request = PlannerModelRequestSchema.parse({
      objective: "Inspect repo.",
      session,
      tools: session.tools
    });

    expect(request.session.id).toBe(session.id);
    expect(request.tools.length).toBeGreaterThan(0);
  });

  it("should reject missing required fields", () => {
    expect(PlannerModelRequestSchema.safeParse({ objective: "Inspect repo.", tools: [] }).success).toBe(false);
    expect(PlannerModelRequestSchema.safeParse({ objective: "", session: {}, tools: [] }).success).toBe(false);
  });
});

describe("PlannerRunOptionsSchema", () => {
  it("should default maxSteps for runtime input", () => {
    const options = PlannerRunOptionsSchema.parse({ objective: "Plan a task." });

    expect(options).toEqual({ objective: "Plan a task.", maxSteps: 10 });
  });

  it("should accept maxSteps at the configured upper bound", () => {
    expect(PlannerRunOptionsSchema.parse({ objective: "Plan many steps.", maxSteps: 25 }).maxSteps).toBe(25);
  });

  it("should reject empty objectives and invalid step limits", () => {
    expect(PlannerRunOptionsSchema.safeParse({ objective: "", maxSteps: 1 }).success).toBe(false);
    expect(PlannerRunOptionsSchema.safeParse({ objective: "Plan.", maxSteps: 0 }).success).toBe(false);
    expect(PlannerRunOptionsSchema.safeParse({ objective: "Plan.", maxSteps: -1 }).success).toBe(false);
    expect(PlannerRunOptionsSchema.safeParse({ objective: "Plan.", maxSteps: 26 }).success).toBe(false);
  });
});

describe("PlannerToolObservationSchema", () => {
  it("should validate ISO timestamps and bounded duration", () => {
    const observation = PlannerToolObservationSchema.parse({
      toolId: "repo.context.resolve",
      status: "succeeded",
      startedAt: isoNow,
      endedAt: isoNow,
      durationMs: 86_400_000,
      output: { ok: true }
    });

    expect(observation.status).toBe("succeeded");
  });

  it("should reject invalid status, timestamps, and durations", () => {
    expect(
      PlannerToolObservationSchema.safeParse({
        toolId: "repo.context.resolve",
        status: "unknown",
        startedAt: isoNow,
        endedAt: isoNow,
        durationMs: 1
      }).success
    ).toBe(false);
    expect(
      PlannerToolObservationSchema.safeParse({
        toolId: "repo.context.resolve",
        status: "succeeded",
        startedAt: "not-a-date",
        endedAt: isoNow,
        durationMs: 1
      }).success
    ).toBe(false);
    expect(
      PlannerToolObservationSchema.safeParse({
        toolId: "repo.context.resolve",
        status: "succeeded",
        startedAt: isoNow,
        endedAt: isoNow,
        durationMs: 86_400_001
      }).success
    ).toBe(false);
    expect(
      PlannerToolObservationSchema.safeParse({
        toolId: "repo.context.resolve",
        status: "succeeded",
        startedAt: isoLater,
        endedAt: isoNow,
        durationMs: 1
      }).success
    ).toBe(false);
  });
});

describe("PlannerStepObservationSchema", () => {
  it("should validate a planner step and tool observation pair", () => {
    const entry = PlannerStepObservationSchema.parse({
      step: {
        id: "repo-context",
        title: "Resolve repo context",
        toolId: "repo.context.resolve",
        input: {}
      },
      observation: {
        toolId: "repo.context.resolve",
        status: "succeeded",
        startedAt: isoNow,
        endedAt: isoNow,
        durationMs: 0,
        output: { ok: true }
      }
    });

    expect(entry.step.id).toBe("repo-context");
  });

  it("should reject invalid nested step or observation fields", () => {
    expect(
      PlannerStepObservationSchema.safeParse({
        step: {
          id: "repo-context",
          title: "Resolve repo context",
          toolId: "repo.context.resolve"
        },
        observation: {
          toolId: "repo.context.resolve",
          status: "succeeded",
          startedAt: isoNow,
          endedAt: isoNow,
          durationMs: 0
        }
      }).success
    ).toBe(false);
  });
});

describe("PlannerRunReportSchema", () => {
  it("should allow empty observations and blockers for completed reports", () => {
    const report = PlannerRunReportSchema.parse({
      sessionId: "session-1",
      objective: "Plan.",
      status: "completed",
      startedAt: isoNow,
      endedAt: isoNow,
      durationMs: 0,
      plan: {
        objective: "Plan.",
        summary: "No tools needed.",
        steps: []
      },
      observations: [],
      blockers: [],
      nextActions: ["Continue."]
    });

    expect(report.observations).toEqual([]);
  });

  it("should reject invalid report status and unbounded duration", () => {
    expect(
      PlannerRunReportSchema.safeParse({
        sessionId: "session-1",
        objective: "Plan.",
        status: "unknown",
        startedAt: isoNow,
        endedAt: isoNow,
        durationMs: 0,
        plan: null,
        observations: [],
        blockers: [],
        nextActions: []
      }).success
    ).toBe(false);
    expect(
      PlannerRunReportSchema.safeParse({
        sessionId: "session-1",
        objective: "Plan.",
        status: "blocked",
        startedAt: isoNow,
        endedAt: isoNow,
        durationMs: 86_400_001,
        plan: null,
        observations: [],
        blockers: ["blocked"],
        nextActions: []
      }).success
    ).toBe(false);
    expect(
      PlannerRunReportSchema.safeParse({
        sessionId: "session-1",
        objective: "Plan.",
        status: "blocked",
        startedAt: isoLater,
        endedAt: isoNow,
        durationMs: 1,
        plan: null,
        observations: [],
        blockers: ["blocked"],
        nextActions: []
      }).success
    ).toBe(false);
  });
});

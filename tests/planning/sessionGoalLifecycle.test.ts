import {
  acceptSessionGoalCriteria,
  amendSessionGoal,
  clearSessionGoal,
  completeSessionGoal,
  createSessionGoal,
  getActiveSessionGoal,
  pauseSessionGoal,
  proposeSessionGoal,
  resumeSessionGoal
} from '../../src/planning/sessionGoalLifecycle.js';
import { SessionGoalSchema } from '../../src/planning/sessionGoalLifecycleSchema.js';

const NOW = "2026-07-19T07:01:00.000Z";
const LATER = "2026-07-19T07:05:00.000Z";

beforeEach(() => {
  clearSessionGoal("session-1");
  clearSessionGoal("session-2");
  clearSessionGoal("session-missing");
});

function createProposedGoal() {
  return createSessionGoal(
    {
      sessionId: "session-1",
      objective: "Ship the session goal lifecycle module.",
      acceptanceCriteria: ["Lifecycle transitions covered by tests.", "Only one active goal per session."]
    },
    { now: () => NOW }
  );
}

describe("SessionGoalSchema", () => {
  it("accepts a well-formed session goal", () => {
    const goal = SessionGoalSchema.parse({
      id: "goal-1",
      sessionId: "session-1",
      objective: "Ship the lifecycle.",
      acceptanceCriteria: [{ id: "criterion-1", text: "Tests pass.", accepted: true }],
      status: "active",
      createdAt: NOW,
      updatedAt: NOW
    });

    expect(goal.status).toBe("active");
    expect(goal.acceptanceCriteria[0]?.accepted).toBe(true);
  });

  it("rejects an invalid status", () => {
    const result = SessionGoalSchema.safeParse({
      id: "goal-1",
      sessionId: "session-1",
      objective: "Ship the lifecycle.",
      acceptanceCriteria: [],
      status: "archived",
      createdAt: NOW,
      updatedAt: NOW
    });

    expect(result.success).toBe(false);
  });

  it("rejects empty acceptance criterion text", () => {
    const result = SessionGoalSchema.safeParse({
      id: "goal-1",
      sessionId: "session-1",
      objective: "Ship the lifecycle.",
      acceptanceCriteria: [{ id: "criterion-1", text: "   ", accepted: false }],
      status: "active",
      createdAt: NOW,
      updatedAt: NOW
    });

    expect(result.success).toBe(false);
  });
});

describe("createSessionGoal / proposeSessionGoal", () => {
  it("creates an active goal with proposed (unaccepted) criteria", () => {
    const goal = createProposedGoal();

    expect(goal.status).toBe("active");
    expect(goal.sessionId).toBe("session-1");
    expect(goal.objective).toBe("Ship the session goal lifecycle module.");
    expect(goal.acceptanceCriteria).toHaveLength(2);
    expect(goal.acceptanceCriteria.every((criterion) => criterion.accepted === false)).toBe(true);
    expect(goal.createdAt).toBe(NOW);
    expect(goal.updatedAt).toBe(NOW);
  });

  it("proposeSessionGoal creates a paused goal pending operator review", () => {
    const goal = proposeSessionGoal(
      {
        sessionId: "session-1",
        objective: "Proposed objective.",
        acceptanceCriteria: ["Proposed criterion."]
      },
      { now: () => NOW }
    );

    expect(goal.status).toBe("paused");
    expect(goal.acceptanceCriteria[0]?.accepted).toBe(false);
  });

  it("rejects a second active goal for the same session", () => {
    createProposedGoal();

    expect(() =>
      createSessionGoal(
        {
          sessionId: "session-1",
          objective: "A second goal.",
          acceptanceCriteria: ["Something."]
        },
        { now: () => NOW }
      )
    ).toThrow(/active goal/i);
  });

  it("rejects a proposed goal while another goal is active or paused for the session", () => {
    createProposedGoal();

    expect(() =>
      proposeSessionGoal(
        {
          sessionId: "session-1",
          objective: "Another proposal.",
          acceptanceCriteria: ["Something."]
        },
        { now: () => NOW }
      )
    ).toThrow(/goal/i);
  });

  it("rejects an empty objective and empty criteria list", () => {
    expect(() =>
      createSessionGoal(
        { sessionId: "session-1", objective: "  ", acceptanceCriteria: ["Something."] },
        { now: () => NOW }
      )
    ).toThrow(/objective/i);

    expect(() =>
      createSessionGoal(
        { sessionId: "session-1", objective: "Objective.", acceptanceCriteria: [] },
        { now: () => NOW }
      )
    ).toThrow(/acceptanceCriteria/i);
  });

  it("allows a new goal after the previous goal is cleared", () => {
    const first = createProposedGoal();
    clearSessionGoal("session-1");

    const second = createSessionGoal(
      {
        sessionId: "session-1",
        objective: "Fresh goal.",
        acceptanceCriteria: ["Fresh criterion."]
      },
      { now: () => NOW }
    );

    expect(second.id).not.toBe(first.id);
    expect(getActiveSessionGoal("session-1")?.id).toBe(second.id);
  });
});

describe("acceptSessionGoalCriteria", () => {
  it("marks every proposed criterion as accepted", () => {
    const goal = createProposedGoal();
    const accepted = acceptSessionGoalCriteria("session-1", goal.id, { now: () => LATER });

    expect(accepted.acceptanceCriteria.every((criterion) => criterion.accepted)).toBe(true);
    expect(accepted.updatedAt).toBe(LATER);
  });

  it("rejects accepting criteria for a completed goal", () => {
    const goal = createProposedGoal();
    completeSessionGoal("session-1", goal.id, { now: () => NOW });

    expect(() => acceptSessionGoalCriteria("session-1", goal.id, { now: () => NOW })).toThrow(/completed/i);
  });
});

describe("amendSessionGoal", () => {
  it("amends objective and acceptance criteria on an active goal", () => {
    const goal = createProposedGoal();
    const amended = amendSessionGoal(
      "session-1",
      goal.id,
      {
        objective: "Ship the lifecycle with amendments.",
        acceptanceCriteria: ["Amended criterion."]
      },
      { now: () => LATER }
    );

    expect(amended.objective).toBe("Ship the lifecycle with amendments.");
    expect(amended.acceptanceCriteria).toHaveLength(1);
    expect(amended.acceptanceCriteria[0]?.text).toBe("Amended criterion.");
    expect(amended.acceptanceCriteria[0]?.accepted).toBe(false);
    expect(amended.updatedAt).toBe(LATER);
    expect(amended.createdAt).toBe(goal.createdAt);
  });

  it("resets acceptance on criteria whose text changes", () => {
    const goal = createProposedGoal();
    acceptSessionGoalCriteria("session-1", goal.id, { now: () => NOW });

    const amended = amendSessionGoal(
      "session-1",
      goal.id,
      { acceptanceCriteria: ["Lifecycle transitions covered by tests.", "New second criterion."] },
      { now: () => LATER }
    );

    expect(amended.acceptanceCriteria[0]?.accepted).toBe(true);
    expect(amended.acceptanceCriteria[1]?.accepted).toBe(false);
  });

  it("rejects amending a completed goal", () => {
    const goal = createProposedGoal();
    completeSessionGoal("session-1", goal.id, { now: () => NOW });

    expect(() =>
      amendSessionGoal("session-1", goal.id, { objective: "Nope." }, { now: () => NOW })
    ).toThrow(/completed/i);
  });
});

describe("pause / resume", () => {
  it("pauses an active goal and resumes it", () => {
    const goal = createProposedGoal();
    const paused = pauseSessionGoal("session-1", goal.id, { now: () => LATER });

    expect(paused.status).toBe("paused");
    expect(paused.updatedAt).toBe(LATER);

    const resumed = resumeSessionGoal("session-1", goal.id, { now: () => NOW });
    expect(resumed.status).toBe("active");
  });

  it("rejects pausing a goal that is not active", () => {
    const goal = createProposedGoal();
    pauseSessionGoal("session-1", goal.id, { now: () => NOW });

    expect(() => pauseSessionGoal("session-1", goal.id, { now: () => NOW })).toThrow(/pause/i);
  });

  it("rejects resuming a goal that is not paused", () => {
    const goal = createProposedGoal();

    expect(() => resumeSessionGoal("session-1", goal.id, { now: () => NOW })).toThrow(/resume/i);
  });

  it("rejects pausing a completed goal", () => {
    const goal = createProposedGoal();
    completeSessionGoal("session-1", goal.id, { now: () => NOW });

    expect(() => pauseSessionGoal("session-1", goal.id, { now: () => NOW })).toThrow(/completed|pause/i);
  });
});

describe("completeSessionGoal", () => {
  it("marks an active goal completed", () => {
    const goal = createProposedGoal();
    const completed = completeSessionGoal("session-1", goal.id, { now: () => LATER });

    expect(completed.status).toBe("completed");
    expect(completed.updatedAt).toBe(LATER);
    expect(getActiveSessionGoal("session-1")).toBeUndefined();
  });

  it("allows completing a paused goal", () => {
    const goal = createProposedGoal();
    pauseSessionGoal("session-1", goal.id, { now: () => NOW });
    const completed = completeSessionGoal("session-1", goal.id, { now: () => LATER });

    expect(completed.status).toBe("completed");
  });

  it("rejects completing a goal that is already completed", () => {
    const goal = createProposedGoal();
    completeSessionGoal("session-1", goal.id, { now: () => NOW });

    expect(() => completeSessionGoal("session-1", goal.id, { now: () => NOW })).toThrow(/completed/i);
  });

  it("frees the session for a new goal after completion", () => {
    const goal = createProposedGoal();
    completeSessionGoal("session-1", goal.id, { now: () => NOW });

    const next = createSessionGoal(
      {
        sessionId: "session-1",
        objective: "Next goal.",
        acceptanceCriteria: ["Next criterion."]
      },
      { now: () => LATER }
    );

    expect(next.status).toBe("active");
    expect(getActiveSessionGoal("session-1")?.id).toBe(next.id);
  });
});

describe("blocked status", () => {
  it("completes from a blocked state and blocks an active goal via amend", () => {
    const goal = createProposedGoal();
    const blocked = amendSessionGoal("session-1", goal.id, { status: "blocked" }, { now: () => NOW });

    expect(blocked.status).toBe("blocked");
    expect(getActiveSessionGoal("session-1")).toBeUndefined();

    const completed = completeSessionGoal("session-1", goal.id, { now: () => LATER });
    expect(completed.status).toBe("completed");
  });

  it("rejects amending status directly to completed", () => {
    const goal = createProposedGoal();

    expect(() =>
      amendSessionGoal("session-1", goal.id, { status: "completed" as "active" }, { now: () => NOW })
    ).toThrow(/status/i);
  });
});

describe("clearSessionGoal", () => {
  it("removes all goals for the session", () => {
    createProposedGoal();
    clearSessionGoal("session-1");

    expect(getActiveSessionGoal("session-1")).toBeUndefined();
  });

  it("is a no-op for a session with no goals", () => {
    expect(() => clearSessionGoal("session-missing")).not.toThrow();
  });
});

describe("session and goal identity", () => {
  it("keeps goals isolated across sessions", () => {
    createProposedGoal();
    const other = createSessionGoal(
      {
        sessionId: "session-2",
        objective: "Other session goal.",
        acceptanceCriteria: ["Other criterion."]
      },
      { now: () => NOW }
    );

    expect(getActiveSessionGoal("session-1")).toBeDefined();
    expect(getActiveSessionGoal("session-2")?.id).toBe(other.id);
    expect(() => pauseSessionGoal("session-2", "nonexistent", { now: () => NOW })).toThrow(/goal/i);
  });

  it("returns immutable snapshots that do not leak internal state", () => {
    const goal = createProposedGoal();
    const snapshot = getActiveSessionGoal("session-1");

    expect(snapshot).toBeDefined();
    if (snapshot) {
      (snapshot.acceptanceCriteria as Array<{ id: string; text: string; accepted: boolean }>).push({ id: "x", text: "Injected.", accepted: true });
    }

    expect(getActiveSessionGoal("session-1")?.acceptanceCriteria).toHaveLength(2);
    expect(goal.acceptanceCriteria).toHaveLength(2);
  });
});

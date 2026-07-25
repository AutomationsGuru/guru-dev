export type SessionGoalStatus = "active" | "achieved" | "abandoned";

export interface ActiveSessionGoal {
  readonly goal: string;
  readonly status: "active";
}

export interface AchievedSessionGoal {
  readonly goal: string;
  readonly status: "achieved";
}

export interface AbandonedSessionGoal {
  readonly goal: string;
  readonly status: "abandoned";
  readonly reason: string;
}

export type SessionGoal = ActiveSessionGoal | AchievedSessionGoal | AbandonedSessionGoal;

/** Tracks one operator-directed goal for a session without persistence or background work. */
export class SessionGoalTracker {
  private goal: SessionGoal | null = null;

  get current(): SessionGoal | null {
    return this.goal;
  }

  setGoal(goal: string): ActiveSessionGoal {
    const normalizedGoal = requireText(goal, "Goal");
    if (this.goal?.status === "active") {
      throw new Error("SessionGoalTracker: an active goal already exists.");
    }

    const next: ActiveSessionGoal = { goal: normalizedGoal, status: "active" };
    this.goal = next;
    return next;
  }

  achieve(): AchievedSessionGoal {
    const activeGoal = this.requireActiveGoal();
    const next: AchievedSessionGoal = { goal: activeGoal.goal, status: "achieved" };
    this.goal = next;
    return next;
  }

  abandon(reason: string): AbandonedSessionGoal {
    const activeGoal = this.requireActiveGoal();
    const next: AbandonedSessionGoal = {
      goal: activeGoal.goal,
      status: "abandoned",
      reason: requireText(reason, "Abandonment reason")
    };
    this.goal = next;
    return next;
  }

  private requireActiveGoal(): ActiveSessionGoal {
    if (!this.goal || this.goal.status !== "active") {
      throw new Error("SessionGoalTracker: no active goal exists.");
    }
    return this.goal;
  }
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`SessionGoalTracker: ${label} must be non-empty.`);
  }
  return normalized;
}

import type { Mission, PlanInput, PlanStatus } from "./missionPlan.js";
import { createMissionPlan } from "./missionPlan.js";

// createFromPlan: delegates to plan factory for thin wrapper (matches swarm thin declarative idiom)
export function createFromPlan(input: PlanInput): Mission {
  return createMissionPlan(input);
}

// advance: picks next unblocked; returns action or status string for blocked/paused/done (pure)
export function advance(mission: Mission): { action: string; milestoneId?: string } | PlanStatus {
  if (mission.pausedByOperator) {
    return "paused";
  }
  if (mission.status === "blocked") {
    return "blocked";
  }

  // find first pending milestone (linear or simple blocked check)
  const next = mission.milestones.find((m) => m.status === "pending");
  if (!next) {
    return "done";
  }

  // simple blocked simulation: if any prior not done, but for basic linear ok
  const prevIdx = mission.milestones.findIndex((m) => m.id === next.id) - 1;
  if (prevIdx >= 0 && mission.milestones[prevIdx].status !== "done") {
    return "blocked";
  }

  return { action: "assign", milestoneId: next.id };
}

// pause: pure updater, sets operator pause flag and status
export function pause(mission: Mission): Mission {
  return {
    ...mission,
    pausedByOperator: true,
    status: "paused"
  };
}

// redirect: pure, clears pause, sets note, resets to pending for resume (light re-plan)
export function redirect(mission: Mission, note: string): Mission {
  return {
    ...mission,
    pausedByOperator: false,
    redirectNote: note,
    status: "pending"
  };
}

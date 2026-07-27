import { randomUUID } from "node:crypto";

export type PlanStatus = "pending" | "active" | "done" | "blocked" | "paused";

export interface Feature {
  readonly id: string;
  readonly title: string;
  status: PlanStatus;
}

export interface Milestone {
  readonly id: string;
  readonly title: string;
  status: PlanStatus;
  features: Feature[];
}

export interface Mission {
  readonly id: string;
  readonly title: string;
  status: PlanStatus;
  milestones: Milestone[];
  features: Feature[];
  assignedTo?: string;
  pausedByOperator?: boolean;
  redirectNote?: string;
}

export interface PlanInput {
  readonly title: string;
  readonly milestones: Array<{
    readonly title: string;
    readonly features?: Array<{ readonly title: string }>;
  }>;
}

export function createMissionPlan(input: PlanInput): Mission {
  const milestones: Milestone[] = input.milestones.map((m, idx) => ({
    id: `m-${idx + 1}`,
    title: m.title,
    status: "pending",
    features: (m.features ?? []).map((f, fIdx) => ({
      id: `f-${idx + 1}-${fIdx + 1}`,
      title: f.title,
      status: "pending"
    }))
  }));

  const features: Feature[] = milestones.flatMap((m) => m.features);

  return {
    id: randomUUID(),
    title: input.title,
    status: "pending",
    milestones,
    features,
    pausedByOperator: false
  };
}

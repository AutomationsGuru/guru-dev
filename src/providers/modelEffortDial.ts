export type ModelEffortLevel = "low" | "med" | "high";

export interface ModelEffortCaps {
  readonly maxSteps: number;
  readonly maxTokens: number;
}

const EFFORT_CAPS: Readonly<Record<ModelEffortLevel, ModelEffortCaps>> = {
  low: { maxSteps: 5, maxTokens: 2_048 },
  med: { maxSteps: 10, maxTokens: 4_096 },
  high: { maxSteps: 25, maxTokens: 8_192 }
};

export function resolveEffort(level: ModelEffortLevel): ModelEffortCaps {
  return EFFORT_CAPS[level];
}

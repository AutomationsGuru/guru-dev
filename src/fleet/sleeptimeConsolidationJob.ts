export interface SleeptimeConsolidationJobPayload {
  readonly agentId: string;
}

export interface SleeptimeConsolidationJobSchedule {
  readonly runAt: string;
}

export interface SleeptimeConsolidationJob {
  readonly type: "remember-consolidate";
  readonly payload: SleeptimeConsolidationJobPayload;
  readonly schedule: SleeptimeConsolidationJobSchedule;
}

function normalizeAgentId(agentId: string): string {
  const trimmed = agentId.trim();
  if (trimmed.length === 0) {
    throw new Error("agentId must not be empty.");
  }
  return trimmed;
}

function serializeRunAt(runAt: Date): string {
  if (!(runAt instanceof Date) || Number.isNaN(runAt.getTime())) {
    throw new Error("runAt must be a valid Date.");
  }
  return runAt.toISOString();
}

export function buildJob(agentId: string, runAt: Date): SleeptimeConsolidationJob {
  return {
    type: "remember-consolidate",
    payload: {
      agentId: normalizeAgentId(agentId)
    },
    schedule: {
      runAt: serializeRunAt(runAt)
    }
  };
}

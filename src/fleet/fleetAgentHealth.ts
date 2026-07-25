export type FleetAgentHealthStatus = "healthy" | "errored";

export interface FleetAgentHealthInput {
  readonly sessionId: string;
  readonly status: FleetAgentHealthStatus;
  readonly lastError?: string;
  readonly queueDepth: number;
  readonly updatedAt: string;
}

export interface FleetAgentHealthSnapshot {
  readonly sessionId: string;
  readonly status: FleetAgentHealthStatus;
  readonly lastError?: string;
  readonly queueDepth: number;
  readonly updatedAt: string;
}

/**
 * Produces a serializable health view without reading process state or mutating
 * the supplied agent record. Callers own collection of session state.
 */
export function buildSnapshot(input: FleetAgentHealthInput): FleetAgentHealthSnapshot {
  return {
    sessionId: input.sessionId,
    status: input.status,
    ...(input.lastError === undefined ? {} : { lastError: input.lastError }),
    queueDepth: input.queueDepth,
    updatedAt: input.updatedAt
  };
}

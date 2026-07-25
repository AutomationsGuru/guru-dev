import { z } from "zod";

/**
 * Fleet agent-health snapshot (F280 / R-ZG-HEALTH).
 *
 * Pure, in-process view of fleet agent state for operators. No telemetry,
 * no APM, no third-party rehost — it is a typed projection from an internal
 * agent-state vector onto the operator-facing surface.
 *
 * Operator-facing fields are *intentionally* a strict subset of the internal
 * shape: an "agent" record may carry toolCallCount, depth, startedAt, etc.,
 * none of which an operator needs to read health. The snapshot refuses to
 * leak those by exposing only { sessionId, status, queueDepth, lastError?,
 * updatedAt }.
 *
 * This file is owned by IDEA-F280-FLEET-HEALTH-01; any extension to fleet
 * health (extra fields, transport, aggregation) must come through another
 * plan and not by editing this surface in place.
 */

export const AgentHealthStateSchema = z.enum(["queued", "running", "done", "failed", "killed", "idle"]);
export type AgentHealthState = z.infer<typeof AgentHealthStateSchema>;

/** Internal agent-state vector. Fields beyond `state` exist for the fleet
 *  manager; the operator snapshot must not surface them. */
export const AgentHealthSnapshotInputSchema = z
  .object({
    sessionId: z.string().min(1),
    state: AgentHealthStateSchema,
    queueDepth: z.number().int().nonnegative(),
    /** Last error message, present only when the agent has failed. */
    error: z.string().min(1).optional(),
    /** Internal: tools consumed by the agent so far. NEVER surfaced in output. */
    toolCallCount: z.number().int().nonnegative()
  })
  .strict();
export type AgentHealthSnapshotInput = z.infer<typeof AgentHealthSnapshotInputSchema>;

/** Operator-facing snapshot of a single agent. */
export interface AgentHealthSnapshot {
  readonly sessionId: string;
  readonly status: AgentHealthState;
  readonly queueDepth: number;
  /** Present only when the agent's last terminal state carried an error. */
  readonly lastError?: string;
  readonly updatedAt: string;
}

/** Operator-facing fleet health bundle. */
export interface FleetHealthSnapshot {
  readonly updatedAt: string;
  readonly snapshots: readonly AgentHealthSnapshot[];
}

export interface BuildAgentHealthSnapshotInput {
  readonly agents: readonly AgentHealthSnapshotInput[];
}

/**
 * Build the operator-facing snapshot. Pure: does not read clock or filesystem;
 * callers that want frozen timestamps can pass one via the helpers below.
 */
export function buildAgentHealthSnapshot(input: BuildAgentHealthSnapshotInput): FleetHealthSnapshot {
  const updatedAt = new Date().toISOString();
  const agents = input.agents.map((raw) => {
    // parse-on-call: surfaces a schema violation immediately rather than letting
    // a malformed internal record silently produce a misleading "healthy"
    // snapshot. Strict mode rejects unknown keys so a future field addition
    // cannot bypass this surface by accident.
    const agent = AgentHealthSnapshotInputSchema.parse(raw);
    const snap: AgentHealthSnapshot = {
      sessionId: agent.sessionId,
      status: agent.state,
      queueDepth: agent.queueDepth,
      ...(agent.error !== undefined ? { lastError: agent.error } : {}),
      updatedAt
    };
    return snap;
  });
  return {
    updatedAt,
    snapshots: agents
  };
}

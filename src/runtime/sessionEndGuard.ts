import { z } from "zod";

import type { FleetSnapshot } from "../swarm/fleetSnapshot.js";
import { isActiveWorkerState } from "../swarm/fleetSnapshot.js";

/**
 * Session end guard (IDEA-A4 "no blind end") — a quit/abort with live fleet work still in
 * flight can NEVER silent-succeed. The guard is a pure decision over the current fleet
 * snapshot: any queued/running worker or in-progress self-build task flips the outcome to
 * `needs_confirm`, and the ONLY override is the documented `force` flag on the request
 * itself (the operator has seen what is live and positively decided to end anyway —
 * e.g. a second Ctrl+C inside the arm window). The guard is structural (§3): the quit
 * path must route through it rather than trusting prompt language.
 *
 * What counts as LIVE (blocks a blind end):
 *   - swarm workers in queued/running state — they can still act on the world;
 *   - self-build tasks in_progress — quitting abandons work the loop has started.
 *
 * What is deliberately NOT live (visibility only, never friction):
 *   - ready/blocked self-build tasks — the board always carries a ready backlog and a
 *     blocked task is settled until the operator re-runs the loop;
 *   - open packets — durable on-disk coordination files; nothing is lost by exiting.
 *
 * The DRAIN path is honest by construction: drain the fleet (e.g. SwarmManager.drain()),
 * rebuild the snapshot, re-evaluate — the guard then allows with `no-active-fleet-work`.
 * There is intentionally NO "drained" attestation parameter: an attestation that
 * contradicts the observed snapshot would re-open the blind end this guard exists to close.
 *
 * The guard itself is read-only — it decides, it never kills, drains, or mutates workers.
 */

export const SessionEndGuardReasonSchema = z.enum(["no-active-fleet-work", "forced", "active-workers", "self-build-in-progress"]);
export type SessionEndGuardReason = z.infer<typeof SessionEndGuardReasonSchema>;

export const SessionEndGuardRequestSchema = z
  .object({
    /**
     * Operator FORCES the end despite live fleet work. This is the documented explicit
     * override — the caller must surface the blockers first and the operator must
     * positively opt in. Force never drains or kills anything; it only records that the
     * end was taken with the live fleet in view, not blind.
     */
    force: z.boolean().default(false)
  })
  .strict();
export type SessionEndGuardRequest = z.input<typeof SessionEndGuardRequestSchema>;

export const SessionEndGuardDecisionSchema = z
  .object({
    outcome: z.enum(["allow", "needs_confirm"]),
    reasons: z.array(SessionEndGuardReasonSchema),
    /** Human-legible lines naming exactly what is live — never empty on needs_confirm. */
    blockers: z.array(z.string()),
    /** Informational lines (open packets) that never affect the outcome. */
    advisories: z.array(z.string()),
    /** Counts echoed from the snapshot so callers can render without re-deriving them. */
    activeWorkers: z.number().int().nonnegative(),
    inProgressSelfBuild: z.number().int().nonnegative(),
    openPackets: z.number().int().nonnegative()
  })
  .strict();
export type SessionEndGuardDecision = z.infer<typeof SessionEndGuardDecisionSchema>;

/** Self-build statuses that represent work the running loop has actually started. */
export const LIVE_SELF_BUILD_STATUSES = ["in_progress"] as const;

export function isLiveSelfBuildStatus(status: string): boolean {
  return (LIVE_SELF_BUILD_STATUSES as readonly string[]).includes(status);
}

export function evaluateSessionEndGuard(snapshot: FleetSnapshot, rawRequest: SessionEndGuardRequest = {}): SessionEndGuardDecision {
  const request = SessionEndGuardRequestSchema.parse(rawRequest);
  const activeWorkers = snapshot.workers.filter((worker) => isActiveWorkerState(worker.state));
  const liveSelfBuild = snapshot.selfBuild.filter((task) => isLiveSelfBuildStatus(task.status));
  const openPackets = snapshot.openPackets;

  const reasons: SessionEndGuardReason[] = [];
  const blockers: string[] = [];
  const advisories: string[] = [];

  if (activeWorkers.length > 0) {
    reasons.push("active-workers");
    blockers.push(
      `${activeWorkers.length} swarm worker(s) still ${formatStates(activeWorkers.map((worker) => worker.state))}: ${activeWorkers
        .map((worker) => `${worker.taskId} (${worker.label})`)
        .join(", ")}.`
    );
  }
  if (liveSelfBuild.length > 0) {
    reasons.push("self-build-in-progress");
    blockers.push(
      `${liveSelfBuild.length} self-build task(s) in progress: ${liveSelfBuild.map((task) => `${task.taskId} [${task.status}]`).join(", ")}.`
    );
  }
  if (openPackets.length > 0) {
    advisories.push(`${openPackets.length} open packet(s) on disk (durable — not blocking): ${openPackets.map((packet) => packet.name).join(", ")}.`);
  }

  const hasLiveWork = activeWorkers.length > 0 || liveSelfBuild.length > 0;

  if (!hasLiveWork) {
    return SessionEndGuardDecisionSchema.parse({
      outcome: "allow",
      reasons: ["no-active-fleet-work"],
      blockers: [],
      advisories,
      activeWorkers: 0,
      inProgressSelfBuild: 0,
      openPackets: openPackets.length
    });
  }

  if (request.force) {
    reasons.push("forced");
    return SessionEndGuardDecisionSchema.parse({
      outcome: "allow",
      reasons,
      blockers,
      advisories,
      activeWorkers: activeWorkers.length,
      inProgressSelfBuild: liveSelfBuild.length,
      openPackets: openPackets.length
    });
  }

  return SessionEndGuardDecisionSchema.parse({
    outcome: "needs_confirm",
    reasons,
    blockers,
    advisories,
    activeWorkers: activeWorkers.length,
    inProgressSelfBuild: liveSelfBuild.length,
    openPackets: openPackets.length
  });
}

function formatStates(states: readonly string[]): string {
  return [...new Set(states)].join("/");
}

/** Convenience: true only on an explicit allow — never treat needs_confirm as OK. */
export function isSessionEndAllowed(decision: SessionEndGuardDecision): boolean {
  return decision.outcome === "allow";
}

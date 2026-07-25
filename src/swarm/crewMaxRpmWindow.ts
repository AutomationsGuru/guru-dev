/**
 * Crew max RPM window — a PURE sliding-window counter that enforces a maximum
 * number of requests per minute per agent.
 *
 * Contract / invariants:
 * - The window is PER AGENT, keyed by agentId; agents never share budget.
 * - The sliding window is [nowMs - 60_000, nowMs], INCLUSIVE of both endpoints:
 *   a request exactly 60_000 ms old still counts against the cap.
 * - tryConsume returns true and records the request when the agent has made
 *   FEWER than maxRpm requests in the current window; it returns false and
 *   records NOTHING when the agent is already at/over cap.
 * - maxRpm is a per-call parameter: the cap may change between calls and is
 *   always evaluated against the live window contents.
 * - Non-positive maxRpm always rejects (and never records).
 * - Entries older than the window are pruned on every call, so memory stays
 *   bounded by the number of requests inside the last 60 seconds per agent.
 * - Deterministic and pure: no wall-clock reads (nowMs is supplied by the
 *   caller), no I/O, no dependencies. Callers pass a monotonically
 *   non-decreasing nowMs; a backwards nowMs simply sees its own (smaller)
 *   window without corrupting stored history.
 */

/** Length of the sliding window in milliseconds. */
const WINDOW_MS = 60_000;

export interface CrewMaxRpmWindow {
  /**
   * Attempt to consume one unit of the agent's per-minute budget.
   *
   * @param agentId stable identifier of the requesting agent.
   * @param nowMs   caller-supplied current time in milliseconds.
   * @param maxRpm  maximum requests allowed inside [nowMs - 60_000, nowMs]
   *                (inclusive); values <= 0 always reject.
   * @returns true when the request is under the cap (and is recorded);
   *          false when the agent is at/over cap (nothing is recorded).
   */
  tryConsume(agentId: string, nowMs: number, maxRpm: number): boolean;
}

/**
 * Create a fresh, empty crew max-RPM window. Each instance owns its own
 * isolated state.
 */
export function createCrewMaxRpmWindow(): CrewMaxRpmWindow {
  // Per-agent timestamps (ms) of recorded requests, oldest first. Timestamps
  // arrive in non-decreasing order per agent under the monotonic-nowMs
  // contract, so a plain array with front pruning is sufficient.
  const requestsByAgent = new Map<string, number[]>();

  return {
    tryConsume(agentId, nowMs, maxRpm) {
      if (maxRpm <= 0) {
        return false;
      }
      let requests = requestsByAgent.get(agentId);
      if (requests === undefined) {
        requests = [];
        requestsByAgent.set(agentId, requests);
      }
      // Prune everything strictly older than nowMs - 60_000; the lower bound
      // is INCLUSIVE, so a timestamp exactly 60_000 ms old still counts.
      const cutoff = nowMs - WINDOW_MS;
      let firstLive = 0;
      while (firstLive < requests.length) {
        const oldest = requests[firstLive];
        if (oldest === undefined || oldest >= cutoff) {
          break;
        }
        firstLive += 1;
      }
      if (firstLive > 0) {
        requests.splice(0, firstLive);
      }
      if (requests.length >= maxRpm) {
        return false;
      }
      requests.push(nowMs);
      return true;
    }
  };
}

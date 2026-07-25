import type { AgentSession } from "../session/agentSession.js";
import type { ProviderRouteDescriptor } from "../providers/schemas.js";

/**
 * Mid-session model switch: preserves the conversation transcript and freezes
 * per-model usage deltas so accounting stays accurate across switches. Returns
 * the prior model id, its frozen usage bucket, and the new baseline for the
 * next switch.
 *
 * P1 daily-driver reliability — R-CR-SWITCH residual. A model switch mid-session
 * must never drop history, and usage must be keyed by model so the operator can
 * see what each model consumed.
 *
 * The caller owns a `baseline` snapshot: the session stats at the moment the
 * CURRENT model was activated (or {0,0,0} for a fresh session). `switchModel`
 * computes the outgoing model's delta as `currentStats - baseline`, swaps the
 * route, and returns the NEW baseline (stats right after the switch) for the
 * next call. This is correct even when `AgentSession.stats()` returns cumulative
 * session-wide totals — the delta isolates what the outgoing model actually
 * consumed.
 */

/** A point-in-time usage snapshot frozen at the moment of a model switch. */
export interface ModelUsageBucket {
  readonly modelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly turns: number;
}

/** Accumulated per-model usage across one or more switches. */
export interface ModelUsageMap {
  readonly [modelId: string]: ModelUsageBucket;
}

/** A snapshot of cumulative session stats used as a baseline for delta computation. */
export interface SessionStatsBaseline {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly turns: number;
}

/** The zero baseline — use for a fresh session with no prior usage. */
export const ZERO_BASELINE: SessionStatsBaseline = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  turns: 0,
});

/** Result of switching the active model mid-session. */
export interface ModelSwitchResult {
  /** The model id that was active before the switch. */
  readonly previousModelId: string;
  /** Usage frozen at switch time for the outgoing model (delta since it was activated). */
  readonly frozenUsage: ModelUsageBucket;
  /** The model id now active. */
  readonly currentModelId: string;
}

/**
 * Switch the session's active model, preserving the full conversation transcript
 * and freezing the outgoing model's per-model usage delta.
 *
 * The session's history (messages) is never touched — it continues seamlessly.
 * Only the route/model changes and per-model usage is snapshotted via delta.
 *
 * @param session     The active agent session.
 * @param newRoute    The route descriptor for the model to switch to.
 * @param baseline    The session stats snapshot taken when the CURRENT model was
 *                    activated. Use {@link ZERO_BASELINE} for the first switch
 *                    from a fresh session.
 * @returns The switch result and a new baseline for the next switch call.
 */
export function switchModel(
  session: AgentSession,
  newRoute: ProviderRouteDescriptor,
  baseline: SessionStatsBaseline,
): { result: ModelSwitchResult; newBaseline: SessionStatsBaseline } {
  const stats = session.stats();
  const previousModelId = session.activeRoute.modelId;
  const currentModelId = newRoute.modelId;

  // Per-model delta = cumulative now minus cumulative when this model started.
  const frozenUsage: ModelUsageBucket = {
    modelId: previousModelId,
    inputTokens: stats.inputTokens - baseline.inputTokens,
    outputTokens: stats.outputTokens - baseline.outputTokens,
    turns: stats.turns - baseline.turns,
  };

  session.switchRoute(newRoute);

  // Snap the new baseline right after the switch — the next model's delta
  // will be computed from this point.  switchRoute does not mutate usage, so
  // stats are unchanged from the snapshot above.
  const newBaseline: SessionStatsBaseline = {
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    turns: stats.turns,
  };

  return {
    result: { previousModelId, frozenUsage, currentModelId },
    newBaseline,
  };
}

/**
 * Snapshot the current cumulative session stats as a baseline.
 * Convenience — callers can also construct a baseline manually from {@link AgentSession.stats}.
 */
export function snapshotBaseline(session: AgentSession): SessionStatsBaseline {
  const stats = session.stats();
  return {
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    turns: stats.turns,
  };
}

/**
 * Accumulate usage buckets from prior switches together with the current
 * session's live usage into a single per-model map.
 *
 * Prior buckets are per-model deltas (already correct). The current model's
 * contribution is computed as `currentStats - baseline` so it only counts
 * usage since the last switch.
 *
 * If a prior bucket and the current model share the same model id (switch-back),
 * their values are summed.
 *
 * @param prior      Frozen per-model buckets from prior switchModel calls.
 * @param session    The live session.
 * @param baseline   The baseline returned by the most recent switchModel call,
 *                   or {@link ZERO_BASELINE} before the first switch.
 */
export function accumulateUsageMap(
  prior: readonly ModelUsageBucket[],
  session: AgentSession,
  baseline: SessionStatsBaseline,
): ModelUsageMap {
  const stats = session.stats();
  const currentModelId = session.activeRoute.modelId;

  const map: Record<string, ModelUsageBucket> = {};

  // Seed with prior per-model deltas (already correct).
  for (const bucket of prior) {
    map[bucket.modelId] = bucket;
  }

  // Current model delta since the last switch (or session start).
  const currentDelta: ModelUsageBucket = {
    modelId: currentModelId,
    inputTokens: stats.inputTokens - baseline.inputTokens,
    outputTokens: stats.outputTokens - baseline.outputTokens,
    turns: stats.turns - baseline.turns,
  };

  // Merge: if we switched back to a model, add to its prior total.
  const existing = map[currentModelId];
  map[currentModelId] = {
    modelId: currentModelId,
    inputTokens: (existing?.inputTokens ?? 0) + currentDelta.inputTokens,
    outputTokens: (existing?.outputTokens ?? 0) + currentDelta.outputTokens,
    turns: (existing?.turns ?? 0) + currentDelta.turns,
  };

  return map;
}

/**
 * Total tokens consumed across all models in a usage map.
 * Convenience for display / budget enforcement.
 */
export function totalTokens(map: ModelUsageMap): {
  inputTokens: number;
  outputTokens: number;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const bucket of Object.values(map)) {
    inputTokens += bucket.inputTokens;
    outputTokens += bucket.outputTokens;
  }
  return { inputTokens, outputTokens };
}

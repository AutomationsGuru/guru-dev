import {
  createEmptyLhtState,
  refreshLhtMetrics,
  type LhtGate,
  type LhtState,
  type LhtVisibility
} from "./schemas.js";

/**
 * LHT Engine — pure state transitions for Long Horizon Tracker.
 *
 * All mutations are explicit and return new state objects (or mutate + return
 * for ergonomic use in ritual hooks). Callers own persistence.
 */

/** Initialize LHT tracking for a long-horizon task. */
export function initLhtTracking(params: {
  taskId?: string;
  objective?: string;
  gates?: readonly LhtGate[];
  visibility?: LhtVisibility;
}): LhtState {
  const now = new Date().toISOString();
  const gates = params.gates ? [...params.gates] : [];
  const state: LhtState = {
    enabled: true,
    taskId: params.taskId,
    objective: params.objective,
    gates,
    activeGateIndex: gates.length > 0 ? 0 : -1,
    startedAt: now,
    updatedAt: now,
    visibility: params.visibility ?? "auto",
    metrics: { totalGates: 0, completedGates: 0, skippedGates: 0, completionPct: 0 }
  };

  // Mark first gate active if present
  if (state.activeGateIndex >= 0 && state.gates[0]) {
    state.gates[0] = {
      ...state.gates[0],
      status: "active",
      startedAt: now
    };
  }

  return refreshLhtMetrics(state);
}

/** Advance to the next gate (complete current, activate next). */
export function advanceLhtGate(state: LhtState, options?: { skip?: boolean; notes?: string }): LhtState {
  if (!state.enabled || state.activeGateIndex < 0) {
    return state;
  }

  const now = new Date().toISOString();
  const current = state.gates[state.activeGateIndex];
  if (!current) {
    return state;
  }

  // Complete or skip current gate
  state.gates[state.activeGateIndex] = {
    ...current,
    status: options?.skip ? "skipped" : "complete",
    completedAt: now,
    ...(options?.notes ? { notes: options.notes } : {})
  };

  // Activate next gate if available
  const nextIndex = state.activeGateIndex + 1;
  if (nextIndex < state.gates.length) {
    const nextGate = state.gates[nextIndex];
    state.gates[nextIndex] = {
      ...nextGate,
      status: "active",
      startedAt: now
    };
    state.activeGateIndex = nextIndex;
  } else {
    // All gates complete
    state.activeGateIndex = -1;
  }

  return refreshLhtMetrics(state);
}

/** Update visibility preference. */
export function setLhtVisibility(state: LhtState, visibility: LhtVisibility): LhtState {
  state.visibility = visibility;
  state.updatedAt = new Date().toISOString();
  return state;
}

/** Disable LHT tracking (cleanup on task end or non-long-horizon switch). */
export function disableLhtTracking(state: LhtState): LhtState {
  state.enabled = false;
  state.activeGateIndex = -1;
  state.updatedAt = new Date().toISOString();
  return state;
}

/** Restore LHT state from a compaction snapshot. */
export function restoreLhtFromSnapshot(snapshot: {
  state: LhtState | null;
  compactionCount?: number;
}): LhtState | null {
  if (!snapshot.state) {
    return null;
  }

  // Recompute metrics on restore to ensure consistency
  const restored = { ...snapshot.state };
  restored.metrics = refreshLhtMetrics(restored).metrics;
  restored.updatedAt = new Date().toISOString();

  return restored;
}

/** Serialize LHT state for compaction persistence. */
export function snapshotLhtState(state: LhtState | null): {
  state: LhtState | null;
  compactionCount: number;
} {
  return {
    state: state ? { ...state } : null,
    compactionCount: 0 // Caller increments on each fold
  };
}

/** Advance a specific gate to complete status. */
export function advanceLhtGate(state: LhtState, gateId: string): LhtState {
  const gateIndex = state.gates.findIndex((g) => g.id === gateId);
  if (gateIndex === -1) return state;

  const now = new Date().toISOString();
  const updatedGates = [...state.gates];
  updatedGates[gateIndex] = {
    ...updatedGates[gateIndex],
    status: "complete",
    completedAt: now
  } as LhtGate;

  // Activate next pending gate if exists
  const nextPending = updatedGates.findIndex((g, i) => i > gateIndex && g.status === "pending");
  if (nextPending !== -1) {
    updatedGates[nextPending] = { ...updatedGates[nextPending], status: "active" } as LhtGate;
  }

  return {
    ...state,
    gates: updatedGates,
    metrics: computeMetrics(updatedGates),
    lastUpdatedAt: now
  };
}

/** Refresh metrics from current gate states. */
export function refreshLhtMetrics(state: LhtState): LhtState {
  return {
    ...state,
    metrics: computeMetrics(state.gates),
    lastUpdatedAt: new Date().toISOString()
  };
}

/** Determine if LHT panel should be shown based on visibility and state. */
export function shouldShowLhtPanel(state: LhtState | null): boolean {
  if (!state || !state.enabled) return false;
  if (state.visibility === "never") return false;
  if (state.visibility === "always") return true;
  // "auto": show when there are active or pending gates
  return state.gates.some((g) => g.status === "active" || g.status === "pending");
}

/** Check if LHT panel should be visible given current state and preference. */
export function shouldShowLhtPanel(state: LhtState | null): boolean {
  if (!state || !state.enabled) {
    return false;
  }

  if (state.visibility === "never") {
    return false;
  }

  if (state.visibility === "always") {
    return true;
  }

  // "auto": show when active gates remain or task is in progress
  return state.activeGateIndex >= 0 || state.metrics.completionPct < 100;
}

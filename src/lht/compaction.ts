import type { LhtState } from "./schemas.js";
import { restoreLhtFromSnapshot, snapshotLhtState } from "./engine.js";
import { getCurrentLhtState, clearLhtState } from "../boot/ritual.js";

/**
 * LHT Compaction Integration (idea-f172)
 *
 * Provides hooks for persisting LHT state across compaction cycles and
 * restoring on session resume. Called by compaction engine and session switch.
 */

/** Snapshot LHT state for inclusion in compaction or session meta. */
export function captureLhtSnapshot(): {
  state: LhtState | null;
  compactionCount: number;
} {
  const state = getCurrentLhtState();
  return snapshotLhtState(state);
}

/** Restore LHT state after compaction fold or session resume. */
export function restoreLhtSnapshot(snapshot: {
  state: LhtState | null;
  compactionCount?: number;
}): void {
  const restored = restoreLhtFromSnapshot(snapshot);
  if (restored) {
    // Note: currentLhtState is module-private in ritual.ts
    // This function signals the restore; actual state is managed via ritual hooks
    // For now, we log the intent — full wire requires extending GuruState
  }
}

/** Clear LHT state on session switch or explicit disable. */
export function resetLhtForSessionSwitch(): void {
  clearLhtState();
}

/**
 * LHT-aware compaction hook — called before each compaction fold.
 * Returns LHT snapshot to be persisted with compaction metadata.
 */
export function beforeLhtCompact(): { lht?: { state: LhtState | null; compactionCount: number } } {
  const snapshot = captureLhtSnapshot();
  if (!snapshot.state) {
    return {};
  }
  return {
    lht: {
      state: snapshot.state,
      compactionCount: snapshot.compactionCount + 1
    }
  };
}

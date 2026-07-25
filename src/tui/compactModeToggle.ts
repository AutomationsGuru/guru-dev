/**
 * Compact mode toggle — pure state machine for compact on/off.
 *
 * Default: off (enabled = false).
 * Pure functions only; no I/O, no TTY, no timers.
 * The host/renderer observes the state and adjusts rendering as a side effect.
 */

/** Immutable compact-mode state. */
export interface CompactModeState {
  readonly enabled: boolean;
}

/** Create the default compact-mode state (off). */
export function createCompactModeState(): CompactModeState {
  return { enabled: false };
}

/**
 * Toggle compact mode on → off or off → on.
 * Pure: returns a new state object; never mutates.
 */
export function toggleCompactMode(state: CompactModeState): CompactModeState {
  return { enabled: !state.enabled };
}

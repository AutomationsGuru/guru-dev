/**
 * Observability skill inject (IDEA-F509-OBS-01 / R-GAC-OBS).
 *
 * Pure helper that returns the trace/log hooks list to inject when the
 * observability profile is on. When off (or any non-on value), returns empty.
 * No I/O, no mutation, no core edits — skill/session-layer only.
 */

/** Observability profile: off = no hooks, on = enable trace/log hooks. */
export type ObservabilityProfile = "off" | "on";

/** Fixed hook ids injected when observability is enabled. */
export type ObservabilityHookId = "obs.trace" | "obs.log";

/** Stable hook list for the "on" profile (trace then log). */
const ON_HOOKS: readonly ObservabilityHookId[] = ["obs.trace", "obs.log"];

const EMPTY: readonly ObservabilityHookId[] = [];

/**
 * Returns the observability (trace/log) hooks to inject for `profile`.
 *
 * - `"off"` → empty list
 * - `"on"`  → fixed `["obs.trace", "obs.log"]`
 * - any other runtime value → empty (fail closed)
 *
 * Pure: no I/O, no mutation of inputs.
 */
export function hooksFor(profile: ObservabilityProfile): readonly ObservabilityHookId[] {
  if (profile === "on") {
    return ON_HOOKS;
  }
  return EMPTY;
}

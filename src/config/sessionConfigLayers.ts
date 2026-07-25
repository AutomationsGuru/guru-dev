import type { HarnessConfig } from "./schema.js";

/**
 * Resolve the effective runtime config by layering session-only overrides
 * on top of the persistent global config.
 *
 * Session-only keys never write through to the persistent store (caller
 * responsibility when persisting). The resolver itself is pure and never
 * mutates its inputs.
 */
export function resolveSessionConfigLayers(
  globalConfig: HarnessConfig,
  sessionOverrides: Partial<HarnessConfig> = {}
): HarnessConfig {
  // Fast path: no overrides → return the original reference (no copy cost)
  if (!sessionOverrides || Object.keys(sessionOverrides).length === 0) {
    return globalConfig;
  }

  // Never mutate caller-provided globalConfig. Shallow merge is sufficient
  // for the current flat top-level keys in HarnessConfig; nested overrides
  // would be deep-merged in a later iteration if schema evolves.
  return {
    ...globalConfig,
    ...sessionOverrides
  };
}

/**
 * Explicit clear for session layer (used by reload / new-session flows).
 * This pure resolver keeps no internal state; clearing is achieved by
 * passing an empty override set on the next resolve call.
 */
export function clearSessionLayer(): void {
  // Intentionally stateless — lifetime of the override object is owned
  // by the session coordinator (e.g. agentSession).
}
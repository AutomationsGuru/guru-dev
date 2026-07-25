export interface ClientToolGateConfig {
  /** Client/remote tools remain disabled unless the operator opts in. */
  readonly enabled?: boolean;
  /** Exact client tool ids that may be exposed when the gate is enabled. */
  readonly allowedTools?: readonly string[];
}

/**
 * Keep client-side and remote tool registries fail-closed.
 *
 * This pure gate is intentionally separate from registry construction and
 * mandate evaluation: a caller may only narrow the set before those canonical
 * execution paths, never grant authority or bypass their hard edges.
 */
export function isClientToolAllowed(
  config: ClientToolGateConfig | null | undefined,
  toolId: string
): boolean {
  if (config?.enabled !== true || typeof toolId !== "string" || toolId.trim().length === 0) {
    return false;
  }

  return (config.allowedTools ?? []).some((allowedToolId) => allowedToolId === toolId);
}

/**
 * Protocols that can carry a logical model route's request.
 *
 * The protocol is deliberately separate from the provider and model ids: one
 * logical route may expose more than one wire shape without rebuilding the
 * operator's session.
 */
export type Protocol = "openai-compat" | "anthropic" | "gemini-shape";

export const PROTOCOLS: readonly Protocol[] = ["openai-compat", "anthropic", "gemini-shape"];

export interface ModelRoute {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly protocol: Protocol;
}

/** Minimal adapter seam for a protocol-specific request implementation. */
export interface ProtocolAdapter {
  readonly protocol: Protocol;
  readonly name?: string;
  readonly supports?: readonly Protocol[];
}

export interface SwitchDeps {
  readonly getRoute: (routeId: string) => ModelRoute | undefined;
  readonly getSupportedProtocols: (provider: string) => readonly Protocol[];
  /** Apply the validated protocol to the live route registry, when available. */
  readonly setRouteProtocol?: (routeId: string, protocol: Protocol) => void;
  /** F70 transcript identity; the switch must not allocate a new session. */
  readonly sessionId?: string;
  /** Backwards-compatible name used by the first F70 composition. */
  readonly preserveSessionId?: string;
  readonly now?: () => Date;
}

export interface SwitchReceipt {
  readonly success: boolean;
  readonly routeId: string;
  readonly fromProtocol: Protocol;
  readonly toProtocol: Protocol;
  /** Canonical protocol id recorded on every receipt. */
  readonly protocol: Protocol;
  readonly timestamp: string;
  readonly sessionId?: string;
  readonly error?: string;
}

function sessionIdOf(deps: SwitchDeps): string | undefined {
  return deps.sessionId ?? deps.preserveSessionId;
}

function receipt(
  routeId: string,
  fromProtocol: Protocol,
  toProtocol: Protocol,
  deps: SwitchDeps,
  result: Pick<SwitchReceipt, "success" | "error">,
): SwitchReceipt {
  const sessionId = sessionIdOf(deps);
  return {
    ...result,
    routeId,
    fromProtocol,
    toProtocol,
    protocol: toProtocol,
    timestamp: (deps.now ?? (() => new Date()))().toISOString(),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

export function isProtocol(value: string): value is Protocol {
  return (PROTOCOLS as readonly string[]).includes(value);
}

/**
 * Validate and apply a protocol change for one logical route.
 *
 * The operation is intentionally injected through `SwitchDeps`: the routing
 * registry owns route state, while this seam owns protocol validation and the
 * auditable receipt. Validation happens before the optional mutation callback,
 * so an unsupported switch cannot partially update a route. Transcript state
 * is not copied or replaced; the existing session id is carried in the receipt.
 */
export function switchProtocol(
  routeId: string,
  targetProtocol: Protocol,
  deps: SwitchDeps,
): SwitchReceipt {
  const route = deps.getRoute(routeId);
  const sessionId = sessionIdOf(deps);

  if (!route) {
    return receipt(routeId, targetProtocol, targetProtocol, deps, {
      success: false,
      error: `Route not found: ${routeId}`,
    });
  }

  if (!isProtocol(targetProtocol)) {
    return receipt(routeId, route.protocol, targetProtocol, deps, {
      success: false,
      error: `Unknown protocol: ${String(targetProtocol)}`,
    });
  }

  const supported = deps.getSupportedProtocols(route.provider);
  if (!supported.includes(targetProtocol)) {
    return receipt(routeId, route.protocol, targetProtocol, deps, {
      success: false,
      error: `Protocol ${targetProtocol} not supported for provider ${route.provider}`,
    });
  }

  try {
    deps.setRouteProtocol?.(routeId, targetProtocol);
  } catch (error) {
    return receipt(routeId, route.protocol, targetProtocol, deps, {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return receipt(routeId, route.protocol, targetProtocol, deps, { success: true });
}

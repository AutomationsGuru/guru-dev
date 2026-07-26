import type { Protocol, ModelRoute } from './types';

/**
 * Receipt returned by switchProtocol indicating outcome and context.
 * Captures the switch decision for auditability and session continuity (F70).
 */
export interface SwitchReceipt {
  readonly success: boolean;
  readonly routeId: string;
  readonly fromProtocol: Protocol;
  readonly toProtocol: Protocol;
  readonly error?: string;
  readonly timestamp: string;
  readonly sessionId?: string;
}

/**
 * Dependencies required to perform a protocol switch.
 * Injected to keep the function pure and testable.
 */
export interface SwitchDeps {
  getRoute: (id: string) => ModelRoute | undefined;
  getSupportedProtocols: (provider: string) => Protocol[];
  preserveSessionId?: string;
}

/**
 * Switch a model route to a different protocol for the same logical route.
 *
 * Validates:
 * - Route exists
 * - Target protocol is supported by the provider
 *
 * Preserves sessionId (F70 transcript continuity) when provided.
 *
 * Returns a receipt for audit / downstream session continuity.
 * Never throws; all outcomes are represented in the receipt.
 */
export function switchProtocol(
  routeId: string,
  targetProtocol: Protocol,
  deps: SwitchDeps
): SwitchReceipt {
  const timestamp = new Date().toISOString();
  const route = deps.getRoute(routeId);

  if (!route) {
    return {
      success: false,
      routeId,
      fromProtocol: targetProtocol,
      toProtocol: targetProtocol,
      error: `Route not found: ${routeId}`,
      timestamp,
      sessionId: deps.preserveSessionId,
    };
  }

  const supported = deps.getSupportedProtocols(route.provider);
  const isSupported = supported.includes(targetProtocol);

  if (!isSupported) {
    return {
      success: false,
      routeId,
      fromProtocol: route.protocol,
      toProtocol: targetProtocol,
      error: `Protocol ${targetProtocol} not supported for provider ${route.provider}`,
      timestamp,
      sessionId: deps.preserveSessionId,
    };
  }

  // Success path: protocol is supported and route exists.
  // In a fuller impl this would mutate route state / registry; here we return receipt only.
  return {
    success: true,
    routeId,
    fromProtocol: route.protocol,
    toProtocol: targetProtocol,
    timestamp,
    sessionId: deps.preserveSessionId,
  };
}

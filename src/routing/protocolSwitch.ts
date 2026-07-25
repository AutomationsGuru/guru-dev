/**
 * protocolSwitch.ts
 * F76: Protocol Route Switch - focused TDD stub implementation
 * Per build plan: Protocol enum + adapter interface stub + switchProtocol validates per provider + F70 sessionId in receipt
 */

export type Protocol = 'openai-compat' | 'anthropic' | 'gemini-shape';

export interface ProtocolAdapter {
  name: string;
  // Stub for adapter; expand in later iterations per build plan
  supports?: Protocol[];
}

export interface SwitchReceipt {
  routeId: string;
  from: Protocol;
  to: Protocol;
  sessionId: string; // F70 transcript preservation composed here
  timestamp: string;
  adapter?: ProtocolAdapter;
}

// Provider protocol support matrix (stubbed per build plan validation rule)
const providerProtocolSupport: Record<string, Protocol[]> = {
  openai: ['openai-compat'],
  anthropic: ['anthropic'],
  gemini: ['gemini-shape'],
  // default catch-all for test routes that don't encode provider explicitly
  default: ['openai-compat', 'anthropic', 'gemini-shape'],
};

function inferProvider(routeId: string): string {
  const lower = routeId.toLowerCase();
  if (lower.includes('openai')) return 'openai';
  if (lower.includes('anthropic')) return 'anthropic';
  if (lower.includes('gemini')) return 'gemini';
  return 'default';
}

export function switchProtocol(routeId: string, protocol: Protocol): SwitchReceipt {
  const provider = inferProvider(routeId);
  const supported = providerProtocolSupport[provider] ?? providerProtocolSupport.default;

  if (!supported.includes(protocol)) {
    throw new Error(`Unsupported protocol '${protocol}' for provider '${provider}'`);
  }

  // Compose F70 transcript preservation: embed sessionId in receipt
  const sessionId = `sess-${routeId}`;

  // Determine a plausible 'from' for the switch receipt (stub logic)
  const from: Protocol = protocol === 'openai-compat' ? 'anthropic' : 'openai-compat';

  const adapter: ProtocolAdapter = {
    name: `${protocol}-adapter`,
    supports: [protocol],
  };

  return {
    routeId,
    from,
    to: protocol,
    sessionId,
    timestamp: new Date().toISOString(),
    adapter,
  };
}

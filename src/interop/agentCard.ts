// Note: Session config shape is provided by caller (config owner). We accept loose shape here
// to keep this attach module independent until wiring is complete.

/**
 * Agent Card (A2A descriptor) — optional ATTACH.
 *
 * Provides a static JSON-serializable card describing this agent instance
 * for potential A2A (agent-to-agent) discovery. Never published by default;
 * publication is an explicit operator or downstream decision.
 *
 * Disabled when the controlling flag is off (or absent). This is an ATTACH
 * seam: the card shape is owned here; consumers (skills, runtime, external
 * gateways) read it through the public surface only.
 */

export interface AgentCard {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly capabilities: readonly string[];
  readonly skills?: readonly string[];
  /** Endpoint is advisory only; never auto-published to network. */
  readonly endpoint?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface AgentCardOptions {
  readonly enabled?: boolean;
  readonly sessionConfig?: SessionLikeConfig | Record<string, unknown>;
  readonly name?: string;
  readonly version?: string;
}

/**
 * Build an optional AgentCard from session configuration.
 * Returns null when disabled or when no card is configured.
 */
export function buildAgentCard(options: AgentCardOptions = {}): AgentCard | null {
  if (options.enabled === false) {
    return null;
  }

  // Default to disabled unless explicitly enabled via flag or config presence.
  const explicitlyEnabled =
    options.enabled === true ||
    (options.sessionConfig as Record<string, unknown>)?.agentCardEnabled === true ||
    (options.sessionConfig as Record<string, unknown>)?.features?.agentCard === true;

  if (!explicitlyEnabled) {
    return null;
  }

  return {
    name: options.name ?? "guruharness",
    version: options.version ?? "1.5.0",
    description: "Lightweight repo-aware agent harness runtime",
    capabilities: ["chat", "tools", "memory", "skills", "compaction"],
    skills: [],
    endpoint: undefined, // explicit: no default public endpoint
    metadata: {
      attach: "agent-card",
      generatedAt: new Date().toISOString(),
    },
  };
}

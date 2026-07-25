/**
 * Deep-agent compatibility facade (IDEA-F231-DEEP-FACADE-01).
 *
 * A thin, pure options-mapping layer that translates a `create_deep_agent`-style
 * options object (`model`, `tools`, `systemPrompt`) into GuruHarness session
 * configuration. It maps option shapes onto Guru-native structures; it does
 * **not** invoke, host, or re-implement LangGraph or any other orchestration
 * SDK. The mapping is the only job — Foundational Law 1 (owned runtime) holds:
 * no external framework is pulled into the loop.
 *
 * This is a compatibility *facade*: callers that speak the deep-agent options
 * vocabulary get a Guru config descriptor back, with no behavioral ceiling
 * inherited from the upstream API shape.
 */

/** Deep-agent-style model descriptor carried in `options.model`. */
export interface DeepAgentModelDescriptor {
  /** Free-form model identifier as expressed by the caller (e.g. "gpt-4o"). */
  readonly model: string;
}

/**
 * A single deep-agent-style tool option. Tools map to Guru tool ids; a bare
 * string is treated as a tool id with no extra metadata.
 */
export type DeepAgentToolOption = string | { readonly id: string };

/** Input options in the deep-agent `create_deep_agent` vocabulary. */
export interface DeepAgentOptions {
  /** Model to route the session through. */
  readonly model?: DeepAgentModelDescriptor | string;
  /** Tool ids the agent may call. */
  readonly tools?: readonly DeepAgentToolOption[];
  /** System prompt that primes the session. */
  readonly systemPrompt?: string;
}

/** A tool id extracted from a deep-agent tool option. */
export interface DeepAgentMappedTool {
  readonly id: string;
}

/**
 * The Guru session config descriptor produced by the facade. It is a
 * model-agnostic struct that the Guru runtime consumes directly — it does not
 * bind the session to any single provider or framework.
 */
export interface DeepAgentCompatConfig {
  /** Resolved model identifier, or `null` when the caller omitted a model. */
  readonly model: string | null;
  /** Resolved tool ids in caller order. */
  readonly tools: readonly DeepAgentMappedTool[];
  /** System prompt, or `null` when omitted. */
  readonly systemPrompt: string | null;
}

/**
 * Map a `create_deep_agent`-style options object to a Guru session config
 * descriptor. Pure and total: every option field resolves to a concrete value
 * (or `null`) and the function never throws on missing/optional input.
 */
export function mapOptions(options: DeepAgentOptions = {}): DeepAgentCompatConfig {
  return {
    model: resolveModel(options.model),
    tools: resolveTools(options.tools),
    systemPrompt: resolveSystemPrompt(options.systemPrompt)
  };
}

function resolveModel(model: DeepAgentOptions["model"]): string | null {
  if (model === undefined || model === null) {
    return null;
  }
  if (typeof model === "string") {
    const trimmed = model.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  const trimmed = model.model.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveTools(tools: DeepAgentOptions["tools"]): readonly DeepAgentMappedTool[] {
  if (!tools) {
    return [];
  }
  return tools
    .map((tool) => (typeof tool === "string" ? tool.trim() : tool.id.trim()))
    .filter((id) => id.length > 0)
    .map((id) => ({ id }));
}

function resolveSystemPrompt(systemPrompt: DeepAgentOptions["systemPrompt"]): string | null {
  if (systemPrompt === undefined || systemPrompt === null) {
    return null;
  }
  const trimmed = systemPrompt.trim();
  return trimmed.length > 0 ? trimmed : null;
}

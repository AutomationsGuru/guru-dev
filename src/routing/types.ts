/**
 * Model route representation for protocol switching.
 * Minimal shape needed for F76 protocol route switch.
 */
export interface ModelRoute {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly protocol: Protocol;
}

/**
 * Supported provider protocols for multi-protocol routing.
 * - openai-compat: OpenAI-compatible endpoints (GPT, Qwen, local, etc.)
 * - anthropic: Native Anthropic Messages API
 * - gemini-shape: Gemini native shape (or Gemini via OpenAI compat)
 */
export type Protocol = 'openai-compat' | 'anthropic' | 'gemini-shape';

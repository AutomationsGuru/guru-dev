/**
 * Agent turn execution with centralized error handling.
 * This module demonstrates integration of error mappers into the provider call layer.
 */

import { GuruError, ErrorCode, createGuruError } from './types/errors.js';
import { mapProviderError, mapErrorWithProvider } from './errors/mapper.js';
import { OpenAIAdapter } from './adapters/openai.js';
import { AnthropicAdapter } from './adapters/anthropic.js';
import { GoogleAdapter } from './adapters/google.js';

/**
 * Configuration for agent turn execution.
 */
export interface AgentTurnConfig {
  provider: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  maxTokens?: number;
  temperature?: number;
  tools?: unknown[];
}

/**
 * Result of an agent turn.
 */
export interface AgentTurnResult {
  success: boolean;
  content?: string;
  toolCalls?: unknown[];
  error?: GuruError;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Execute an agent turn with centralized error handling.
 * Wraps provider-specific API calls and maps all errors to GuruError.
 */
export async function executeAgentTurn(
  config: AgentTurnConfig,
  providerCall: (config: AgentTurnConfig) => Promise<unknown>
): Promise<AgentTurnResult> {
  try {
    // Execute the provider-specific call
    const response = await providerCall(config);

    // On success, return normalized result
    // Note: Actual response parsing depends on provider implementation
    return {
      success: true,
      content: typeof response === 'string' ? response : JSON.stringify(response),
    };
  } catch (error) {
    // Map provider-specific error to GuruError using centralized mapper
    const guruError = mapProviderError(config.provider, error);

    // Return error result with mapped GuruError
    return {
      success: false,
      error: guruError,
    };
  }
}

/**
 * Execute an agent turn with automatic retry for transient errors.
 * Retries on RATE_LIMIT and SERVICE_UNAVAILABLE with exponential backoff.
 */
export async function executeAgentTurnWithRetry(
  config: AgentTurnConfig,
  providerCall: (config: AgentTurnConfig) => Promise<unknown>,
  options: {
    maxRetries?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
  } = {}
): Promise<AgentTurnResult> {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 30000;

  let lastError: GuruError | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await executeAgentTurn(config, providerCall);

    if (result.success) {
      return result;
    }

    lastError = result.error;

    // Only retry on transient errors
    if (
      result.error?.code === ErrorCode.RATE_LIMIT ||
      result.error?.code === ErrorCode.SERVICE_UNAVAILABLE ||
      result.error?.code === ErrorCode.TIMEOUT
    ) {
      if (attempt < maxRetries) {
        // Calculate exponential backoff delay
        const delayMs = Math.min(
          initialDelayMs * Math.pow(2, attempt),
          maxDelayMs
        );

        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
    }

    // Non-retryable error or max retries exceeded
    break;
  }

  return {
    success: false,
    error: lastError ?? createGuruError(ErrorCode.UNKNOWN, 'Unknown error after retries'),
  };
}

/**
 * Session-level error handler for managing conversation state on errors.
 * Determines if error is recoverable and suggests recovery actions.
 */
export interface SessionErrorContext {
  error: GuruError;
  isRecoverable: boolean;
  suggestedAction: 'retry' | 'reduce_context' | 'switch_model' | 'check_api_key' | 'abort';
  userMessage: string;
}

/**
 * Analyze a GuruError in session context and determine recovery strategy.
 */
export function analyzeSessionError(error: GuruError): SessionErrorContext {
  switch (error.code) {
    case ErrorCode.RATE_LIMIT:
      return {
        error,
        isRecoverable: true,
        suggestedAction: 'retry',
        userMessage: 'Rate limit exceeded. Retrying with backoff...',
      };

    case ErrorCode.INVALID_API_KEY:
      return {
        error,
        isRecoverable: false,
        suggestedAction: 'check_api_key',
        userMessage: 'Invalid API key. Please check your credentials.',
      };

    case ErrorCode.INVALID_MODEL:
      return {
        error,
        isRecoverable: true,
        suggestedAction: 'switch_model',
        userMessage: 'Model not available. Switching to fallback model...',
      };

    case ErrorCode.CONTEXT_LENGTH:
      return {
        error,
        isRecoverable: true,
        suggestedAction: 'reduce_context',
        userMessage: 'Context too long. Truncating conversation history...',
      };

    case ErrorCode.CONTENT_FILTER:
      return {
        error,
        isRecoverable: true,
        suggestedAction: 'retry',
        userMessage: 'Content filtered. Please revise your request.',
      };

    case ErrorCode.SERVICE_UNAVAILABLE:
    case ErrorCode.TIMEOUT:
      return {
        error,
        isRecoverable: true,
        suggestedAction: 'retry',
        userMessage: 'Service temporarily unavailable. Retrying...',
      };

    case ErrorCode.NETWORK_ERROR:
      return {
        error,
        isRecoverable: true,
        suggestedAction: 'retry',
        userMessage: 'Network error. Checking connection and retrying...',
      };

    case ErrorCode.TOOL_ERROR:
      return {
        error,
        isRecoverable: true,
        suggestedAction: 'retry',
        userMessage: 'Tool execution failed. Retrying without tool...',
      };

    case ErrorCode.INVALID_REQUEST:
      return {
        error,
        isRecoverable: false,
        suggestedAction: 'abort',
        userMessage: 'Invalid request. Please check your configuration.',
      };

    case ErrorCode.UNKNOWN:
    default:
      return {
        error,
        isRecoverable: false,
        suggestedAction: 'abort',
        userMessage: 'An unexpected error occurred.',
      };
  }
}

/**
 * AgentSession class demonstrating session-level error handling integration.
 */
export class AgentSession {
  private provider: string;
  private model: string;
  private messages: Array<{ role: string; content: string }> = [];
  private errorHistory: GuruError[] = [];

  constructor(provider: string, model: string) {
    this.provider = provider;
    this.model = model;
  }

  /**
   * Add a message to the conversation history.
   */
  addMessage(role: string, content: string): void {
    this.messages.push({ role, content });
  }

  /**
   * Execute a turn within the session context.
   */
  async executeTurn(
    providerCall: (config: AgentTurnConfig) => Promise<unknown>
  ): Promise<AgentTurnResult> {
    const config: AgentTurnConfig = {
      provider: this.provider,
      model: this.model,
      messages: [...this.messages],
    };

    const result = await executeAgentTurnWithRetry(config, providerCall);

    if (!result.success && result.error) {
      // Track error in session history
      this.errorHistory.push(result.error);

      // Analyze error for recovery guidance
      const context = analyzeSessionError(result.error);

      // Log recovery suggestion (in production, this would trigger UI feedback)
      if (context.isRecoverable) {
        console.log(`[AgentSession] ${context.userMessage}`);
      }
    }

    return result;
  }

  /**
   * Get the error history for this session.
   */
  getErrorHistory(): GuruError[] {
    return [...this.errorHistory];
  }

  /**
   * Check if the session has encountered unrecoverable errors.
   */
  hasUnrecoverableErrors(): boolean {
    return this.errorHistory.some(
      (error) =>
        error.code === ErrorCode.INVALID_API_KEY ||
        error.code === ErrorCode.INVALID_REQUEST
    );
  }

  /**
   * Clear error history (e.g., after successful recovery).
   */
  clearErrorHistory(): void {
    this.errorHistory = [];
  }
}

/**
 * Factory function to create a session with error handling pre-configured.
 */
export function createAgentSession(provider: string, model: string): AgentSession {
  return new AgentSession(provider, model);
}

/**
 * Adapter interface for provider communication.
 * Implementations wrap the underlying SDK (OpenAI, Anthropic, Google)
 * and expose a unified sendMessage surface.
 */
export interface ProviderAdapter {
  sendMessage(
    messages: Array<{ role: string; content: string }>,
    model: string,
    options?: { maxTokens?: number; temperature?: number; tools?: unknown[] }
  ): Promise<{
    content: string;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    model?: string;
    finishReason?: string;
  }>;
}

/**
 * Factory type for creating provider adapters given a provider name and API key.
 */
export type ProviderAdapterFactory = (provider: string, apiKey: string) => ProviderAdapter;

/**
 * Execute a direct agent turn against a specific provider.
 *
 * Wraps provider adapter creation and sendMessage in try/catch,
 * maps any provider error to GuruError via the centralized mapper,
 * logs the error, and re-throws as GuruError for consistent upstream handling.
 */
export async function directAgentTurn(
  provider: string,
  apiKey: string,
  messages: Array<{ role: string; content: string }>,
  model: string,
  options?: { maxTokens?: number; temperature?: number; tools?: unknown[] },
  adapterFactory?: ProviderAdapterFactory
): Promise<{
  content: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  model: string;
  finishReason?: string;
}> {
  // If no factory provided, we cannot instantiate a real adapter here.
  // The caller is expected to supply one (or we could lazily import SDKs).
  // For integration demonstration, require the factory or throw a clear GuruError.
  if (!adapterFactory) {
    const err = createGuruError(
      ErrorCode.INVALID_REQUEST,
      'directAgentTurn requires a ProviderAdapterFactory to resolve provider clients'
    );
    console.error(`[directAgentTurn] ${provider}:`, err.message);
    throw err;
  }

  let adapter: ProviderAdapter;
  try {
    adapter = adapterFactory(provider, apiKey);
  } catch (factoryError) {
    const guruError = mapProviderError(provider, factoryError);
    console.error(`[directAgentTurn] Failed to create ${provider} adapter:`, guruError.message);
    throw guruError;
  }

  try {
    const response = await adapter.sendMessage(messages, model, options);
    return {
      content: response.content,
      usage: response.usage,
      model: response.model || model,
      finishReason: response.finishReason,
    };
  } catch (error) {
    const guruError = mapProviderError(provider, error);
    console.error(`[${provider}] Provider error in directAgentTurn:`, guruError.message);
    throw guruError;
  }
}

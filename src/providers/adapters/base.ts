/**
 * Abstract base class for provider adapters.
 *
 * Implements the ProviderAdapter interface with common functionality and
 * provides extension points for provider-specific implementations.
 */

import {
  ProviderAdapter,
  ChatRequest,
  ChatResponse,
  StreamChunk,
  ToolDefinition,
} from '../types/provider.js';
import { GuruError } from '../../types/errors.js';
import { BaseChunkTransformer } from '../streaming/chunk-transform.js';
import { normalizeError } from '../errors/mapper.js';
import { GuruError } from '../types/errors.js';

/**
 * Abstract base implementation of ProviderAdapter.
 *
 * Provider-specific adapters (OpenAI, Anthropic, Google, etc.) extend this
 * class and implement the abstract methods for their wire format.
 *
 * Provides:
 * - Common property storage (name, supportedModels)
 * - Default implementations for optional methods
 * - Error normalization via normalizeError
 * - Stream iteration helper using chunk transformer
 */
export abstract class AbstractProviderAdapter implements ProviderAdapter {
  readonly name: string;
  readonly supportedModels: string[];

  /**
   * Optional chunk transformer for normalizing stream chunks.
   * Provider implementations can set this to customize chunk handling.
   */
  protected chunkTransformer?: BaseChunkTransformer;

  constructor(name: string, supportedModels: string[] = []) {
    this.name = name;
    this.supportedModels = supportedModels;
  }

  /**
   * Normalize a ChatRequest into the provider's wire format.
   *
   * Must be implemented by each provider adapter to handle their specific
   * request structure, message formats, and tool definitions.
   */
  abstract normalizeRequest(request: ChatRequest): unknown;

  /**
   * Normalize a raw provider response into ChatResponse.
   *
   * Must be implemented by each provider adapter to parse their response
   * format and extract standardized fields.
   */
  abstract normalizeResponse(raw: unknown): ChatResponse;

  /**
   * Normalize a single raw stream chunk into StreamChunk.
   *
   * Must be implemented by each provider adapter to handle their streaming
   * delta format and produce normalized incremental updates.
   */
  abstract normalizeStreamChunk(raw: unknown): StreamChunk | null;

  /**
   * Create an async iterator that yields normalized StreamChunks.
   *
   * Default implementation wraps the raw stream and applies normalizeStreamChunk.
   * Provider implementations may override for custom stream handling.
   *
   * @param rawStream - Async iterable of raw provider chunks
   * @returns Async iterable of normalized StreamChunks
   */
  async *createStreamIterator(
    rawStream: AsyncIterable<unknown>
  ): AsyncIterable<StreamChunk> {
    for await (const raw of rawStream) {
      const normalized = this.normalizeStreamChunk(raw);
      if (normalized !== null) {
        yield normalized;
      }
    }
  }

  /**
   * Map a provider error to GuruError.
   *
   * Default implementation uses normalizeError for common error patterns.
   * Provider implementations may override for custom error parsing.
   */
  mapError(error: unknown): GuruError {
    return normalizeError(error, this.name);
  }

  /**
   * Check if this provider supports tool/function calling.
   *
   * Default returns false. Providers that support tools should override.
   */
  supportsTools(): boolean {
    return false;
  }

  /**
   * Normalize tool definitions into provider-specific format.
   *
   * Default returns empty array. Providers that support tools should override.
   */
  normalizeToolDefinitions(tools: ToolDefinition[]): unknown {
    if (!this.supportsTools()) {
      return [];
    }
    return tools;
  }

  /**
   * Check if a model is supported by this provider.
   *
   * @param model - Model identifier to check
   * @returns True if model is in supportedModels list or list is empty (all supported)
   */
  isModelSupported(model: string): boolean {
    if (this.supportedModels.length === 0) {
      return true; // Empty list means all models supported
    }
    return this.supportedModels.includes(model);
  }

  /**
   * Get the chunk transformer for this adapter.
   *
   * Returns the configured transformer or creates a default identity transformer.
   */
  protected getChunkTransformer(): BaseChunkTransformer {
    if (this.chunkTransformer) {
      return this.chunkTransformer;
    }
    // Default: use normalizeStreamChunk as the transformer
    return {
      transform: (raw: unknown) => this.normalizeStreamChunk(raw),
      canTransform: () => true,
    } as BaseChunkTransformer;
  }

  /**
   * Set a custom chunk transformer for this adapter.
   *
   * @param transformer - Chunk transformer to use for stream normalization
   */
  setChunkTransformer(transformer: BaseChunkTransformer): void {
    this.chunkTransformer = transformer;
  }
}

/**
 * Minimal provider adapter for providers without streaming support.
 *
 * Extends AbstractProviderAdapter with a no-op streaming implementation.
 * Useful for providers that only support synchronous completions.
 */
export abstract class NonStreamingProviderAdapter extends AbstractProviderAdapter {
  /**
   * Non-streaming adapters return null for all stream chunks.
   */
  normalizeStreamChunk(_raw: unknown): StreamChunk | null {
    return null;
  }

  /**
   * Non-streaming adapters yield no chunks.
   */
  async *createStreamIterator(
    _rawStream: AsyncIterable<unknown>
  ): AsyncIterable<StreamChunk> {
    // Yield nothing - this provider doesn't support streaming
    return;
  }
}

/**
 * Create a simple provider adapter from configuration object.
 *
 * Factory function for creating minimal adapters without extending the base class.
 * Useful for testing or simple provider integrations.
 *
 * @param config - Adapter configuration
 * @returns ProviderAdapter instance
 */
export function createSimpleAdapter(config: {
  name: string;
  supportedModels?: string[];
  normalizeRequest: (request: ChatRequest) => unknown;
  normalizeResponse: (raw: unknown) => ChatResponse;
  normalizeStreamChunk?: (raw: unknown) => StreamChunk | null;
  mapError?: (error: unknown) => GuruError;
  supportsTools?: () => boolean;
  normalizeToolDefinitions?: (tools: ToolDefinition[]) => unknown[];
}): ProviderAdapter {
  return {
    name: config.name,
    supportedModels: config.supportedModels || [],

    normalizeRequest: config.normalizeRequest,
    normalizeResponse: config.normalizeResponse,

    normalizeStreamChunk: config.normalizeStreamChunk || (() => null),

    async *createStreamIterator(rawStream: AsyncIterable<unknown>) {
      const normalize = config.normalizeStreamChunk || (() => null);
      for await (const raw of rawStream) {
        const normalized = normalize(raw);
        if (normalized !== null) {
          yield normalized;
        }
      }
    },

    mapError: config.mapError || ((error: unknown) => normalizeError(error, config.name)),

    supportsTools: config.supportsTools || (() => false),

    normalizeToolDefinitions: config.normalizeToolDefinitions || ((_: ToolDefinition[]) => [] as unknown[]),
  };
}

/**
 * OpenAI Provider Adapter
 *
 * Implements wire compatibility for OpenAI Chat Completions API.
 * - Request normalization: identity passthrough with validation
 * - Response normalization: OpenAI → common ChatResponse
 * - Streaming: OpenAI SSE chunks → StreamChunk via transformer
 * - Error mapping: OpenAI errors → GuruError with proper codes
 * - Tool definitions: passthrough (OpenAI format is canonical)
 */

import type {
  ChatRequest,
  ChatResponse,
  StreamChunk,
  ToolDefinition,
  ChatMessage,
  ToolCall,
  Usage,
  FinishReason,
} from '../types/provider.js';
import type {
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIStreamChunk,
  OpenAIDelta,
  OpenAIChoice,
  OpenAIStreamChoice,
  OpenAIToolDefinition,
  OpenAIErrorResponse,
} from '../types/openai.js';
import { GuruError } from '../types/errors.js';
import { AbstractProviderAdapter } from './base.js';

/**
 * OpenAIAdapter
 *
 * Extends AbstractProviderAdapter to provide OpenAI-specific normalization,
 * error mapping, and streaming support.
 */
export class OpenAIAdapter extends AbstractProviderAdapter {
  readonly supportedModels: string[] = [];

  constructor() {
    super('openai');
  }

  /**
   * T3.2: Request normalization (identity + validation)
   * OpenAI request format is the wire format; perform basic structural validation.
   */
  normalizeRequest(request: ChatRequest): unknown {
    if (!request || typeof request !== 'object') {
      throw new GuruError('Request must be an object', {
        code: 'INVALID_REQUEST',
        provider: 'openai',
      });
    }

    const req = request as OpenAIChatRequest;

    if (!req.model || typeof req.model !== 'string') {
      throw new GuruError('model is required and must be a string', {
        code: 'INVALID_REQUEST',
        provider: 'openai',
      });
    }

    if (!Array.isArray(req.messages) || req.messages.length === 0) {
      throw new GuruError('messages must be a non-empty array', {
        code: 'INVALID_REQUEST',
        provider: 'openai',
      });
    }

    // Identity passthrough: tools, tool_choice, response_format, etc. remain as-is
    return req;
  }

  /**
   * T3.3: Response normalization (OpenAI → common ChatResponse)
   */
  normalizeResponse(raw: unknown): ChatResponse {
    const resp = raw as OpenAIChatResponse;

    return {
      id: resp.id,
      model: resp.model,
      choices: (resp.choices || []).map((choice: OpenAIChoice) => ({
        index: choice.index,
        message: this.mapOpenAIMessage(choice.message),
        finish_reason: this.mapFinishReason(choice.finish_reason),
      })),
      usage: resp.usage
        ? {
            prompt_tokens: resp.usage.prompt_tokens,
            completion_tokens: resp.usage.completion_tokens,
            total_tokens: resp.usage.total_tokens,
          }
        : undefined,
    };
  }

  private mapOpenAIMessage(msg: any): ChatMessage {
    if (!msg) {
      return { role: 'assistant', content: null };
    }

    const toolCalls: ToolCall[] | undefined = msg.tool_calls?.map((tc: any) => ({
      id: tc.id,
      type: 'function' as const,
      function: {
        name: tc.function?.name || '',
        arguments: tc.function?.arguments || '',
      },
    }));

    return {
      role: msg.role,
      content: msg.content ?? null,
      tool_calls: toolCalls,
      tool_call_id: msg.tool_call_id,
    };
  }

  private mapFinishReason(reason?: string | null): FinishReason {
    if (!reason) return null;

    const mapping: Record<string, FinishReason> = {
      stop: 'stop',
      length: 'length',
      tool_calls: 'tool_calls',
      content_filter: 'content_filter',
    };

    return mapping[reason] ?? 'stop';
  }

  /**
   * T3.4: Streaming normalization (OpenAI SSE chunk → StreamChunk)
   */
  normalizeStreamChunk(raw: unknown): StreamChunk | null {
    if (!raw || typeof raw !== 'object') {
      return null;
    }

    const chunk = raw as OpenAIStreamChunk;

    // Skip empty chunks or keepalive pings
    if (!chunk.choices || chunk.choices.length === 0) {
      return null;
    }

    const choices = chunk.choices.map((choice: OpenAIStreamChoice) => ({
      index: choice.index,
      delta: this.mapOpenAIDelta(choice.delta),
      finish_reason: this.mapFinishReason(choice.finish_reason),
    }));

    return {
      id: chunk.id,
      model: chunk.model,
      choices,
    };
  }

  private mapOpenAIDelta(delta: OpenAIDelta | undefined): Partial<ChatMessage> {
    if (!delta) {
      return {};
    }

    const toolCalls: ToolCall[] | undefined = delta.tool_calls?.map((tc: any) => ({
      id: tc.id,
      type: 'function' as const,
      function: {
        name: tc.function?.name || '',
        arguments: tc.function?.arguments || '',
      },
    }));

    return {
      role: delta.role,
      content: delta.content ?? null,
      tool_calls: toolCalls,
    };
  }

  /**
   * T3.5: Error mapping (OpenAI errors → GuruError)
   */
  mapError(error: unknown): GuruError {
    if (error instanceof GuruError) {
      return error;
    }

    let message = 'OpenAI request failed';
    let code: GuruError['code'] = 'NETWORK_ERROR';
    let statusCode: number | undefined;
    let retryable = false;

    if (error instanceof Error) {
      message = error.message;
    }

    // OpenAI error body shape: { error: { message, type, code, param } }
    const errBody = (error as any)?.error || error;
    if (errBody && typeof errBody === 'object') {
      if (errBody.message) {
        message = errBody.message;
      }
      const errCode = errBody.code || errBody.type;

      switch (errCode) {
        case 'insufficient_quota':
        case 'rate_limit_exceeded':
        case 'rate_limit':
          code = 'RATE_LIMIT';
          statusCode = 429;
          retryable = true;
          break;

        case 'invalid_api_key':
        case 'account_deactivated':
        case 'authentication_error':
          code = 'INVALID_API_KEY';
          statusCode = 401;
          break;

        case 'model_not_found':
        case 'invalid_request_error':
        case 'invalid_request':
          code = 'INVALID_REQUEST';
          statusCode = 400;
          break;

        case 'context_length_exceeded':
          code = 'CONTEXT_LENGTH';
          statusCode = 400;
          break;

        case 'content_filter':
          code = 'CONTENT_FILTER';
          statusCode = 400;
          break;

        case 'server_error':
          code = 'NETWORK_ERROR';
          statusCode = 500;
          retryable = true;
          break;

        default:
          // Fallback to HTTP status if present
          const httpStatus = (error as any)?.status || (error as any)?.statusCode;
          if (typeof httpStatus === 'number') {
            statusCode = httpStatus;
            if (httpStatus === 429) {
              code = 'RATE_LIMIT';
              retryable = true;
            } else if (httpStatus === 401 || httpStatus === 403) {
              code = 'INVALID_API_KEY';
            } else if (httpStatus >= 400 && httpStatus < 500) {
              code = 'INVALID_REQUEST';
            } else if (httpStatus >= 500) {
              code = 'NETWORK_ERROR';
              retryable = true;
            }
          }
      }
    }

    return new GuruError(message, {
      code,
      provider: 'openai',
      statusCode,
      retryable,
    });
  }

  /**
   * T3.6: Tool definition passthrough
   * OpenAI tool format is the canonical format used across the system.
   * No transformation required.
   */
  normalizeToolDefinitions(tools: ToolDefinition[]): unknown {
    // Passthrough: OpenAI's tool definition shape matches ToolDefinition
    return tools;
  }

  /**
   * Override supportsTools to return true for OpenAI
   */
  supportsTools(): boolean {
    return true;
  }
}

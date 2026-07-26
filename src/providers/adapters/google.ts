/**
 * Google Gemini adapter implementation.
 *
 * Implements the AbstractProviderAdapter for Google Gemini API, handling:
 * - Request conversion: ChatRequest → Gemini GenerateContentRequest
 * - Response conversion: Gemini GenerateContentResponse → ChatResponse
 * - Streaming: Gemini SSE stream → StreamChunk
 * - Error mapping: Google HTTP errors → GuruError
 * - Tool calling: ToolDefinition → Gemini functionDeclarations format
 *
 * @see https://ai.google.dev/api/generate-content
 */

import { AbstractProviderAdapter } from './base.js';
import {
  ChatRequest,
  ChatResponse,
  ChatMessage,
  MessageRole,
  ToolDefinition,
  ToolCall,
  FinishReason,
  StreamChunk,
} from '../types/wire.js';
import type { GuruError } from '../types/errors.js';
import {
  GeminiRequest,
  GeminiResponse,
  GeminiContent,
  GeminiPart,
  GeminiCandidate,
  GeminiFunctionDeclaration,
  GeminiTool,
  GeminiStreamChunk,
  GeminiErrorResponse,
  GEMINI_FINISH_REASON_MAP,
  mapGeminiFinishReason,
} from '../types/google.js';
import { GuruError, ErrorCodes } from '../types/errors.js';

/**
 * Map wire protocol role to Gemini role.
 */
function mapToGeminiRole(role: MessageRole): 'user' | 'model' {
  switch (role) {
    case 'user':
    case 'tool':
      return 'user';
    case 'assistant':
      return 'model';
    case 'system':
      return 'user'; // System messages handled separately
    default:
      return 'user';
  }
}

/**
 * Map Gemini role to wire protocol role.
 */
function mapGeminiRole(role: 'user' | 'model'): MessageRole {
  return role === 'model' ? 'assistant' : 'user';
}

/**
 * Google Gemini provider adapter.
 *
 * Extends AbstractProviderAdapter to provide Google-specific implementations
 * for request/response conversion, streaming, and error handling.
 */
export class GoogleAdapter extends AbstractProviderAdapter {
  readonly name = 'google';
  readonly supportedModels: string[] = [
    'gemini-1.5-pro',
    'gemini-1.5-flash',
    'gemini-1.0-pro',
    'gemini-pro',
  ];

  constructor() {
    super('google', [
      'gemini-1.5-pro',
      'gemini-1.5-flash',
      'gemini-1.0-pro',
      'gemini-pro',
    ]);
  }

  /**
   * Convert a ChatRequest to Google Gemini request format.
   *
   * Maps:
   * - messages[] → contents[] with parts[]
   * - system message → system_instruction
   * - tools → tools.function_declarations
   * - model parameters → generation_config
   *
   * @param request - Normalized chat request
   * @returns Google Gemini request body
   */
  normalizeRequest(request: ChatRequest): GeminiRequest {
    const contents: GeminiContent[] = [];
    let systemInstruction: { parts: GeminiPart[] } | undefined;

    // Process messages, extracting system instruction separately
    for (const message of request.messages) {
      if (message.role === 'system') {
        // Google uses system_instruction at the top level
        systemInstruction = {
          parts: [{ text: message.content as string }],
        };
        continue;
      }

      const role = mapToGeminiRole(message.role);
      const parts: GeminiPart[] = [];

      // Handle text content
      if (message.content && typeof message.content === 'string') {
        parts.push({ text: message.content });
      }

      // Handle tool calls (assistant message requesting tool execution)
      if (message.tool_calls && message.tool_calls.length > 0) {
        for (const toolCall of message.tool_calls) {
          parts.push({
            function_call: {
              name: toolCall.function.name,
              args: JSON.parse(toolCall.function.arguments),
            },
          });
        }
      }

      // Handle tool results (user message with tool output)
      if (message.role === 'tool' && message.tool_call_id) {
        // Tool results are sent as function_response parts
        parts.push({
          function_response: {
            name: message.tool_call_id,
            response: { result: message.content },
          },
        });
      }

      contents.push({ role, parts });
    }

    // Build the request
    const geminiRequest: GeminiRequest = {
      contents,
    };

    // Add system instruction if present
    if (systemInstruction) {
      geminiRequest.system_instruction = systemInstruction;
    }

    // Add generation config
    geminiRequest.generation_config = {
      temperature: request.temperature,
      top_p: request.top_p,
      top_k: request.top_k,
      max_output_tokens: request.max_tokens,
      stop_sequences: request.stop as string[] | undefined,
    };

    // Add tools if present
    if (request.tools && request.tools.length > 0) {
      const functionDeclarations: GeminiFunctionDeclaration[] = request.tools.map(
        (tool: ToolDefinition) => ({
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        })
      );

      geminiRequest.tools = [
        {
          function_declarations: functionDeclarations,
        },
      ];
    }

    return geminiRequest;
  }

  /**
   * Convert a Google Gemini response to normalized ChatResponse format.
   *
   * Maps:
   * - candidates[0].content.parts[] → choices[0].message
   * - candidates[0].finish_reason → choices[0].finish_reason
   * - usage_metadata → usage
   *
   * @param raw - Raw Google Gemini API response
   * @returns Normalized chat response
   */
  normalizeResponse(raw: unknown): ChatResponse {
    const response = raw as GeminiResponse;
    const candidate = response.candidates?.[0];
    if (!candidate) {
      throw createGuruError(
        GuruErrorCode.INTERNAL_ERROR,
        'Google response missing candidates',
        GuruErrorType.PROVIDER_ERROR
      );
    }

    const parts = candidate.content?.parts ?? [];
    let content = '';
    const toolCalls: ToolCall[] = [];

    // Extract text and function calls from parts
    for (const part of parts) {
      if ('text' in part && part.text) {
        content += part.text;
      }
      if ('function_call' in part && part.function_call) {
        toolCalls.push({
          id: part.function_call.name,
          type: 'function',
          function: {
            name: part.function_call.name,
            arguments: JSON.stringify(part.function_call.args),
          },
        });
      }
    }

    // Build assistant message
    const message: ChatMessage = {
      role: 'assistant',
      content,
    };

    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }

    // Map finish reason
    const finishReason = candidate.finish_reason
      ? mapGeminiFinishReason(candidate.finish_reason)
      : (null as FinishReason);

    // Build response
    const chatResponse: ChatResponse = {
      id: `google-${Date.now()}`,
      model: 'gemini', // Model not in response, use placeholder
      choices: [
        {
          index: 0,
          message,
          finish_reason: finishReason,
        },
      ],
      usage: response.usage_metadata
        ? {
            prompt_tokens: response.usage_metadata.prompt_token_count ?? 0,
            completion_tokens: response.usage_metadata.candidates_token_count ?? 0,
            total_tokens: response.usage_metadata.total_token_count ?? 0,
          }
        : undefined,
    };

    return chatResponse;
  }

  /**
   * Convert a Google Gemini stream chunk to normalized StreamChunk format.
   *
   * Maps streaming delta updates for incremental content delivery.
   *
   * @param raw - Raw Google Gemini SSE stream chunk
   * @returns Normalized stream chunk, or null if chunk should be skipped
   */
  normalizeStreamChunk(raw: unknown): StreamChunk | null {
    const chunk = raw as GeminiStreamChunk;
    const candidate = chunk.candidates?.[0];
    if (!candidate) {
      return null;
    }

    const parts = candidate.content?.parts ?? [];
    let delta = '';
    const toolCalls: ToolCall[] = [];

    // Extract text and function calls from parts
    for (const part of parts) {
      if ('text' in part && part.text) {
        delta += part.text;
      }
      if ('function_call' in part && part.function_call) {
        toolCalls.push({
          id: part.function_call.name,
          type: 'function',
          function: {
            name: part.function_call.name,
            arguments: JSON.stringify(part.function_call.args),
          },
        });
      }
    }

    // Map finish reason if present
    const finishReason = candidate.finish_reason
      ? mapGeminiFinishReason(candidate.finish_reason)
      : undefined;

    // Build stream chunk
    const streamChunk: StreamChunk = {
      id: `google-stream-${Date.now()}`,
      model: '',
      choices: [
        {
          index: 0,
          delta: {
            content: delta || undefined,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          },
          finish_reason: finishReason ?? null,
        },
      ],
    };

    return streamChunk;
  }

  /**
   * Map a Google Gemini error to a normalized GuruError.
   *
   * Parses Google error responses and maps HTTP status codes and error types
   * to appropriate GuruError codes.
   *
   * @param error - Raw error from Google API (may be HTTP error or GeminiErrorResponse)
   * @returns Normalized GuruError with appropriate code and metadata
   */
  mapError(error: unknown): GuruError {
    // Handle GeminiErrorResponse structure
    if (this.isGeminiErrorResponse(error)) {
      return this.mapGeminiErrorResponse(error);
    }

    // Handle standard HTTP errors with status codes
    if (this.isHttpError(error)) {
      return this.mapHttpError(error);
    }

    // Fallback for unknown error types
    return createGuruError(
      GuruErrorCode.INTERNAL_ERROR,
      error instanceof Error ? error.message : 'Unknown Google API error',
      GuruErrorType.PROVIDER_ERROR,
      { originalError: error }
    );
  }

  /**
   * Check if error is a GeminiErrorResponse structure.
   */
  private isGeminiErrorResponse(error: unknown): error is GeminiErrorResponse {
    return (
      typeof error === 'object' &&
      error !== null &&
      'error' in error &&
      typeof (error as GeminiErrorResponse).error === 'object'
    );
  }

  /**
   * Check if error is an HTTP error with status code.
   */
  private isHttpError(error: unknown): error is { status: number; message?: string } {
    return (
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      typeof (error as { status: unknown }).status === 'number'
    );
  }

  /**
   * Map a GeminiErrorResponse to GuruError.
   */
  private mapGeminiErrorResponse(error: GeminiErrorResponse): GuruError {
    const geminiError = error.error;
    const statusCode = geminiError.code;
    const message = geminiError.message;
    const details = geminiError.details;

    // Map based on status code
    switch (statusCode) {
      case 400:
        return createGuruError(
          GuruErrorCode.INVALID_REQUEST,
          message,
          GuruErrorType.VALIDATION_ERROR,
          { statusCode, details }
        );
      case 401:
        return createGuruError(
          GuruErrorCode.AUTHENTICATION_ERROR,
          message,
          GuruErrorType.AUTHENTICATION_ERROR,
          { statusCode, details }
        );
      case 403:
        return createGuruError(
          GuruErrorCode.AUTHORIZATION_ERROR,
          message,
          GuruErrorType.AUTHORIZATION_ERROR,
          { statusCode, details }
        );
      case 404:
        return createGuruError(
          GuruErrorCode.NOT_FOUND,
          message,
          GuruErrorType.PROVIDER_ERROR,
          { statusCode, details }
        );
      case 429:
        return createGuruError(
          GuruErrorCode.RATE_LIMIT_ERROR,
          message,
          GuruErrorType.RATE_LIMIT_ERROR,
          { statusCode, details }
        );
      case 500:
      case 502:
      case 503:
      case 504:
        return createGuruError(
          GuruErrorCode.PROVIDER_UNAVAILABLE,
          message,
          GuruErrorType.PROVIDER_ERROR,
          { statusCode, details }
        );
      default:
        return createGuruError(
          GuruErrorCode.INTERNAL_ERROR,
          message,
          GuruErrorType.PROVIDER_ERROR,
          { statusCode, details }
        );
    }
  }

  /**
   * Map an HTTP error to GuruError.
   */
  private mapHttpError(error: { status: number; message?: string }): GuruError {
    const statusCode = error.status;
    const message = error.message ?? `Google API error: ${statusCode}`;

    switch (statusCode) {
      case 400:
        return createGuruError(
          GuruErrorCode.INVALID_REQUEST,
          message,
          GuruErrorType.VALIDATION_ERROR,
          { statusCode }
        );
      case 401:
        return createGuruError(
          GuruErrorCode.AUTHENTICATION_ERROR,
          message,
          GuruErrorType.AUTHENTICATION_ERROR,
          { statusCode }
        );
      case 403:
        return createGuruError(
          GuruErrorCode.AUTHORIZATION_ERROR,
          message,
          GuruErrorType.AUTHORIZATION_ERROR,
          { statusCode }
        );
      case 404:
        return createGuruError(
          GuruErrorCode.NOT_FOUND,
          message,
          GuruErrorType.PROVIDER_ERROR,
          { statusCode }
        );
      case 429:
        return createGuruError(
          GuruErrorCode.RATE_LIMIT_ERROR,
          message,
          GuruErrorType.RATE_LIMIT_ERROR,
          { statusCode }
        );
      case 500:
      case 502:
      case 503:
      case 504:
        return createGuruError(
          GuruErrorCode.PROVIDER_UNAVAILABLE,
          message,
          GuruErrorType.PROVIDER_ERROR,
          { statusCode }
        );
      default:
        return createGuruError(
          GuruErrorCode.INTERNAL_ERROR,
          message,
          GuruErrorType.PROVIDER_ERROR,
          { statusCode }
        );
    }
  }

  /**
   * Check if this provider supports tool/function calling.
   */
  supportsTools(): boolean {
    return true;
  }

  /**
   * Convert unified ToolDefinition array to Gemini format.
   */
  normalizeToolDefinitions(tools: ToolDefinition[]): GeminiTool[] {
    const functionDeclarations: GeminiFunctionDeclaration[] = tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    }));

    return [
      {
        function_declarations: functionDeclarations,
      },
    ];
  }
}

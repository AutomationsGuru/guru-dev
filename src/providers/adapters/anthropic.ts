import type { ChatMessage, ChatRequest, ChatResponse, StreamChunk, ToolDefinition, ToolCall } from '../types/wire.js';
import type { ProviderAdapter, ProviderConfig } from '../types/provider.js';
import type { AnthropicMessage, AnthropicContentBlock, AnthropicTool, AnthropicToolUseBlock, AnthropicToolResultBlock, AnthropicTextBlock, AnthropicStreamEvent, AnthropicErrorResponse } from '../types/anthropic.js';
import { GuruError } from '../errors/types.js';
import { mapAnthropicError } from '../errors/anthropic-mapper.js';

export class AnthropicAdapter implements ProviderAdapter {
  readonly name = 'anthropic';
  readonly supportedModels: readonly string[] = [];
  readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(config: ProviderConfig = {}) {
    this.baseUrl = (config.baseUrl as string) ?? 'https://api.anthropic.com/v1';
    this.apiKey = (config.apiKey as string) ?? '';
  }

  normalizeRequest(req: ChatRequest): unknown {
    const { messages, tools, ...rest } = req;
    const systemMessages = messages.filter((m: ChatMessage) => m.role === 'system');
    const nonSystemMessages = messages.filter((m: ChatMessage) => m.role !== 'system');
    const system = systemMessages.length > 0 ? systemMessages.map((m: ChatMessage) => m.content).join('\n\n') : undefined;

    const anthropicMessages: AnthropicMessage[] = nonSystemMessages.map((msg: ChatMessage) => {
      if (msg.role === 'assistant' && msg.tool_calls) {
        const content: AnthropicContentBlock[] = [];
        if (msg.content) { content.push({ type: 'text', text: msg.content as string }); }
        for (const toolCall of msg.tool_calls) {
          content.push({ type: 'tool_use', id: toolCall.id, name: toolCall.function.name, input: JSON.parse(toolCall.function.arguments) as Record<string, unknown> });
        }
        return { role: 'assistant' as const, content };
      }
      if (msg.role === 'tool') {
        return { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: msg.tool_call_id!, content: msg.content as string }] };
      }
      return { role: msg.role as 'user' | 'assistant', content: msg.content as string | AnthropicContentBlock[] };
    });

    const anthropicTools: AnthropicTool[] | undefined = tools?.map((tool: ToolDefinition) => ({
      name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters
    }));

    return { ...rest, messages: anthropicMessages, ...(system && { system }), ...(anthropicTools && { tools: anthropicTools }) };
  }

  normalizeResponse(raw: unknown): ChatResponse {
    const anthropicResponse = raw as { id: string; model: string; role: string; content: AnthropicContentBlock[]; stop_reason: string | null; usage?: { input_tokens: number; output_tokens: number } };
    const contentBlocks = anthropicResponse.content;
    let textContent = '';
    const toolCalls: ToolCall[] = [];
    for (const block of contentBlocks) {
      if (block.type === 'text') { textContent += (block as AnthropicTextBlock).text; }
      else if (block.type === 'tool_use') {
        const toolUse = block as AnthropicToolUseBlock;
        toolCalls.push({ id: toolUse.id, type: 'function', function: { name: toolUse.name, arguments: JSON.stringify(toolUse.input) } });
      }
    }
    const message: ChatMessage = { role: 'assistant', content: textContent || null, ...(toolCalls.length > 0 && { tool_calls: toolCalls }) };
    return {
      id: anthropicResponse.id, model: anthropicResponse.model,
      choices: [{ index: 0, message, finish_reason: this.mapStopReason(anthropicResponse.stop_reason) }],
      ...(anthropicResponse.usage && {
      usage: { prompt_tokens: anthropicResponse.usage.input_tokens, completion_tokens: anthropicResponse.usage.output_tokens, total_tokens: anthropicResponse.usage.input_tokens + anthropicResponse.usage.output_tokens }
    }),
    };
  }

  private mapStopReason(stopReason: string | null): ChatResponse['choices'][0]['finish_reason'] {
    switch (stopReason) { case 'end_turn': case 'stop_sequence': return 'stop'; case 'max_tokens': return 'length'; case 'tool_use': return 'tool_calls'; default: return 'stop'; }
  }

  normalizeStreamChunk(raw: unknown): StreamChunk | null {
    if (!raw || typeof raw !== 'object') { return null; }
    const event = raw as AnthropicStreamEvent;
    switch (event.type) {
      case 'message_start': {
        const msgEvent = event as { type: 'message_start'; message: { id: string; model: string } };
        return { id: msgEvent.message.id, model: msgEvent.message.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] };
      }
      case 'content_block_start': {
        const startEvent = event as { type: 'content_block_start'; index: number; content_block: AnthropicContentBlock };
        if (startEvent.content_block.type === 'tool_use') {
          const toolBlock = startEvent.content_block as AnthropicToolUseBlock;
          return { id: '', model: '', choices: [{ index: 0, delta: { tool_calls: [{ index: startEvent.index, id: toolBlock.id, function: { name: toolBlock.name, arguments: '' } }] }, finish_reason: null }] };
        }
        return null;
      }
      case 'content_block_delta': {
        const deltaEvent = event as { type: 'content_block_delta'; index: number; delta: { type: 'text_delta'; text: string } | { type: 'input_json_delta'; partial_json: string } };
        const delta = deltaEvent.delta;
        if (delta.type === 'text_delta') { return { id: '', model: '', choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }] }; }
        else if (delta.type === 'input_json_delta') { return { id: '', model: '', choices: [{ index: 0, delta: { tool_calls: [{ index: deltaEvent.index, function: { arguments: delta.partial_json } }] }, finish_reason: null }] }; }
        return null;
      }
      case 'message_delta': {
        const msgDeltaEvent = event as { type: 'message_delta'; delta: { stop_reason: string | null } };
        if (msgDeltaEvent.delta.stop_reason) { return { id: '', model: '', choices: [{ index: 0, delta: {}, finish_reason: this.mapStopReason(msgDeltaEvent.delta.stop_reason) }] }; }
        return null;
      }
      default: return null;
    }
  }

  async *createStreamIterator(rawStream: AsyncIterable<unknown>): AsyncIterable<StreamChunk> {
    for await (const raw of rawStream) {
      const normalized = this.normalizeStreamChunk(raw);
      if (normalized !== null) { yield normalized; }
    }
  }

  mapError(error: unknown): GuruError {
    const errorResponse = error as AnthropicErrorResponse;
    if (!errorResponse?.error) { return new GuruError('Unknown Anthropic error', { code: 'UNKNOWN', provider: 'anthropic' }); }
    const { type, message } = errorResponse.error;
    const code = this.mapAnthropicErrorType(type);
    return new GuruError(message, { code, provider: 'anthropic', details: errorResponse.error });
  }

  private mapAnthropicErrorType(anthropicType: string): GuruError['code'] {
    switch (anthropicType) {
      case 'invalid_request_error': return 'INVALID_REQUEST';
      case 'authentication_error': case 'permission_error': return 'INVALID_API_KEY';
      case 'not_found_error': return 'INVALID_MODEL';
      case 'rate_limit_error': return 'RATE_LIMIT';
      case 'api_error': case 'overloaded_error': return 'NETWORK_ERROR';
      default: return 'UNKNOWN';
    }
  }

  normalizeToolDefinitions(tools: ToolDefinition[]): unknown {
    return tools.map((tool: ToolDefinition) => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters }));
  }

  supportsTools(): boolean { return true; }

  async request(endpoint: string, options: RequestInit & { body?: unknown }): Promise<Response> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', ...((options.headers as Record<string, string>) || {}) };
    const body = options.body ? JSON.stringify(options.body) : undefined;
    const fetchInit: RequestInit = { method: options.method, headers, signal: options.signal };
    if (body !== undefined) {
      fetchInit.body = body;
    }
    return fetch(url, fetchInit);
  }
}

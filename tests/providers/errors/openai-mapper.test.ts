import { describe, it, expect } from 'vitest';
import { mapOpenAIError } from '../../../src/providers/errors/openai-mapper.js';
import { ErrorCodes } from '../../../src/providers/types/errors.js';

describe('OpenAI Error Mapper', () => {
  it('maps 429 to RATE_LIMIT with retryable=true', () => {
    const error = { status: 429, message: 'Rate limit exceeded', code: 'rate_limit_exceeded' };
    const result = mapOpenAIError(error);

    expect(result.code).toBe(ErrorCodes.RATE_LIMIT);
    expect(result.provider).toBe('openai');
    expect(result.retryable).toBe(true);
    expect(result.statusCode).toBe(429);
  });

  it('maps 401 to INVALID_API_KEY with retryable=false', () => {
    const error = { status: 401, message: 'Invalid API key', code: 'invalid_api_key' };
    const result = mapOpenAIError(error);

    expect(result.code).toBe(ErrorCodes.INVALID_API_KEY);
    expect(result.provider).toBe('openai');
    expect(result.retryable).toBe(false);
    expect(result.statusCode).toBe(401);
  });

  it('maps 403 to INVALID_API_KEY with retryable=false', () => {
    const error = { status: 403, message: 'Permission denied', code: 'permission_denied' };
    const result = mapOpenAIError(error);

    expect(result.code).toBe(ErrorCodes.INVALID_API_KEY);
    expect(result.provider).toBe('openai');
    expect(result.retryable).toBe(false);
    expect(result.statusCode).toBe(403);
  });

  it('maps 404 to MODEL_NOT_FOUND with retryable=false', () => {
    const error = { status: 404, message: 'Model not found', code: 'model_not_found' };
    const result = mapOpenAIError(error);

    expect(result.code).toBe(ErrorCodes.MODEL_NOT_FOUND);
    expect(result.provider).toBe('openai');
    expect(result.retryable).toBe(false);
    expect(result.statusCode).toBe(404);
  });

  it('maps 413 to CONTEXT_LENGTH with retryable=false', () => {
    const error = { status: 413, message: 'Context length exceeded', code: 'context_length_exceeded' };
    const result = mapOpenAIError(error);

    expect(result.code).toBe(ErrorCodes.CONTEXT_LENGTH);
    expect(result.provider).toBe('openai');
    expect(result.retryable).toBe(false);
    expect(result.statusCode).toBe(413);
  });

  it('maps 400 with content_filter to CONTENT_FILTER with retryable=false', () => {
    const error = {
      status: 400,
      message: 'Content filtered by safety system',
      code: 'content_filter',
    };
    const result = mapOpenAIError(error);

    expect(result.code).toBe(ErrorCodes.CONTENT_FILTER);
    expect(result.provider).toBe('openai');
    expect(result.retryable).toBe(false);
    expect(result.statusCode).toBe(400);
  });

  it('maps network errors to NETWORK_ERROR with retryable=true', () => {
    const error = new TypeError('fetch failed');
    (error as any).code = 'ECONNREFUSED';
    const result = mapOpenAIError(error);

    expect(result.code).toBe(ErrorCodes.NETWORK_ERROR);
    expect(result.provider).toBe('openai');
    expect(result.retryable).toBe(true);
  });

  it('maps 500 to PROVIDER_UNAVAILABLE with retryable=true', () => {
    const error = { status: 500, message: 'Internal server error' };
    const result = mapOpenAIError(error);

    expect(result.code).toBe(ErrorCodes.PROVIDER_UNAVAILABLE);
    expect(result.provider).toBe('openai');
    expect(result.retryable).toBe(true);
    expect(result.statusCode).toBe(500);
  });

  it('maps unknown errors to UNKNOWN with retryable=false', () => {
    const error = { message: 'Something went wrong' };
    const result = mapOpenAIError(error);

    expect(result.code).toBe(ErrorCodes.UNKNOWN);
    expect(result.provider).toBe('openai');
    expect(result.retryable).toBe(false);
  });

  it('preserves original error details', () => {
    const error = {
      status: 429,
      message: 'Rate limit',
      code: 'rate_limit_exceeded',
      type: 'requests',
    };
    const result = mapOpenAIError(error);

    expect(result.details).toBeDefined();
    expect((result.details as any).code).toBe('rate_limit_exceeded');
  });

  it('extracts message from OpenAI error shape', () => {
    const error = {
      error: {
        message: 'You exceeded your current quota',
        type: 'insufficient_quota',
        code: 'insufficient_quota',
      },
    };
    const result = mapOpenAIError(error);

    expect(result.message).toContain('quota');
  });

  it('handles Error instances', () => {
    const error = new Error('Connection timeout');
    (error as any).code = 'ETIMEDOUT';
    const result = mapOpenAIError(error);

    expect(result.code).toBe(ErrorCodes.NETWORK_ERROR);
    expect(result.retryable).toBe(true);
  });

  it('detects content filter from message text', () => {
    const error = {
      status: 400,
      message: 'The response was filtered due to content safety policy',
    };
    const result = mapOpenAIError(error);

    expect(result.code).toBe(ErrorCodes.CONTENT_FILTER);
  });

  it('detects context length from error code', () => {
    const error = {
      status: 400,
      message: 'Maximum context length exceeded',
      code: 'context_length_exceeded',
    };
    const result = mapOpenAIError(error);

    expect(result.code).toBe(ErrorCodes.CONTEXT_LENGTH);
  });

  it('maps timeout errors to NETWORK_ERROR', () => {
    const error = new Error('Request timeout');
    (error as any).code = 'ETIMEDOUT';
    const result = mapOpenAIError(error);

    expect(result.code).toBe(ErrorCodes.NETWORK_ERROR);
    expect(result.retryable).toBe(true);
  });

  it('maps connection refused to NETWORK_ERROR', () => {
    const error = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:443' };
    const result = mapOpenAIError(error);

    expect(result.code).toBe(ErrorCodes.NETWORK_ERROR);
    expect(result.retryable).toBe(true);
  });
});

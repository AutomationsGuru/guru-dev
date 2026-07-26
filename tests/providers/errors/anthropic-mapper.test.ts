import { describe, it, expect } from 'vitest';
import { mapAnthropicError } from '../../../src/providers/errors/anthropic-mapper.js';
import { GuruError } from '../../../src/providers/types/errors.js';

describe('mapAnthropicError', () => {
  it('maps rate_limit_error to RATE_LIMIT with retryable true', () => {
    const error = {
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: 'Rate limit exceeded. Please try again later.',
      },
      status: 429,
    };

    const result = mapAnthropicError(error);

    expect(result).toBeInstanceOf(GuruError);
    expect(result.code).toBe('RATE_LIMIT');
    expect(result.provider).toBe('anthropic');
    expect(result.retryable).toBe(true);
    expect(result.statusCode).toBe(429);
    expect(result.message).toContain('Rate limit');
  });

  it('maps authentication_error to INVALID_API_KEY with retryable false', () => {
    const error = {
      type: 'error',
      error: {
        type: 'authentication_error',
        message: 'Invalid API key provided',
      },
      status: 401,
    };

    const result = mapAnthropicError(error);

    expect(result).toBeInstanceOf(GuruError);
    expect(result.code).toBe('INVALID_API_KEY');
    expect(result.provider).toBe('anthropic');
    expect(result.retryable).toBe(false);
    expect(result.statusCode).toBe(401);
    expect(result.message).toContain('API key');
  });

  it('maps permission_error to INVALID_API_KEY with retryable false', () => {
    const error = {
      type: 'error',
      error: {
        type: 'permission_error',
        message: 'Insufficient permissions',
      },
      status: 403,
    };

    const result = mapAnthropicError(error);

    expect(result).toBeInstanceOf(GuruError);
    expect(result.code).toBe('INVALID_API_KEY');
    expect(result.provider).toBe('anthropic');
    expect(result.retryable).toBe(false);
    expect(result.statusCode).toBe(403);
  });

  it('maps invalid_request_error with model in message to MODEL_NOT_FOUND', () => {
    const error = {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'model: claude-3-foo is not a valid model ID',
      },
      status: 400,
    };

    const result = mapAnthropicError(error);

    expect(result).toBeInstanceOf(GuruError);
    expect(result.code).toBe('MODEL_NOT_FOUND');
    expect(result.provider).toBe('anthropic');
    expect(result.retryable).toBe(false);
    expect(result.statusCode).toBe(400);
    expect(result.message).toContain('valid model');
    expect(result.details?.originalErrorType).toBe('invalid_request_error');
  });

  it('maps invalid_request_error with context/token/length in message to CONTEXT_LENGTH', () => {
    const error = {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'prompt is too long: 150000 tokens > 100000 maximum context length',
      },
      status: 400,
    };

    const result = mapAnthropicError(error);

    expect(result).toBeInstanceOf(GuruError);
    expect(result.code).toBe('CONTEXT_LENGTH');
    expect(result.provider).toBe('anthropic');
    expect(result.retryable).toBe(false);
    expect(result.statusCode).toBe(400);
    expect(result.message).toContain('too long');
  });

  it('maps content_filter type to CONTENT_FILTER with retryable false', () => {
    const error = {
      type: 'error',
      error: {
        type: 'content_filter',
        message: 'Content violates safety policies',
      },
      status: 400,
    };

    const result = mapAnthropicError(error);

    expect(result).toBeInstanceOf(GuruError);
    expect(result.code).toBe('CONTENT_FILTER');
    expect(result.provider).toBe('anthropic');
    expect(result.retryable).toBe(false);
    expect(result.statusCode).toBe(400);
    expect(result.message).toContain('violates safety');
    expect(result.details?.anthropicErrorType).toBe('content_filter');
  });

  it('maps invalid_request_error with safety signals to CONTENT_FILTER', () => {
    const error = {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'Request blocked due to safety filter violation',
      },
      status: 400,
    };

    const result = mapAnthropicError(error);

    expect(result).toBeInstanceOf(GuruError);
    expect(result.code).toBe('CONTENT_FILTER');
    expect(result.provider).toBe('anthropic');
    expect(result.retryable).toBe(false);
    expect(result.message).toContain('safety filter');
  });

  it('maps network error with fetch failure to NETWORK_ERROR with retryable true', () => {
    const error = new TypeError('Failed to fetch');

    const result = mapAnthropicError(error);

    expect(result).toBeInstanceOf(GuruError);
    expect(result.code).toBe('NETWORK_ERROR');
    expect(result.provider).toBe('anthropic');
    expect(result.retryable).toBe(true);
    expect(result.message).toContain('fetch');
  });

  it('maps network error with ECONNREFUSED to NETWORK_ERROR with retryable true', () => {
    const error = {
      code: 'ECONNREFUSED',
      message: 'connect ECONNREFUSED 1.2.3.4:443',
    };

    const result = mapAnthropicError(error);

    expect(result).toBeInstanceOf(GuruError);
    expect(result.code).toBe('NETWORK_ERROR');
    expect(result.provider).toBe('anthropic');
    expect(result.retryable).toBe(true);
    expect(result.message).toContain('ECONNREFUSED');
  });

  it('maps timeout errors to NETWORK_ERROR', () => {
    const error = {
      code: 'ETIMEDOUT',
      message: 'Request timed out',
    };

    const result = mapAnthropicError(error);

    expect(result).toBeInstanceOf(GuruError);
    expect(result.code).toBe('NETWORK_ERROR');
    expect(result.provider).toBe('anthropic');
    expect(result.retryable).toBe(true);
  });

  it('maps unknown error to UNKNOWN with retryable false', () => {
    const error = {
      type: 'error',
      error: {
        type: 'api_error',
        message: 'Server is overloaded',
      },
      status: 500,
    };

    const result = mapAnthropicError(error);

    expect(result).toBeInstanceOf(GuruError);
    expect(result.code).toBe('UNKNOWN');
    expect(result.provider).toBe('anthropic');
    expect(result.retryable).toBe(false);
    expect(result.statusCode).toBe(500);
    expect(result.message).toContain('overloaded');
  });

  it('maps null/undefined to UNKNOWN error', () => {
    const result = mapAnthropicError(null);

    expect(result).toBeInstanceOf(GuruError);
    expect(result.code).toBe('UNKNOWN');
    expect(result.provider).toBe('anthropic');
    expect(result.retryable).toBe(false);
  });

  it('returns GuruError as-is if already mapped', () => {
    const original = new GuruError({
      code: 'RATE_LIMIT',
      message: 'Already mapped',
      provider: 'anthropic',
      retryable: true,
      statusCode: 429,
    });

    const result = mapAnthropicError(original);

    expect(result).toBe(original); // same instance
  });

  it('preserves original error in cause for network errors', () => {
    const originalError = new Error('Connection failed');
    const result = mapAnthropicError(originalError);

    expect(result.cause).toBe(originalError);
  });

  it('extracts HTTP status from response.status', () => {
    const error = {
      error: {
        type: 'rate_limit_error',
        message: 'Too many requests',
      },
      response: {
        status: 429,
      },
    };

    const result = mapAnthropicError(error);

    expect(result.statusCode).toBe(429);
    expect(result.code).toBe('RATE_LIMIT');
  });
});

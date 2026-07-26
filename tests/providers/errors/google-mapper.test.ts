import { describe, it, expect } from 'vitest';
import { mapGoogleError } from '../../../src/providers/errors/google-mapper.js';
import { ErrorCodes } from '../../../src/providers/types/errors.js';

describe('mapGoogleError', () => {
  it('maps RESOURCE_EXHAUSTED status to RATE_LIMIT with retryable true', () => {
    const error = {
      error: {
        code: 429,
        message: 'Resource has been exhausted (e.g. check quota).',
        status: 'RESOURCE_EXHAUSTED',
      },
    };

    const err = mapGoogleError(error);

    expect(err.code).toBe(ErrorCodes.RATE_LIMIT);
    expect(err.provider).toBe('google');
    expect(err.retryable).toBe(true);
    expect(err.statusCode).toBe(429);
    expect(err.message).toContain('Resource has been exhausted');
  });

  it('maps HTTP 429 to RATE_LIMIT', () => {
    const error = { error: { code: 429, message: 'Quota exceeded', status: 'TOO_MANY_REQUESTS' } };

    const err = mapGoogleError(error);

    expect(err.code).toBe(ErrorCodes.RATE_LIMIT);
    expect(err.retryable).toBe(true);
    expect(err.statusCode).toBe(429);
  });

  it('maps UNAUTHENTICATED status to INVALID_API_KEY', () => {
    const error = {
      error: {
        code: 401,
        message: 'Request is missing required authentication credential.',
        status: 'UNAUTHENTICATED',
      },
    };

    const err = mapGoogleError(error);

    expect(err.code).toBe(ErrorCodes.INVALID_API_KEY);
    expect(err.provider).toBe('google');
    expect(err.retryable).toBe(false);
    expect(err.statusCode).toBe(401);
  });

  it('maps HTTP 401 to INVALID_API_KEY', () => {
    const error = { error: { code: 401, message: 'Invalid API key', status: 'UNAUTHENTICATED' } };

    const err = mapGoogleError(error);

    expect(err.code).toBe(ErrorCodes.INVALID_API_KEY);
    expect(err.statusCode).toBe(401);
    expect(err.retryable).toBe(false);
  });

  it('maps PERMISSION_DENIED to INVALID_API_KEY', () => {
    const error = {
      error: {
        code: 403,
        message: 'The caller does not have permission',
        status: 'PERMISSION_DENIED',
      },
    };

    const err = mapGoogleError(error);

    expect(err.code).toBe(ErrorCodes.INVALID_API_KEY);
    expect(err.provider).toBe('google');
    expect(err.retryable).toBe(false);
    expect(err.statusCode).toBe(403);
  });

  it('maps NOT_FOUND with model in message to MODEL_NOT_FOUND', () => {
    const error = {
      error: {
        code: 404,
        message: 'models/gemini-pro is not found',
        status: 'NOT_FOUND',
      },
    };

    const err = mapGoogleError(error);

    expect(err.code).toBe(ErrorCodes.MODEL_NOT_FOUND);
    expect(err.provider).toBe('google');
    expect(err.retryable).toBe(false);
    expect(err.statusCode).toBe(404);
  });

  it('maps NOT_FOUND with models in details to MODEL_NOT_FOUND', () => {
    const error = {
      error: {
        code: 404,
        message: 'Resource not found',
        status: 'NOT_FOUND',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ResourceInfo', resourceName: 'models/unknown' }],
      },
    };

    const err = mapGoogleError(error);

    expect(err.code).toBe(ErrorCodes.MODEL_NOT_FOUND);
    expect(err.statusCode).toBe(404);
  });

  it('maps INVALID_ARGUMENT with context too long to CONTEXT_LENGTH', () => {
    const error = {
      error: {
        code: 400,
        message: 'The input token count (150000) exceeds the maximum context length (128000)',
        status: 'INVALID_ARGUMENT',
      },
    };

    const err = mapGoogleError(error);

    expect(err.code).toBe(ErrorCodes.CONTEXT_LENGTH);
    expect(err.provider).toBe('google');
    expect(err.retryable).toBe(false);
    // statusCode not set for CONTEXT_LENGTH per some mappings
    expect(err.statusCode).toBeUndefined();
  });

  it('maps INVALID_ARGUMENT with prompt too long to CONTEXT_LENGTH', () => {
    const error = {
      error: {
        code: 400,
        message: 'Prompt exceeds maximum length',
        status: 'INVALID_ARGUMENT',
      },
    };

    const err = mapGoogleError(error);

    expect(err.code).toBe(ErrorCodes.CONTEXT_LENGTH);
    expect(err.retryable).toBe(false);
  });

  it('maps INVALID_ARGUMENT without context hint falls to UNKNOWN', () => {
    const error = {
      error: {
        code: 400,
        message: 'Invalid argument: some other issue',
        status: 'INVALID_ARGUMENT',
      },
    };

    const err = mapGoogleError(error);

    expect(err.code).toBe(ErrorCodes.UNKNOWN);
    expect(err.retryable).toBe(false);
  });

  it('maps FAILED_PRECONDITION with safety to CONTENT_FILTER', () => {
    const error = {
      error: {
        code: 400,
        message: 'The response was blocked due to safety settings',
        status: 'FAILED_PRECONDITION',
      },
    };

    const err = mapGoogleError(error);

    expect(err.code).toBe(ErrorCodes.CONTENT_FILTER);
    expect(err.provider).toBe('google');
    expect(err.retryable).toBe(false);
    expect(err.statusCode).toBe(400);
  });

  it('maps FAILED_PRECONDITION with content filter in details to CONTENT_FILTER', () => {
    const error = {
      error: {
        code: 400,
        message: 'Request blocked',
        status: 'FAILED_PRECONDITION',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.PreconditionFailure',
            violations: [{ type: 'safety', description: 'Content filter triggered' }],
          },
        ],
      },
    };

    const err = mapGoogleError(error);

    expect(err.code).toBe(ErrorCodes.CONTENT_FILTER);
    expect(err.statusCode).toBe(400);
  });

  it('maps network/fetch error to NETWORK_ERROR with retryable true', () => {
    const error = new TypeError('Failed to fetch');

    const err = mapGoogleError(error);

    expect(err.code).toBe(ErrorCodes.NETWORK_ERROR);
    expect(err.provider).toBe('google');
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('Failed to fetch');
    // statusCode typically not set for network errors
    expect(err.statusCode).toBeUndefined();
  });

  it('maps unknown error to UNKNOWN with retryable false', () => {
    const unknownErr = { code: 418, message: 'Unknown error status' };
    const err = mapGoogleError(unknownErr);

    expect(err.code).toBe(ErrorCodes.UNKNOWN);
    expect(err.provider).toBe('google');
    expect(err.retryable).toBe(false);
    expect(err.statusCode).toBe(418);
    expect(err.message).toContain('Unknown error status');
  });

  it('maps null/undefined to UNKNOWN', () => {
    const err = mapGoogleError(null);

    expect(err.code).toBe(ErrorCodes.UNKNOWN);
    expect(err.provider).toBe('google');
    expect(err.retryable).toBe(false);
  });

  it('preserves original error details in GuruError.details', () => {
    const originalError = {
      error: {
        code: 429,
        message: 'Quota exceeded',
        status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure' }],
      },
    };

    const result = mapGoogleError(originalError);

    expect(result.details).toEqual(originalError.error.details);
  });

  it('handles nested error shape from SDK response (response.data.error)', () => {
    const error = {
      response: {
        data: {
          error: {
            code: 401,
            message: 'API key not valid',
            status: 'UNAUTHENTICATED',
          },
        },
      },
    };

    const result = mapGoogleError(error);

    expect(result.code).toBe(ErrorCodes.INVALID_API_KEY);
    expect(result.provider).toBe('google');
    expect(result.retryable).toBe(false);
    expect(result.statusCode).toBe(401);
  });
});

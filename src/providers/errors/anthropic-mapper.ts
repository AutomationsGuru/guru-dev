import { GuruError, ErrorCodes } from '../types/errors';

export function mapAnthropicError(error: unknown): GuruError {
  // Passthrough if already a GuruError
  if (error instanceof GuruError) {
    return error;
  }

  let errorType: string | undefined;
  let errorMessage = '';
  let statusCode: number | undefined;

  if (error && typeof error === 'object') {
    const err = error as Record<string, unknown>;

    // Handle Anthropic API error response shape: { type: 'error', error: { type, message } }
    if (err.type === 'error' && err.error && typeof err.error === 'object') {
      const innerError = err.error as Record<string, unknown>;
      errorType = typeof innerError.type === 'string' ? innerError.type : undefined;
      errorMessage = typeof innerError.message === 'string' ? innerError.message : '';
      statusCode = typeof err.status === 'number' ? err.status : (typeof err.statusCode === 'number' ? err.statusCode : undefined);
    } else if (typeof err.type === 'string' && typeof err.message === 'string') {
      // Direct error object with .type and .message properties
      errorType = err.type;
      errorMessage = err.message;
      statusCode = typeof err.status === 'number' ? err.status : (typeof err.statusCode === 'number' ? err.statusCode : undefined);
    } else if (err.response && typeof err.response === 'object') {
      // Handle axios-like or fetch response errors
      const response = err.response as Record<string, unknown>;
      statusCode = typeof response.status === 'number' ? response.status : undefined;
      const data = response.data as Record<string, unknown> | undefined;
      if (data?.error && typeof data.error === 'object') {
        const apiError = data.error as Record<string, unknown>;
        errorType = typeof apiError.type === 'string' ? apiError.type : undefined;
        errorMessage = typeof apiError.message === 'string' ? apiError.message : '';
      } else if (typeof data?.message === 'string') {
        errorMessage = data.message;
      }
    } else if (err.code || err.message) {
      // Network or generic Error object
      errorMessage = typeof err.message === 'string' ? err.message : String(error);
      const code = typeof err.code === 'string' ? err.code : '';
      if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET'].includes(code) ||
          /fetch failed|network error|connection refused|ECONN/i.test(errorMessage)) {
        return new GuruError('Network error connecting to Anthropic', {
          code: ErrorCodes.NETWORK_ERROR,
          provider: 'anthropic',
          retryable: true,
          statusCode: 0,
          details: { originalError: error }
        });
      }
    }
  } else if (typeof error === 'string') {
    errorMessage = error;
  } else {
    errorMessage = String(error);
  }

  const lowerMessage = errorMessage.toLowerCase();

  // Infer errorType from message if not set (for string/direct inputs)
  if (!errorType) {
    if (lowerMessage.includes('rate limit') || lowerMessage.includes('too many requests')) {
      errorType = 'rate_limit_error';
    } else if (lowerMessage.includes('authentication') || lowerMessage.includes('invalid api key') || lowerMessage.includes('api key')) {
      errorType = 'authentication_error';
    } else if (lowerMessage.includes('permission')) {
      errorType = 'permission_error';
    } else if (lowerMessage.includes('content filter') || lowerMessage.includes('safety') || lowerMessage.includes('blocked')) {
      errorType = 'content_filter';
    } else if (lowerMessage.includes('model') || lowerMessage.includes('not found')) {
      errorType = 'invalid_request_error';
    } else if (lowerMessage.includes('context') || lowerMessage.includes('token') || lowerMessage.includes('length') || lowerMessage.includes('maximum')) {
      errorType = 'invalid_request_error';
    }
  }

  // Map based on errorType and message signals, using descriptive messages for GuruError
  if (errorType === 'rate_limit_error' || lowerMessage.includes('rate limit') || lowerMessage.includes('too many requests')) {
    return new GuruError('Rate limit exceeded for Anthropic API', {
      code: ErrorCodes.RATE_LIMIT,
      provider: 'anthropic',
      retryable: true,
      statusCode: statusCode || 429,
      details: { originalError: error, anthropicErrorType: errorType || 'rate_limit_error' }
    });
  }

  if (errorType === 'authentication_error' || errorType === 'permission_error' ||
      lowerMessage.includes('authentication') || lowerMessage.includes('api key') || lowerMessage.includes('permission')) {
    const code = errorType === 'authentication_error' ? 401 : 403;
    return new GuruError('Invalid API key or insufficient permissions for Anthropic', {
      code: ErrorCodes.INVALID_API_KEY,
      provider: 'anthropic',
      retryable: false,
      statusCode: statusCode || code,
      details: { originalError: error, anthropicErrorType: errorType }
    });
  }

  if (errorType === 'invalid_request_error') {
    if (lowerMessage.includes('model') || lowerMessage.includes('not found')) {
      return new GuruError('Model not found', {
        code: ErrorCodes.MODEL_NOT_FOUND,
        provider: 'anthropic',
        retryable: false,
        statusCode: statusCode || 400,
        details: { originalError: error, anthropicErrorType: errorType }
      });
    }
    if (lowerMessage.includes('context') || lowerMessage.includes('token') || lowerMessage.includes('length') ||
        lowerMessage.includes('maximum') || lowerMessage.includes('exceeded')) {
      return new GuruError('Context length exceeded', {
        code: ErrorCodes.CONTEXT_LENGTH,
        provider: 'anthropic',
        retryable: false,
        statusCode: statusCode || 400,
        details: { originalError: error, anthropicErrorType: errorType }
      });
    }
    if (lowerMessage.includes('safety') || lowerMessage.includes('content filter') || lowerMessage.includes('blocked')) {
      return new GuruError('Content filtered by safety policy', {
        code: ErrorCodes.CONTENT_FILTER,
        provider: 'anthropic',
        retryable: false,
        statusCode: statusCode || 400,
        details: { originalError: error, anthropicErrorType: errorType }
      });
    }
    // Fallback for other invalid_request_error
    return new GuruError(errorMessage || 'Invalid request to Anthropic API', {
      code: ErrorCodes.UNKNOWN,
      provider: 'anthropic',
      retryable: false,
      statusCode: statusCode || 400,
      details: { originalError: error, anthropicErrorType: errorType }
    });
  }

  if (errorType === 'content_filter' || lowerMessage.includes('content filter') || lowerMessage.includes('safety') || lowerMessage.includes('blocked')) {
    return new GuruError('Content filtered by safety policy', {
      code: ErrorCodes.CONTENT_FILTER,
      provider: 'anthropic',
      retryable: false,
      statusCode: statusCode || 400,
      details: { originalError: error, anthropicErrorType: errorType || 'content_filter' }
    });
  }

  // Final network check for unclassified errors
  if (error && typeof error === 'object') {
    const err = error as Record<string, unknown>;
    const code = typeof err.code === 'string' ? err.code : '';
    if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET'].includes(code) ||
        /network|fetch failed|connection/i.test(errorMessage)) {
      return new GuruError('Network error connecting to Anthropic', {
        code: ErrorCodes.NETWORK_ERROR,
        provider: 'anthropic',
        retryable: true,
        statusCode: 0,
        details: { originalError: error }
      });
    }
  }

  // Default to unknown
  return new GuruError('Unknown Anthropic error', {
    code: ErrorCodes.UNKNOWN,
    provider: 'anthropic',
    retryable: false,
    statusCode: statusCode || 500,
    details: { originalError: error }
  });
}

/**
 * GuruError - Normalized error class for provider errors.
 *
 * All provider error mappers return GuruError instances for consistent
 * error handling across OpenAI, Anthropic, Google, and other providers.
 */

import { ErrorCodes, type ErrorCode } from './codes.js';

export interface GuruErrorOptions {
  code: ErrorCode;
  provider: string;
  statusCode?: number;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export class GuruError extends Error {
  code: ErrorCode;
  provider: string;
  statusCode?: number;
  retryable: boolean;
  details?: Record<string, unknown>;

  constructor(message: string, options: GuruErrorOptions) {
    super(message);
    this.name = 'GuruError';
    this.code = options.code;
    this.provider = options.provider;
    this.statusCode = options.statusCode;
    this.retryable = options.retryable ?? false;
    this.details = options.details;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, GuruError);
    }
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      provider: this.provider,
      statusCode: this.statusCode,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

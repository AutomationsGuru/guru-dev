import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../../src/loop/retryMiddleware.js';

describe('withRetry', () => {
  it('should return result if action succeeds on first try', async () => {
    const action = vi.fn().mockResolvedValue('success');
    const retryableAction = withRetry(action, {
      maxRetries: 2,
      isTransient: () => true,
    });

    const result = await retryableAction();
    expect(result).toBe('success');
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('should retry and succeed after failures', async () => {
    const error = new Error('Transient Error');
    const action = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValue('success');
    const retryableAction = withRetry(action, {
      maxRetries: 3,
      isTransient: (e) => e.message === 'Transient Error',
    });

    const result = await retryableAction();
    expect(result).toBe('success');
    expect(action).toHaveBeenCalledTimes(3);
  });

  it('should throw if max retries is exhausted', async () => {
    const error = new Error('Transient Error');
    const action = vi.fn().mockRejectedValue(error);
    const retryableAction = withRetry(action, {
      maxRetries: 2,
      isTransient: (e) => e.message === 'Transient Error',
    });

    await expect(retryableAction()).rejects.toThrow('Transient Error');
    expect(action).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('should throw immediately if error is not transient', async () => {
    const transientError = new Error('Transient Error');
    const fatalError = new Error('Fatal Error');

    const action = vi
      .fn()
      .mockRejectedValueOnce(transientError)
      .mockRejectedValueOnce(fatalError)
      .mockResolvedValue('success');

    const retryableAction = withRetry(action, {
      maxRetries: 3,
      isTransient: (e) => e.message === 'Transient Error',
    });

    await expect(retryableAction()).rejects.toThrow('Fatal Error');
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('should handle non-Error objects thrown by throwing immediately', async () => {
    const action = vi.fn().mockRejectedValue('String error');
    const retryableAction = withRetry(action, {
      maxRetries: 2,
      isTransient: () => true,
    });

    await expect(retryableAction()).rejects.toBe('String error');
    expect(action).toHaveBeenCalledTimes(1);
  });
});

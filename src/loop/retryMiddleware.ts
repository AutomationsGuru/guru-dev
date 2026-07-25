export interface RetryOptions {
  maxRetries: number;
  isTransient: (error: Error) => boolean;
}

export function withRetry<T>(
  action: () => Promise<T>,
  options: RetryOptions
): () => Promise<T> {
  const { maxRetries, isTransient } = options;

  return async () => {
    let attempt = 0;
    while (true) {
      try {
        return await action();
      } catch (error) {
        if (
          attempt >= maxRetries ||
          !(error instanceof Error) ||
          !isTransient(error)
        ) {
          throw error;
        }
        attempt++;
      }
    }
  };
}

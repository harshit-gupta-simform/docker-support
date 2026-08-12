import {
  RateLimitEmbeddingProviderError,
  TransientEmbeddingProviderError,
} from './embedding.errors';

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  let attempt = 0;

  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;

      if (
        !(err instanceof TransientEmbeddingProviderError) ||
        attempt >= options.maxAttempts
      ) {
        throw err;
      }

      const retryAfterMs =
        err instanceof RateLimitEmbeddingProviderError
          ? err.retryAfterMs
          : null;
      const backoff = Math.min(
        options.baseDelayMs * 2 ** (attempt - 1),
        options.maxDelayMs,
      );

      await sleep(retryAfterMs ?? backoff);
    }
  }
}

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  isRetryable: (err: unknown) => boolean;
  getRetryAfterMs?: (err: unknown) => number | null;
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

      if (!options.isRetryable(err) || attempt >= options.maxAttempts) {
        throw err;
      }

      const retryAfterMs = options.getRetryAfterMs?.(err) ?? null;

      // A provider's stated wait time is honored close to verbatim (just
      // clamped to our own ceiling) — never jittered, since it isn't a
      // guess we're making, it's what the provider told us to do.
      if (retryAfterMs !== null) {
        await sleep(Math.min(retryAfterMs, options.maxDelayMs));
        continue;
      }

      const backoff = Math.min(
        options.baseDelayMs * 2 ** (attempt - 1),
        options.maxDelayMs,
      );
      // Jitter to 0.5x-1.0x of the computed value to avoid thundering-herd
      // retries across concurrent batches.
      const jitteredBackoff = backoff * (0.5 + Math.random() * 0.5);

      await sleep(jitteredBackoff);
    }
  }
}

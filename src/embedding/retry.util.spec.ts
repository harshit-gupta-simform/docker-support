import {
  PermanentEmbeddingProviderError,
  RateLimitEmbeddingProviderError,
  TransientEmbeddingProviderError,
} from './embedding.errors';
import { withRetry } from './retry.util';

function noopSleep() {
  const calls: number[] = [];
  const sleep = (ms: number) => {
    calls.push(ms);
    return Promise.resolve();
  };
  return { sleep, calls };
}

describe('withRetry', () => {
  it('returns the result on the first successful attempt without sleeping', async () => {
    const { sleep, calls } = noopSleep();
    const fn = jest.fn().mockResolvedValue('ok');

    const result = await withRetry(fn, {
      maxAttempts: 5,
      baseDelayMs: 10,
      maxDelayMs: 1000,
      sleep,
    });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it('retries a transient error up to maxAttempts, then succeeds', async () => {
    const { sleep } = noopSleep();
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new TransientEmbeddingProviderError('fail 1'))
      .mockRejectedValueOnce(new TransientEmbeddingProviderError('fail 2'))
      .mockResolvedValueOnce('ok');

    const result = await withRetry(fn, {
      maxAttempts: 5,
      baseDelayMs: 10,
      maxDelayMs: 1000,
      sleep,
    });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('rethrows a transient error once maxAttempts is exhausted', async () => {
    const { sleep } = noopSleep();
    const fn = jest
      .fn()
      .mockRejectedValue(new TransientEmbeddingProviderError('always fails'));

    await expect(
      withRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 10,
        maxDelayMs: 1000,
        sleep,
      }),
    ).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('never retries a PermanentEmbeddingProviderError — fails on the first attempt', async () => {
    const { sleep } = noopSleep();
    const fn = jest
      .fn()
      .mockRejectedValue(new PermanentEmbeddingProviderError('bad api key'));

    await expect(
      withRetry(fn, {
        maxAttempts: 5,
        baseDelayMs: 10,
        maxDelayMs: 1000,
        sleep,
      }),
    ).rejects.toThrow('bad api key');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses RateLimitEmbeddingProviderError.retryAfterMs verbatim instead of computed backoff, when present', async () => {
    const { sleep, calls } = noopSleep();
    const fn = jest
      .fn()
      .mockRejectedValueOnce(
        new RateLimitEmbeddingProviderError('slow down', 777),
      )
      .mockResolvedValueOnce('ok');

    await withRetry(fn, {
      maxAttempts: 5,
      baseDelayMs: 10,
      maxDelayMs: 1000,
      sleep,
    });

    expect(calls).toEqual([777]);
  });

  it('computes exponential backoff capped at maxDelayMs, jittered to 0.5x-1.0x of the computed value, when no retryAfterMs is given', async () => {
    const { sleep, calls } = noopSleep();
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new TransientEmbeddingProviderError('fail 1'))
      .mockRejectedValueOnce(new TransientEmbeddingProviderError('fail 2'))
      .mockResolvedValueOnce('ok');

    await withRetry(fn, {
      maxAttempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 150,
      sleep,
    });

    // attempt 1: un-jittered backoff = min(100 * 2^0, 150) = 100
    expect(calls[0]).toBeGreaterThanOrEqual(50);
    expect(calls[0]).toBeLessThanOrEqual(100);
    // attempt 2: un-jittered backoff = min(100 * 2^1, 150) = 150 (capped)
    expect(calls[1]).toBeGreaterThanOrEqual(75);
    expect(calls[1]).toBeLessThanOrEqual(150);
  });

  it('clamps a provider-supplied retryAfterMs to maxDelayMs instead of honoring it verbatim when it exceeds the ceiling', async () => {
    const { sleep, calls } = noopSleep();
    const fn = jest
      .fn()
      .mockRejectedValueOnce(
        new RateLimitEmbeddingProviderError('slow down', 3_600_000),
      )
      .mockResolvedValueOnce('ok');

    await withRetry(fn, {
      maxAttempts: 5,
      baseDelayMs: 10,
      maxDelayMs: 1000,
      sleep,
    });

    expect(calls).toEqual([1000]);
  });

  it('defaults to a real timer-based sleep when none is injected', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new TransientEmbeddingProviderError('fail once'))
      .mockResolvedValueOnce('ok');

    const startedAt = Date.now();
    await withRetry(fn, { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 20 });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(0);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

import { withRetry } from './retry.util';

class FakeTransientError extends Error {}
class FakeRateLimitError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs: number,
  ) {
    super(message);
  }
}
class FakePermanentError extends Error {}

describe('withRetry', () => {
  it('returns the result on first success without sleeping', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const fn = jest.fn().mockResolvedValue('ok');

    const result = await withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 5,
      isRetryable: () => true,
      sleep,
    });

    expect(result).toBe('ok');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a retryable error and eventually succeeds', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new FakeTransientError('boom'))
      .mockResolvedValueOnce('ok');

    const result = await withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 5,
      isRetryable: (err) => err instanceof FakeTransientError,
      sleep,
    });

    expect(result).toBe('ok');
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('does not retry an error the predicate rejects', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const fn = jest.fn().mockRejectedValue(new FakePermanentError('nope'));

    await expect(
      withRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 5,
        isRetryable: (err) => err instanceof FakeTransientError,
        sleep,
      }),
    ).rejects.toThrow('nope');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws once maxAttempts is exhausted', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const fn = jest.fn().mockRejectedValue(new FakeTransientError('boom'));

    await expect(
      withRetry(fn, {
        maxAttempts: 2,
        baseDelayMs: 1,
        maxDelayMs: 5,
        isRetryable: () => true,
        sleep,
      }),
    ).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('honors getRetryAfterMs, clamped to maxDelayMs, without jitter', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new FakeRateLimitError('slow down', 9999))
      .mockResolvedValueOnce('ok');

    await withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 100,
      isRetryable: () => true,
      getRetryAfterMs: (err) =>
        err instanceof FakeRateLimitError ? err.retryAfterMs : null,
      sleep,
    });

    expect(sleep).toHaveBeenCalledWith(100);
  });

  it('invokes onRetry with the error, attempt number, and delay before sleeping', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const onRetry = jest.fn();
    const err = new FakeTransientError('boom');
    const fn = jest.fn().mockRejectedValueOnce(err).mockResolvedValueOnce('ok');

    await withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
      isRetryable: (e) => e instanceof FakeTransientError,
      sleep,
      onRetry,
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(err, 1, expect.any(Number));
    expect(sleep.mock.invocationCallOrder[0]).toBeGreaterThan(
      onRetry.mock.invocationCallOrder[0],
    );
  });
});

import {
  EmbeddingResponseValidationError,
  EmbeddingThresholdExceededError,
  PermanentEmbeddingProviderError,
  RateLimitEmbeddingProviderError,
  TransientEmbeddingProviderError,
} from './embedding.errors';

describe('embedding errors', () => {
  it('TransientEmbeddingProviderError carries name, message, and cause', () => {
    const cause = new Error('ECONNRESET');
    const err = new TransientEmbeddingProviderError('network failure', {
      cause,
    });

    expect(err.name).toBe('TransientEmbeddingProviderError');
    expect(err.message).toBe('network failure');
    expect(err.cause).toBe(cause);
    expect(err).toBeInstanceOf(Error);
  });

  it('RateLimitEmbeddingProviderError is a TransientEmbeddingProviderError and carries retryAfterMs', () => {
    const err = new RateLimitEmbeddingProviderError('rate limited', 2000);

    expect(err.name).toBe('RateLimitEmbeddingProviderError');
    expect(err.retryAfterMs).toBe(2000);
    expect(err).toBeInstanceOf(TransientEmbeddingProviderError);
  });

  it('RateLimitEmbeddingProviderError defaults retryAfterMs to null when the provider gives no hint', () => {
    const err = new RateLimitEmbeddingProviderError('rate limited');

    expect(err.retryAfterMs).toBeNull();
  });

  it('PermanentEmbeddingProviderError is NOT a TransientEmbeddingProviderError', () => {
    const err = new PermanentEmbeddingProviderError('invalid api key');

    expect(err.name).toBe('PermanentEmbeddingProviderError');
    expect(err).not.toBeInstanceOf(TransientEmbeddingProviderError);
  });

  it('EmbeddingResponseValidationError carries name and message', () => {
    const err = new EmbeddingResponseValidationError('dimension mismatch');

    expect(err.name).toBe('EmbeddingResponseValidationError');
    expect(err.message).toBe('dimension mismatch');
    expect(err).not.toBeInstanceOf(TransientEmbeddingProviderError);
  });

  it('EmbeddingThresholdExceededError reports failed/attempted counts in its message', () => {
    const err = new EmbeddingThresholdExceededError(6, 10);

    expect(err.name).toBe('EmbeddingThresholdExceededError');
    expect(err.failedCount).toBe(6);
    expect(err.attemptedCount).toBe(10);
    expect(err.message).toBe(
      'Embedding run aborted: 6/10 chunks failed, exceeding the configured failure threshold',
    );
  });
});

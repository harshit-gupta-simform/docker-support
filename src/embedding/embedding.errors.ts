export class TransientEmbeddingProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransientEmbeddingProviderError';
  }
}

export class RateLimitEmbeddingProviderError extends TransientEmbeddingProviderError {
  public readonly retryAfterMs: number | null;

  constructor(message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = 'RateLimitEmbeddingProviderError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class PermanentEmbeddingProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentEmbeddingProviderError';
  }
}

export class EmbeddingResponseValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingResponseValidationError';
  }
}

export class EmbeddingThresholdExceededError extends Error {
  constructor(
    public readonly failedCount: number,
    public readonly attemptedCount: number,
  ) {
    super(
      `Embedding run aborted: ${failedCount}/${attemptedCount} chunks failed, exceeding the configured failure threshold`,
    );
    this.name = 'EmbeddingThresholdExceededError';
  }
}

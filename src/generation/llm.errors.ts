export class TransientLlmProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransientLlmProviderError';
  }
}

export class RateLimitLlmProviderError extends TransientLlmProviderError {
  public readonly retryAfterMs: number | null;

  constructor(message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = 'RateLimitLlmProviderError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class PermanentLlmProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentLlmProviderError';
  }
}

export class LlmResponseValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmResponseValidationError';
  }
}

export type GenerationFailureClassification =
  | 'timeout'
  | 'rate_limit'
  | 'quota'
  | 'authentication'
  | 'provider'
  | 'internal';

export class GenerationProviderError extends Error {
  constructor(
    message: string,
    public readonly classification: GenerationFailureClassification,
  ) {
    super(message);
    this.name = 'GenerationProviderError';
  }
}

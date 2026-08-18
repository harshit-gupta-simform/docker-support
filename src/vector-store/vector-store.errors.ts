export class TransientVectorStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransientVectorStoreError';
  }
}

export class PermanentVectorStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentVectorStoreError';
  }
}

export class VectorStoreValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VectorStoreValidationError';
  }
}

export class VectorStoreThresholdExceededError extends Error {
  constructor(
    public readonly failedCount: number,
    public readonly attemptedCount: number,
  ) {
    super(
      `Indexing run aborted: ${failedCount}/${attemptedCount} points failed, exceeding the configured failure threshold`,
    );
    this.name = 'VectorStoreThresholdExceededError';
  }
}

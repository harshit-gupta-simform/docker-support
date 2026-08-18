import {
  PermanentVectorStoreError,
  TransientVectorStoreError,
  VectorStoreThresholdExceededError,
  VectorStoreValidationError,
} from './vector-store.errors';

describe('vector-store error taxonomy', () => {
  it('names each error class after itself', () => {
    expect(new TransientVectorStoreError('x').name).toBe(
      'TransientVectorStoreError',
    );
    expect(new PermanentVectorStoreError('x').name).toBe(
      'PermanentVectorStoreError',
    );
    expect(new VectorStoreValidationError('x').name).toBe(
      'VectorStoreValidationError',
    );
  });

  it('VectorStoreThresholdExceededError composes a clear message from counts', () => {
    const err = new VectorStoreThresholdExceededError(6, 10);
    expect(err.name).toBe('VectorStoreThresholdExceededError');
    expect(err.failedCount).toBe(6);
    expect(err.attemptedCount).toBe(10);
    expect(err.message).toContain('6/10');
  });

  it('TransientVectorStoreError preserves a cause', () => {
    const cause = new Error('network down');
    const err = new TransientVectorStoreError('upsert failed', { cause });
    expect(err.cause).toBe(cause);
  });
});

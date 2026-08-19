// src/vector-store/vector-store-record-validator.util.spec.ts
import { validateRecordForIndexing } from './vector-store-record-validator.util';
import { VectorStoreValidationError } from './vector-store.errors';
import { EmbeddingRecord } from '../embedding/embedding.types';

function buildRecord(
  overrides: Partial<EmbeddingRecord> = {},
): EmbeddingRecord {
  return {
    embeddingId: 'emb1',
    chunkId: 'chunk1',
    documentId: 'doc1',
    sourcePath: 'install.md',
    vector: [0.1, 0.2, 0.3],
    dimensions: 3,
    provider: 'google',
    model: 'gemini-embedding-2',
    modelVersion: '1',
    contentHash: 'hash1',
    inputHash: 'inputhash1',
    inputTokenCount: 5,
    truncated: false,
    createdAt: '2026-08-17T00:00:00.000Z',
    ...overrides,
  };
}

const baseTarget = {
  provider: 'google',
  model: 'gemini-embedding-2',
  modelVersion: '1',
  dimensions: 3,
};

describe('validateRecordForIndexing', () => {
  it('accepts a valid, dimension-matching, non-fake record', () => {
    expect(() =>
      validateRecordForIndexing(buildRecord(), baseTarget, {
        allowFakeProvider: false,
      }),
    ).not.toThrow();
  });

  it('rejects a record whose dimensions do not match the target collection', () => {
    expect(() =>
      validateRecordForIndexing(
        buildRecord({ dimensions: 3 }),
        { ...baseTarget, dimensions: 768 },
        { allowFakeProvider: false },
      ),
    ).toThrow(VectorStoreValidationError);
  });

  it('rejects a record whose provider does not match the target configuration', () => {
    expect(() =>
      validateRecordForIndexing(
        buildRecord({ provider: 'voyage' }),
        baseTarget,
        { allowFakeProvider: false },
      ),
    ).toThrow(VectorStoreValidationError);
  });

  it('rejects a record whose model does not match the target configuration', () => {
    expect(() =>
      validateRecordForIndexing(
        buildRecord({ model: 'voyage-code-3' }),
        baseTarget,
        { allowFakeProvider: false },
      ),
    ).toThrow(VectorStoreValidationError);
  });

  it('rejects a record whose modelVersion does not match the target configuration', () => {
    expect(() =>
      validateRecordForIndexing(
        buildRecord({ modelVersion: '2' }),
        baseTarget,
        { allowFakeProvider: false },
      ),
    ).toThrow(VectorStoreValidationError);
  });

  it('rejects a fake-provider record unless explicitly allowed', () => {
    expect(() =>
      validateRecordForIndexing(buildRecord({ provider: 'fake' }), baseTarget, {
        allowFakeProvider: false,
      }),
    ).toThrow(/fake/i);
  });

  it('accepts a fake-provider record when explicitly allowed', () => {
    expect(() =>
      validateRecordForIndexing(
        buildRecord({ provider: 'fake' }),
        { ...baseTarget, provider: 'fake' },
        { allowFakeProvider: true },
      ),
    ).not.toThrow();
  });

  it('rejects an empty vector', () => {
    expect(() =>
      validateRecordForIndexing(buildRecord({ vector: [] }), baseTarget, {
        allowFakeProvider: false,
      }),
    ).toThrow(VectorStoreValidationError);
  });

  it('rejects a vector containing a non-finite value', () => {
    expect(() =>
      validateRecordForIndexing(
        buildRecord({ vector: [0.1, Number.NaN, 0.3] }),
        baseTarget,
        { allowFakeProvider: false },
      ),
    ).toThrow(VectorStoreValidationError);
  });
});

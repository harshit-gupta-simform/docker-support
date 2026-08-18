import { EmbeddingRecord } from '../embedding/embedding.types';
import { VectorStoreValidationError } from './vector-store.errors';

export function validateRecordForIndexing(
  record: EmbeddingRecord,
  target: { dimensions: number },
  options: { allowFakeProvider: boolean },
): void {
  if (record.provider === 'fake' && !options.allowFakeProvider) {
    throw new VectorStoreValidationError(
      `Refusing to index a "fake"-provider embedding (chunkId="${record.chunkId}") — set VECTOR_STORE_ALLOW_FAKE_PROVIDER=true to explicitly allow this for development/testing`,
    );
  }

  if (record.dimensions !== target.dimensions) {
    throw new VectorStoreValidationError(
      `Embedding record for chunkId="${record.chunkId}" has ${record.dimensions} dimensions, but the target collection expects ${target.dimensions}`,
    );
  }

  if (!Array.isArray(record.vector) || record.vector.length === 0) {
    throw new VectorStoreValidationError(
      `Embedding record for chunkId="${record.chunkId}" has an empty vector`,
    );
  }

  if (record.vector.length !== record.dimensions) {
    throw new VectorStoreValidationError(
      `Embedding record for chunkId="${record.chunkId}" declares dimensions=${record.dimensions} but its vector has length ${record.vector.length}`,
    );
  }

  if (
    record.vector.some(
      (value) => typeof value !== 'number' || !Number.isFinite(value),
    )
  ) {
    throw new VectorStoreValidationError(
      `Embedding record for chunkId="${record.chunkId}" contains a non-numeric or non-finite vector value`,
    );
  }
}

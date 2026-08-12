import { createHash } from 'node:crypto';
import { deriveEmbeddingId } from './embedding-id.util';
import { EmbeddingModelMetadata } from './embedding.types';

const modelMetadata: EmbeddingModelMetadata = {
  provider: 'voyage',
  model: 'voyage-code-3',
  modelVersion: '1',
  dimensions: 1024,
};

describe('deriveEmbeddingId', () => {
  it('produces a deterministic SHA-256 hash of chunkId + contentHash + provider + model + version + dimensions', () => {
    const expected = createHash('sha256')
      .update('chunk1::hash1::voyage::voyage-code-3::1::1024', 'utf-8')
      .digest('hex');

    expect(deriveEmbeddingId('chunk1', 'hash1', modelMetadata)).toBe(expected);
  });

  it('returns the same id for the same inputs across calls', () => {
    expect(deriveEmbeddingId('chunk1', 'hash1', modelMetadata)).toBe(
      deriveEmbeddingId('chunk1', 'hash1', modelMetadata),
    );
  });

  it('changes when chunkId changes', () => {
    expect(deriveEmbeddingId('chunk1', 'hash1', modelMetadata)).not.toBe(
      deriveEmbeddingId('chunk2', 'hash1', modelMetadata),
    );
  });

  it('changes when contentHash changes — this detects a stale embedding after a chunk content edit that did not change chunkId', () => {
    expect(deriveEmbeddingId('chunk1', 'hash1', modelMetadata)).not.toBe(
      deriveEmbeddingId('chunk1', 'hash2', modelMetadata),
    );
  });

  it('changes when provider changes', () => {
    expect(deriveEmbeddingId('chunk1', 'hash1', modelMetadata)).not.toBe(
      deriveEmbeddingId('chunk1', 'hash1', {
        ...modelMetadata,
        provider: 'openai',
      }),
    );
  });

  it('changes when model changes', () => {
    expect(deriveEmbeddingId('chunk1', 'hash1', modelMetadata)).not.toBe(
      deriveEmbeddingId('chunk1', 'hash1', {
        ...modelMetadata,
        model: 'text-embedding-3-large',
      }),
    );
  });

  it('changes when modelVersion changes — a manual version bump forces full re-embedding', () => {
    expect(deriveEmbeddingId('chunk1', 'hash1', modelMetadata)).not.toBe(
      deriveEmbeddingId('chunk1', 'hash1', {
        ...modelMetadata,
        modelVersion: '2',
      }),
    );
  });

  it('changes when dimensions changes', () => {
    expect(deriveEmbeddingId('chunk1', 'hash1', modelMetadata)).not.toBe(
      deriveEmbeddingId('chunk1', 'hash1', {
        ...modelMetadata,
        dimensions: 512,
      }),
    );
  });
});

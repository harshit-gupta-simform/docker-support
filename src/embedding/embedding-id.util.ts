import { createHash } from 'node:crypto';
import { EmbeddingModelMetadata } from './embedding.types';

export function deriveEmbeddingId(
  chunkId: string,
  contentHash: string,
  modelMetadata: EmbeddingModelMetadata,
): string {
  return createHash('sha256')
    .update(
      `${chunkId}::${contentHash}::${modelMetadata.provider}::${modelMetadata.model}::${modelMetadata.modelVersion}::${modelMetadata.dimensions}`,
      'utf-8',
    )
    .digest('hex');
}

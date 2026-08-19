import { Chunk } from '../chunking/chunking.types';
import { EmbeddingRecord } from '../embedding/embedding.types';
import { deriveVectorPointId } from './vector-store-id.util';
import { VectorPoint } from './vector-store.types';

export function transformToVectorPoint(
  record: EmbeddingRecord,
  chunk: Chunk,
  parentChunk: Chunk | null,
  domain: string,
): VectorPoint {
  const headingPath = chunk.metadata.headingPath
    .map((segment) => segment.text)
    .join(' › ');

  return {
    id: deriveVectorPointId(record.embeddingId),
    vector: record.vector,
    payload: {
      chunkId: chunk.chunkId,
      documentId: chunk.metadata.documentId,
      parentChunkId: chunk.relationships.parentChunkId,
      chunkType: chunk.metadata.chunkType,
      contentHash: chunk.metadata.contentHash,
      headingPath,
      documentTitle: chunk.metadata.documentTitle,
      sourcePath: chunk.metadata.sourcePath,
      domain,
      text: chunk.text,
      parentText: parentChunk ? parentChunk.text : null,
      provider: record.provider,
      model: record.model,
      modelVersion: record.modelVersion,
      dimensions: record.dimensions,
      embeddingId: record.embeddingId,
      indexedAt: new Date().toISOString(),
    },
  };
}

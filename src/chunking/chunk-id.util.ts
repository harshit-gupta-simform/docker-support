import { createHash } from 'node:crypto';
import { ChunkType, HeadingPathSegment } from './chunking.types';

export function deriveChunkId(
  documentId: string,
  chunkType: ChunkType,
  headingPath: HeadingPathSegment[],
  localSequenceIndex: number,
): string {
  const pathKey = headingPath.map((segment) => segment.anchor).join('/');
  return createHash('sha256')
    .update(
      `${documentId}::${chunkType}::${pathKey}::${localSequenceIndex}`,
      'utf-8',
    )
    .digest('hex');
}

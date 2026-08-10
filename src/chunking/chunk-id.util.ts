import { createHash } from 'node:crypto';
import { HeadingPathSegment } from './chunking.types';

export function deriveChunkId(
  documentId: string,
  headingPath: HeadingPathSegment[],
  localSequenceIndex: number,
): string {
  const pathKey = headingPath.map((segment) => segment.anchor).join('/');
  return createHash('sha256')
    .update(`${documentId}::${pathKey}::${localSequenceIndex}`, 'utf-8')
    .digest('hex');
}

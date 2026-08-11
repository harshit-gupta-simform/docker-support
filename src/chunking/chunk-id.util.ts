import { createHash } from 'node:crypto';
import { ChunkType, HeadingPathSegment } from './chunking.types';

// occurrenceIndex disambiguates two structurally distinct sections that
// happen to share the exact same heading text at the exact same nesting
// depth (e.g. a page with separate "## From the GUI" subsections under two
// different, un-nested platform tabs) — without it, both sections produce
// the same headingPath and therefore the same chunkId. It is the caller's
// responsibility (ChunkAssemblerService) to track how many times a given
// headingPath has already been seen in the current document and pass the
// running count here; localSequenceIndex remains scoped to disambiguating
// multiple pieces of a single oversized-and-split section.
export function deriveChunkId(
  documentId: string,
  chunkType: ChunkType,
  headingPath: HeadingPathSegment[],
  occurrenceIndex: number,
  localSequenceIndex: number,
): string {
  const pathKey = headingPath.map((segment) => segment.anchor).join('/');
  return createHash('sha256')
    .update(
      `${documentId}::${chunkType}::${pathKey}::${occurrenceIndex}::${localSequenceIndex}`,
      'utf-8',
    )
    .digest('hex');
}

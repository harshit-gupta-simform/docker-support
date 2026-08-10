import { createHash } from 'node:crypto';
import { deriveChunkId } from './chunk-id.util';
import { HeadingPathSegment } from './chunking.types';

const path: HeadingPathSegment[] = [
  { level: 1, text: 'Install', anchor: 'install' },
  { level: 2, text: 'On Ubuntu', anchor: 'on-ubuntu' },
];

describe('deriveChunkId', () => {
  it('produces a deterministic SHA-256 hash of documentId + chunkType + anchors + index', () => {
    const expected = createHash('sha256')
      .update('doc1::child::install/on-ubuntu::0', 'utf-8')
      .digest('hex');

    expect(deriveChunkId('doc1', 'child', path, 0)).toBe(expected);
  });

  it('returns the same id for the same inputs across calls', () => {
    expect(deriveChunkId('doc1', 'child', path, 0)).toBe(
      deriveChunkId('doc1', 'child', path, 0),
    );
  });

  it('changes when documentId changes', () => {
    expect(deriveChunkId('doc1', 'child', path, 0)).not.toBe(
      deriveChunkId('doc2', 'child', path, 0),
    );
  });

  it('changes when chunkType changes — this is the fix for the parent/child chunkId collision bug', () => {
    expect(deriveChunkId('doc1', 'child', path, 0)).not.toBe(
      deriveChunkId('doc1', 'parent', path, 0),
    );
  });

  it('changes when headingPath changes', () => {
    const otherPath: HeadingPathSegment[] = [
      { level: 1, text: 'Setup', anchor: 'setup' },
    ];
    expect(deriveChunkId('doc1', 'child', path, 0)).not.toBe(
      deriveChunkId('doc1', 'child', otherPath, 0),
    );
  });

  it('changes when localSequenceIndex changes', () => {
    expect(deriveChunkId('doc1', 'child', path, 0)).not.toBe(
      deriveChunkId('doc1', 'child', path, 1),
    );
  });

  it('produces the same id regardless of headingPath text/level, only anchor matters', () => {
    const samePathDifferentText: HeadingPathSegment[] = [
      { level: 99, text: 'Renamed', anchor: 'install' },
      { level: 99, text: 'Renamed too', anchor: 'on-ubuntu' },
    ];
    expect(deriveChunkId('doc1', 'child', path, 0)).toBe(
      deriveChunkId('doc1', 'child', samePathDifferentText, 0),
    );
  });

  it('handles an empty headingPath (root section content)', () => {
    const id = deriveChunkId('doc1', 'parent', [], 0);
    const expected = createHash('sha256')
      .update('doc1::parent::::0', 'utf-8')
      .digest('hex');
    expect(id).toBe(expected);
  });
});

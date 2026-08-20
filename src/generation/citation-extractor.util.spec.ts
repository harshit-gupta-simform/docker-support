import { extractCitations } from './citation-extractor.util';
import { SelectedContextChunk } from './context-policy.types';
import { RetrievalResult } from '../retrieval/retrieval.types';

function buildChunk(
  sourceId: string,
  overrides: Partial<RetrievalResult> = {},
): SelectedContextChunk {
  const result: RetrievalResult = {
    chunkId: `chunk-${sourceId}`,
    documentId: `doc-${sourceId}`,
    parentChunkId: null,
    chunkType: 'child',
    score: 0.9,
    text: 'text',
    parentText: null,
    headingPath: 'Install',
    documentTitle: `Title ${sourceId}`,
    sourcePath: `install-${sourceId}.md`,
    domain: 'docker',
    ...overrides,
  };
  return { sourceId, result, text: result.text };
}

describe('extractCitations', () => {
  it('extracts a single valid citation', () => {
    const chunks = [buildChunk('S1')];
    const sources = extractCitations('The answer is X [S1].', chunks);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toEqual({
      documentId: 'doc-S1',
      chunkId: 'chunk-S1',
      title: 'Title S1',
      headingPath: 'Install',
      source: 'install-S1.md',
      score: 0.9,
    });
  });

  it('extracts multiple citations in order of first appearance and dedupes repeats', () => {
    const chunks = [buildChunk('S1'), buildChunk('S2')];
    const sources = extractCitations(
      'See [S2] and also [S1], and again [S2].',
      chunks,
    );
    expect(sources.map((s) => s.chunkId)).toEqual(['chunk-S2', 'chunk-S1']);
  });

  it('discards citation IDs that do not match any known source', () => {
    const chunks = [buildChunk('S1')];
    const sources = extractCitations('See [S1] and [S99].', chunks);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.chunkId).toBe('chunk-S1');
  });

  it('returns no sources when no citation markers are present', () => {
    const chunks = [buildChunk('S1'), buildChunk('S2')];
    const sources = extractCitations('No markers here.', chunks);
    expect(sources).toEqual([]);
  });

  it('returns no sources when all markers are invalid', () => {
    const chunks = [buildChunk('S1')];
    const sources = extractCitations('See [S99].', chunks);
    expect(sources).toEqual([]);
  });

  it('substitutes placeholders for missing title/source metadata', () => {
    const chunks = [
      buildChunk('S1', { documentTitle: '', sourcePath: '', headingPath: '' }),
    ];
    const sources = extractCitations('[S1]', chunks);
    expect(sources[0]).toMatchObject({
      title: '(untitled)',
      source: '(unknown source)',
      headingPath: '(none)',
    });
  });
});

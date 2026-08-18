import { transformToVectorPoint } from './vector-store-record-transformer.util';
import { EmbeddingRecord } from '../embedding/embedding.types';
import { Chunk } from '../chunking/chunking.types';
import { deriveVectorPointId } from './vector-store-id.util';

function buildChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    chunkId: 'child1',
    text: 'Run docker --version to check your install.',
    metadata: {
      documentId: 'doc1',
      sourcePath: 'install.md',
      documentTitle: 'Install Docker',
      headingPath: [
        { level: 1, text: 'Install Docker', anchor: 'install-docker' },
        { level: 2, text: 'On Ubuntu', anchor: 'on-ubuntu' },
      ],
      chunkType: 'child',
      contentTypes: ['paragraph'],
      length: 44,
      sequenceIndex: 0,
      wasSplit: false,
      wasMerged: false,
      mergedHeadings: [],
      exceedsMaxSize: false,
      contentHash: 'hash1',
      chunkedAt: '2026-08-17T00:00:00.000Z',
    },
    relationships: {
      parentChunkId: 'parent1',
      childChunkIds: [],
      previousChunkId: null,
      nextChunkId: null,
    },
    ...overrides,
  };
}

function buildRecord(
  overrides: Partial<EmbeddingRecord> = {},
): EmbeddingRecord {
  return {
    embeddingId: 'emb1',
    chunkId: 'child1',
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

describe('transformToVectorPoint', () => {
  it('maps a record + its chunk + its parent into a VectorPoint', () => {
    const record = buildRecord();
    const chunk = buildChunk();
    const parentChunk = buildChunk({
      chunkId: 'parent1',
      text: 'Full section text about installing Docker on Ubuntu.',
    });

    const point = transformToVectorPoint(record, chunk, parentChunk, 'docker');

    expect(point.id).toBe(deriveVectorPointId('emb1'));
    expect(point.vector).toEqual([0.1, 0.2, 0.3]);
    expect(point.payload).toMatchObject({
      chunkId: 'child1',
      documentId: 'doc1',
      parentChunkId: 'parent1',
      chunkType: 'child',
      contentHash: 'hash1',
      headingPath: 'Install Docker › On Ubuntu',
      documentTitle: 'Install Docker',
      sourcePath: 'install.md',
      domain: 'docker',
      text: 'Run docker --version to check your install.',
      parentText: 'Full section text about installing Docker on Ubuntu.',
      provider: 'google',
      model: 'gemini-embedding-2',
      modelVersion: '1',
      dimensions: 3,
      embeddingId: 'emb1',
    });
    expect(typeof point.payload.indexedAt).toBe('string');
  });

  it('sets parentText to null when parentChunkId is null', () => {
    const chunk = buildChunk({
      relationships: {
        parentChunkId: null,
        childChunkIds: [],
        previousChunkId: null,
        nextChunkId: null,
      },
    });

    const point = transformToVectorPoint(buildRecord(), chunk, null, 'docker');

    expect(point.payload.parentChunkId).toBeNull();
    expect(point.payload.parentText).toBeNull();
  });

  it('sets parentText to null when the parent chunk could not be found', () => {
    const point = transformToVectorPoint(
      buildRecord(),
      buildChunk(),
      null,
      'docker',
    );

    expect(point.payload.parentChunkId).toBe('parent1');
    expect(point.payload.parentText).toBeNull();
  });
});

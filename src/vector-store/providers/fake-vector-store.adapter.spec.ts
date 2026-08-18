import { FakeVectorStoreAdapter } from './fake-vector-store.adapter';
import { VectorPoint } from '../vector-store.types';

function buildPoint(overrides: Partial<VectorPoint> = {}): VectorPoint {
  return {
    id: '11111111-1111-5111-8111-111111111111',
    vector: [1, 0, 0],
    payload: {
      chunkId: 'chunk1',
      documentId: 'doc1',
      parentChunkId: null,
      chunkType: 'child',
      contentHash: 'hash1',
      headingPath: 'Install',
      documentTitle: 'Install Docker',
      sourcePath: 'install.md',
      domain: 'docker',
      text: 'Run docker --version',
      parentText: null,
      provider: 'fake',
      model: 'fake-model',
      modelVersion: '1',
      dimensions: 3,
      embeddingId: 'emb1',
      indexedAt: '2026-08-17T00:00:00.000Z',
    },
    ...overrides,
  };
}

describe('FakeVectorStoreAdapter', () => {
  it('creates a collection and reports its info', async () => {
    const store = new FakeVectorStoreAdapter();
    await store.ensureCollection('docker__fake_v1', 3);
    expect(await store.collectionInfo('docker__fake_v1')).toEqual({
      dimensions: 3,
      pointCount: 0,
    });
  });

  it('returns null collectionInfo for a collection that was never created', async () => {
    const store = new FakeVectorStoreAdapter();
    expect(await store.collectionInfo('missing')).toBeNull();
  });

  it('ensureCollection is idempotent', async () => {
    const store = new FakeVectorStoreAdapter();
    await store.ensureCollection('c', 3);
    await store.ensureCollection('c', 3);
    expect(await store.collectionInfo('c')).toEqual({
      dimensions: 3,
      pointCount: 0,
    });
  });

  it('upserts points and reflects the new count', async () => {
    const store = new FakeVectorStoreAdapter();
    await store.ensureCollection('c', 3);
    await store.upsert('c', [buildPoint()]);
    expect(await store.collectionInfo('c')).toEqual({
      dimensions: 3,
      pointCount: 1,
    });
  });

  it('upserting the same point id twice results in exactly one point', async () => {
    const store = new FakeVectorStoreAdapter();
    await store.ensureCollection('c', 3);
    await store.upsert('c', [buildPoint()]);
    await store.upsert('c', [buildPoint({ vector: [0, 1, 0] })]);
    expect(await store.collectionInfo('c')).toEqual({
      dimensions: 3,
      pointCount: 1,
    });
  });

  it('search returns points ranked by cosine similarity descending', async () => {
    const store = new FakeVectorStoreAdapter();
    await store.ensureCollection('c', 3);
    await store.upsert('c', [
      buildPoint({ id: 'a', vector: [1, 0, 0] }),
      buildPoint({ id: 'b', vector: [0, 1, 0] }),
    ]);

    const matches = await store.search({
      collection: 'c',
      vector: [1, 0, 0],
      topK: 2,
    });

    expect(matches[0]!.id).toBe('a');
    expect(matches[0]!.score).toBeCloseTo(1, 5);
    expect(matches[1]!.id).toBe('b');
    expect(matches[1]!.score).toBeCloseTo(0, 5);
  });

  it('search applies the filter before ranking', async () => {
    const store = new FakeVectorStoreAdapter();
    await store.ensureCollection('c', 3);
    await store.upsert('c', [
      buildPoint({
        id: 'a',
        vector: [1, 0, 0],
        payload: { ...buildPoint().payload, documentId: 'doc1' },
      }),
      buildPoint({
        id: 'b',
        vector: [1, 0, 0],
        payload: { ...buildPoint().payload, documentId: 'doc2' },
      }),
    ]);

    const matches = await store.search({
      collection: 'c',
      vector: [1, 0, 0],
      topK: 10,
      filter: { documentId: 'doc2' },
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]!.id).toBe('b');
  });

  it('search respects scoreThreshold', async () => {
    const store = new FakeVectorStoreAdapter();
    await store.ensureCollection('c', 3);
    await store.upsert('c', [
      buildPoint({ id: 'a', vector: [1, 0, 0] }),
      buildPoint({ id: 'b', vector: [0, 1, 0] }),
    ]);

    const matches = await store.search({
      collection: 'c',
      vector: [1, 0, 0],
      topK: 10,
      scoreThreshold: 0.5,
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]!.id).toBe('a');
  });

  it('deleteByFilter removes matching points and returns the deleted count', async () => {
    const store = new FakeVectorStoreAdapter();
    await store.ensureCollection('c', 3);
    await store.upsert('c', [
      buildPoint({
        id: 'a',
        payload: { ...buildPoint().payload, documentId: 'doc1' },
      }),
      buildPoint({
        id: 'b',
        payload: { ...buildPoint().payload, documentId: 'doc2' },
      }),
    ]);

    const deleted = await store.deleteByFilter('c', { documentId: 'doc1' });

    expect(deleted).toBe(1);
    expect(await store.collectionInfo('c')).toEqual({
      dimensions: 3,
      pointCount: 1,
    });
  });
});

// test/vector-store.integration-spec.ts
//
// Requires a real, running Qdrant instance: `docker compose up -d qdrant`
// (see docker-compose.yml and docs/architecture/vector-store-local-dev.md).
// This suite is intentionally excluded from `pnpm test`/`pnpm test:e2e` —
// run it explicitly via `pnpm test:integration`.
import { randomUUID } from 'node:crypto';
import { QdrantVectorStoreAdapter } from '../src/vector-store/providers/qdrant-vector-store.adapter';
import { VectorPoint } from '../src/vector-store/vector-store.types';

const QDRANT_URL = process.env.VECTOR_STORE_URL ?? 'http://localhost:6333';

function buildPoint(overrides: Partial<VectorPoint> = {}): VectorPoint {
  return {
    id: randomUUID(),
    vector: [1, 0, 0, 0],
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
      text: 'text',
      parentText: null,
      provider: 'fake',
      model: 'fake-model',
      modelVersion: '1',
      dimensions: 4,
      embeddingId: 'emb1',
      indexedAt: new Date(0).toISOString(),
    },
    ...overrides,
  };
}

describe('QdrantVectorStoreAdapter (integration)', () => {
  const adapter = new QdrantVectorStoreAdapter(QDRANT_URL, '');
  const collection = `it_test_${randomUUID().replace(/-/g, '_')}`;

  beforeAll(async () => {
    await adapter.ensureCollection(collection, 4);
  }, 15000);

  afterAll(async () => {
    await fetch(`${QDRANT_URL}/collections/${collection}`, {
      method: 'DELETE',
    });
  });

  it('ensureCollection is idempotent', async () => {
    await expect(
      adapter.ensureCollection(collection, 4),
    ).resolves.toBeUndefined();
  });

  it('reports collection info after creation', async () => {
    const info = await adapter.collectionInfo(collection);
    expect(info).toEqual({ dimensions: 4, pointCount: 0 });
  });

  it('upserts a point and reflects it in collectionInfo', async () => {
    await adapter.upsert(collection, [buildPoint({ id: randomUUID() })]);
    const info = await adapter.collectionInfo(collection);
    expect(info!.pointCount).toBeGreaterThanOrEqual(1);
  });

  it('upserting the same point id twice results in exactly one point', async () => {
    const id = randomUUID();
    await adapter.upsert(collection, [
      buildPoint({ id, vector: [1, 0, 0, 0] }),
    ]);
    const before = (await adapter.collectionInfo(collection))!.pointCount;
    await adapter.upsert(collection, [
      buildPoint({ id, vector: [0, 1, 0, 0] }),
    ]);
    const after = (await adapter.collectionInfo(collection))!.pointCount;
    expect(after).toBe(before);
  });

  it('search ranks a near-identical vector above a far-apart one', async () => {
    const near = randomUUID();
    const far = randomUUID();
    await adapter.upsert(collection, [
      buildPoint({
        id: near,
        vector: [1, 0, 0, 0],
        payload: { ...buildPoint().payload, documentId: 'search-doc' },
      }),
      buildPoint({
        id: far,
        vector: [0, 0, 0, 1],
        payload: { ...buildPoint().payload, documentId: 'search-doc' },
      }),
    ]);

    const matches = await adapter.search({
      collection,
      vector: [1, 0, 0, 0],
      topK: 2,
      filter: { documentId: 'search-doc' },
    });

    expect(matches[0]!.id).toBe(near);
  });

  it('deleteByFilter removes matching points and reports the count', async () => {
    const id = randomUUID();
    await adapter.upsert(collection, [
      buildPoint({
        id,
        payload: { ...buildPoint().payload, documentId: 'delete-doc' },
      }),
    ]);

    const deleted = await adapter.deleteByFilter(collection, {
      documentId: 'delete-doc',
    });

    expect(deleted).toBeGreaterThanOrEqual(1);
  });

  it('fails fast with a clear error when pointed at a non-existent host', async () => {
    const badAdapter = new QdrantVectorStoreAdapter('http://localhost:1', '');
    await expect(badAdapter.collectionInfo('anything')).rejects.toThrow();
  });
});

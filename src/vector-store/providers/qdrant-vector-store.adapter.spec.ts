import { QdrantVectorStoreAdapter } from './qdrant-vector-store.adapter';
import {
  PermanentVectorStoreError,
  TransientVectorStoreError,
  VectorStoreValidationError,
} from '../vector-store.errors';
import { VectorPoint } from '../vector-store.types';

function buildPoint(): VectorPoint {
  return {
    id: '11111111-1111-5111-8111-111111111111',
    vector: [0.1, 0.2, 0.3],
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
      provider: 'google',
      model: 'gemini-embedding-2',
      modelVersion: '1',
      dimensions: 3,
      embeddingId: 'emb1',
      indexedAt: '2026-08-17T00:00:00.000Z',
    },
  };
}

function mockFetchOnce(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return jest.spyOn(global, 'fetch').mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

describe('QdrantVectorStoreAdapter', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('ensureCollection PUTs the collection with the correct vector size, using the api-key header', async () => {
    const fetchSpy = mockFetchOnce(200, { result: true });
    const adapter = new QdrantVectorStoreAdapter(
      'http://localhost:6333',
      'secret',
    );

    await adapter.ensureCollection('docker__google_v1', 768);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('http://localhost:6333/collections/docker__google_v1');
    expect(init!.method).toBe('PUT');
    expect((init!.headers as Record<string, string>)['api-key']).toBe('secret');
    expect(JSON.parse(init!.body as string)).toEqual({
      vectors: { size: 768, distance: 'Cosine' },
    });
  });

  it('ensureCollection is a no-op (does not throw) when Qdrant reports the collection already exists (409)', async () => {
    mockFetchOnce(409, { status: { error: 'already exists' } });
    const adapter = new QdrantVectorStoreAdapter('http://localhost:6333', '');

    await expect(
      adapter.ensureCollection('docker__google_v1', 768),
    ).resolves.toBeUndefined();
  });

  it('collectionInfo maps a 200 response to CollectionInfo', async () => {
    mockFetchOnce(200, {
      result: {
        points_count: 42,
        config: { params: { vectors: { size: 768 } } },
      },
    });
    const adapter = new QdrantVectorStoreAdapter('http://localhost:6333', '');

    const info = await adapter.collectionInfo('docker__google_v1');

    expect(info).toEqual({ dimensions: 768, pointCount: 42 });
  });

  it('collectionInfo returns null on a 404', async () => {
    mockFetchOnce(404, { status: { error: 'not found' } });
    const adapter = new QdrantVectorStoreAdapter('http://localhost:6333', '');

    expect(await adapter.collectionInfo('missing')).toBeNull();
  });

  it('upsert PUTs points in the shape Qdrant expects', async () => {
    const fetchSpy = mockFetchOnce(200, { result: true });
    const adapter = new QdrantVectorStoreAdapter('http://localhost:6333', '');
    const point = buildPoint();

    await adapter.upsert('c', [point]);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('http://localhost:6333/collections/c/points?wait=true');
    const body = JSON.parse(init!.body as string) as {
      points: unknown[];
    };
    expect(body.points[0]).toEqual({
      id: point.id,
      vector: point.vector,
      payload: point.payload,
    });
  });

  it('search POSTs a query and maps results to VectorSearchMatch[]', async () => {
    const fetchSpy = mockFetchOnce(200, {
      result: [{ id: '1', score: 0.9, payload: buildPoint().payload }],
    });
    const adapter = new QdrantVectorStoreAdapter('http://localhost:6333', '');

    const matches = await adapter.search({
      collection: 'c',
      vector: [0.1, 0.2, 0.3],
      topK: 5,
      filter: { documentId: 'doc1' },
    });

    expect(matches).toEqual([
      { id: '1', score: 0.9, payload: buildPoint().payload },
    ]);
    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse(init!.body as string) as {
      limit: number;
      filter: { must: unknown[] };
    };
    expect(body.limit).toBe(5);
    expect(body.filter.must).toContainEqual({
      key: 'documentId',
      match: { value: 'doc1' },
    });
  });

  it('deleteByFilter POSTs a filter and returns the reported deleted count', async () => {
    mockFetchOnce(200, { result: { count: 3 } });
    mockFetchOnce(200, { result: { status: 'completed' } });
    const adapter = new QdrantVectorStoreAdapter('http://localhost:6333', '');

    const deleted = await adapter.deleteByFilter('c', { documentId: 'doc1' });

    expect(deleted).toBe(3);
  });

  it('deleteByFilter skips the delete call and returns 0 when nothing matches', async () => {
    mockFetchOnce(200, { result: { count: 0 } });
    const adapter = new QdrantVectorStoreAdapter('http://localhost:6333', '');

    const deleted = await adapter.deleteByFilter('c', { documentId: 'doc1' });

    expect(deleted).toBe(0);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('deleteByFilter rejects an empty filter instead of deleting the whole collection', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const adapter = new QdrantVectorStoreAdapter('http://localhost:6333', '');

    await expect(adapter.deleteByFilter('c', {})).rejects.toThrow(
      VectorStoreValidationError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps a 429 response to RateLimit-classified TransientVectorStoreError with retryAfterMs', async () => {
    mockFetchOnce(
      429,
      { status: { error: 'rate limited' } },
      { 'retry-after': '2' },
    );
    const adapter = new QdrantVectorStoreAdapter('http://localhost:6333', '');

    await expect(adapter.collectionInfo('c')).rejects.toThrow(
      TransientVectorStoreError,
    );
  });

  it('maps a 5xx response to TransientVectorStoreError', async () => {
    mockFetchOnce(500, { status: { error: 'boom' } });
    const adapter = new QdrantVectorStoreAdapter('http://localhost:6333', '');

    await expect(adapter.upsert('c', [buildPoint()])).rejects.toThrow(
      TransientVectorStoreError,
    );
  });

  it('maps a 4xx (non-404/429) response to PermanentVectorStoreError', async () => {
    mockFetchOnce(400, { status: { error: 'bad request' } });
    const adapter = new QdrantVectorStoreAdapter('http://localhost:6333', '');

    await expect(adapter.upsert('c', [buildPoint()])).rejects.toThrow(
      PermanentVectorStoreError,
    );
  });

  it('maps a network-level rejection to TransientVectorStoreError with a cause', async () => {
    const networkErr = new Error('ECONNREFUSED');
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(networkErr);
    const adapter = new QdrantVectorStoreAdapter('http://localhost:6333', '');

    await expect(adapter.collectionInfo('c')).rejects.toThrow(
      TransientVectorStoreError,
    );
  });
});

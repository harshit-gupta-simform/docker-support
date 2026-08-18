import { PinoLogger } from 'nestjs-pino';
import { IndexingBatchProcessorService } from './indexing-batch-processor.service';
import { VectorStoreConfigService } from './vector-store-config.service';
import { FakeVectorStoreAdapter } from './providers/fake-vector-store.adapter';
import { TransientVectorStoreError } from './vector-store.errors';
import { VectorPoint } from './vector-store.types';

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
      text: 'text',
      parentText: null,
      provider: 'google',
      model: 'gemini-embedding-2',
      modelVersion: '1',
      dimensions: 3,
      embeddingId: 'emb1',
      indexedAt: '2026-08-17T00:00:00.000Z',
    },
    ...overrides,
  };
}

function buildConfig(
  overrides: Partial<VectorStoreConfigService> = {},
): VectorStoreConfigService {
  return {
    maxRetries: 3,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 5,
    requestTimeoutMs: 50,
    ...overrides,
  } as VectorStoreConfigService;
}

function buildLogger(): PinoLogger {
  return {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  } as unknown as PinoLogger;
}

describe('IndexingBatchProcessorService', () => {
  it('reports every point as succeeded on a successful upsert', async () => {
    const store = new FakeVectorStoreAdapter();
    await store.ensureCollection('c', 3);
    const service = new IndexingBatchProcessorService(
      store,
      buildConfig(),
      buildLogger(),
    );

    const outcome = await service.processBatch('batch-0', 'c', [buildPoint()]);

    expect(outcome.failed).toEqual([]);
    expect(outcome.succeededIds).toEqual([buildPoint().id]);
    expect((await store.collectionInfo('c'))!.pointCount).toBe(1);
  });

  it('retries a batch that fails transiently, then succeeds', async () => {
    const store = new FakeVectorStoreAdapter();
    await store.ensureCollection('c', 3);
    let calls = 0;
    jest
      .spyOn(store, 'upsert')
      .mockImplementation(async (...args: Parameters<typeof store.upsert>) => {
        calls += 1;
        if (calls === 1) throw new TransientVectorStoreError('flaky');
        return FakeVectorStoreAdapter.prototype.upsert.apply(store, args);
      });
    const service = new IndexingBatchProcessorService(
      store,
      buildConfig(),
      buildLogger(),
    );

    const outcome = await service.processBatch('batch-0', 'c', [buildPoint()]);

    expect(outcome.succeededIds).toEqual([buildPoint().id]);
    expect(outcome.failed).toEqual([]);
  });

  it('reports every point in the batch as failed when upsert fails permanently after retries', async () => {
    const store = new FakeVectorStoreAdapter();
    await store.ensureCollection('c', 3);
    jest
      .spyOn(store, 'upsert')
      .mockRejectedValue(new TransientVectorStoreError('down'));
    const service = new IndexingBatchProcessorService(
      store,
      buildConfig({ maxRetries: 2 }),
      buildLogger(),
    );

    const outcome = await service.processBatch('batch-0', 'c', [
      buildPoint(),
      buildPoint({ id: '22222222-1111-5111-8111-111111111111' }),
    ]);

    expect(outcome.succeededIds).toEqual([]);
    expect(outcome.failed).toHaveLength(2);
  });

  it('classifies a timeout as a transient, retried failure', async () => {
    const store = new FakeVectorStoreAdapter();
    await store.ensureCollection('c', 3);
    jest.spyOn(store, 'upsert').mockImplementation(() => new Promise(() => {}));
    const service = new IndexingBatchProcessorService(
      store,
      buildConfig({ requestTimeoutMs: 20, maxRetries: 1 }),
      buildLogger(),
    );

    const outcome = await service.processBatch('batch-0', 'c', [buildPoint()]);

    expect(outcome.succeededIds).toEqual([]);
    expect(outcome.failed[0]!.message).toContain('timed out');
  });

  it('never throws out of processBatch itself', async () => {
    const store = new FakeVectorStoreAdapter();
    await store.ensureCollection('c', 3);
    jest
      .spyOn(store, 'upsert')
      .mockRejectedValue(new TransientVectorStoreError('down'));
    const service = new IndexingBatchProcessorService(
      store,
      buildConfig(),
      buildLogger(),
    );

    await expect(
      service.processBatch('batch-0', 'c', [buildPoint()]),
    ).resolves.toBeDefined();
  });
});

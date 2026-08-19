import { PinoLogger } from 'nestjs-pino';
import { RetrievalService } from './retrieval.service';
import { RetrievalConfigService } from './retrieval-config.service';
import {
  RetrievalConfigMismatchError,
  RetrievalValidationError,
} from './retrieval.errors';
import { FakeEmbeddingProvider } from '../embedding/providers/fake-embedding-provider';
import { FakeVectorStoreAdapter } from '../vector-store/providers/fake-vector-store.adapter';
import { VectorPoint } from '../vector-store/vector-store.types';

function buildConfig(
  overrides: Partial<RetrievalConfigService> = {},
): RetrievalConfigService {
  return {
    defaultTopK: 5,
    maxTopK: 10,
    scoreThreshold: 0,
    expandToParent: true,
    requestTimeoutMs: 50,
    maxRetries: 2,
    ...overrides,
  } as RetrievalConfigService;
}

function buildLogger(): PinoLogger {
  return {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as PinoLogger;
}

function buildPoint(overrides: Partial<VectorPoint> = {}): VectorPoint {
  return {
    id: '11111111-1111-5111-8111-111111111111',
    vector: [1, 0, 0, 0],
    payload: {
      chunkId: 'child1',
      documentId: 'doc1',
      parentChunkId: 'parent1',
      chunkType: 'child',
      contentHash: 'hash1',
      headingPath: 'Install',
      documentTitle: 'Install Docker',
      sourcePath: 'install.md',
      domain: 'docker',
      text: 'Run docker --version.',
      parentText: 'Full section about installing Docker.',
      provider: 'fake',
      model: 'fake-model',
      modelVersion: '1',
      dimensions: 4,
      embeddingId: 'emb1',
      indexedAt: '2026-08-17T00:00:00.000Z',
    },
    ...overrides,
  };
}

const metadata = {
  provider: 'fake',
  model: 'fake-model',
  modelVersion: '1',
  dimensions: 4,
};

async function setUp() {
  const store = new FakeVectorStoreAdapter();
  await store.ensureCollection('docker__fake_fake-model_4d_v1', 4);
  const provider = new FakeEmbeddingProvider(metadata);
  // Derive the stored point's vector from the same deterministic
  // hash-based embedding the provider will produce for the query text
  // below, so the fake store's cosine-similarity scoring (and the
  // configured scoreThreshold) behaves like a real semantic match
  // instead of an arbitrary, disconnected fixture vector.
  const embedded = await provider.embed([
    { id: 'seed', text: 'How do I check my docker version?' },
  ]);
  const seedVector = embedded[0]!.vector;
  await store.upsert('docker__fake_fake-model_4d_v1', [
    buildPoint({ vector: seedVector }),
  ]);
  const service = new RetrievalService(
    provider,
    store,
    buildConfig(),
    buildLogger(),
  );
  return { store, provider, service };
}

describe('RetrievalService', () => {
  it('embeds the query, searches, and returns normalized results with parent context', async () => {
    const { service } = await setUp();

    const results = await service.retrieve(
      { text: 'How do I check my docker version?', domain: 'docker' },
      'docker__fake_fake-model_4d_v1',
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      chunkId: 'child1',
      documentId: 'doc1',
      parentChunkId: 'parent1',
      chunkType: 'child',
      text: 'Run docker --version.',
      parentText: 'Full section about installing Docker.',
      headingPath: 'Install',
      documentTitle: 'Install Docker',
      sourcePath: 'install.md',
      domain: 'docker',
    });
    expect(typeof results[0]!.score).toBe('number');
  });

  it('omits parentText when expandToParent is false', async () => {
    const { service } = await setUp();

    const results = await service.retrieve(
      { text: 'question', domain: 'docker', expandToParent: false },
      'docker__fake_fake-model_4d_v1',
    );

    expect(results[0]!.parentText).toBeNull();
  });

  it('rejects an empty query', async () => {
    const { service } = await setUp();

    await expect(
      service.retrieve({ text: '   ', domain: 'docker' }, 'c'),
    ).rejects.toThrow(RetrievalValidationError);
  });

  it('rejects a topK above RETRIEVAL_MAX_TOP_K', async () => {
    const { service } = await setUp();

    await expect(
      service.retrieve(
        { text: 'q', domain: 'docker', topK: 999 },
        'docker__fake_fake-model_4d_v1',
      ),
    ).rejects.toThrow(RetrievalValidationError);
  });

  it('throws RetrievalValidationError naming the collection when it does not exist', async () => {
    const store = new FakeVectorStoreAdapter();
    const provider = new FakeEmbeddingProvider(metadata);
    const service = new RetrievalService(
      provider,
      store,
      buildConfig(),
      buildLogger(),
    );

    await expect(
      service.retrieve({ text: 'q', domain: 'docker' }, 'never-created'),
    ).rejects.toThrow(RetrievalValidationError);
    await expect(
      service.retrieve({ text: 'q', domain: 'docker' }, 'never-created'),
    ).rejects.toThrow(/never-created/);
  });

  it('throws RetrievalConfigMismatchError when the target collection dimensions do not match the embedding provider', async () => {
    const store = new FakeVectorStoreAdapter();
    await store.ensureCollection('mismatched', 999);
    const provider = new FakeEmbeddingProvider(metadata);
    const service = new RetrievalService(
      provider,
      store,
      buildConfig(),
      buildLogger(),
    );

    await expect(
      service.retrieve({ text: 'q', domain: 'docker' }, 'mismatched'),
    ).rejects.toThrow(RetrievalConfigMismatchError);
  });

  it('maps RetrievalFilter to a VectorSearchFilter passed to the store', async () => {
    const { store, service } = await setUp();
    const searchSpy = jest.spyOn(store, 'search');

    await service.retrieve(
      {
        text: 'q',
        domain: 'docker',
        filter: { documentId: 'doc1', sourcePath: 'install.md' },
      },
      'docker__fake_fake-model_4d_v1',
    );

    expect(searchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: {
          domain: 'docker',
          documentId: 'doc1',
          sourcePath: 'install.md',
        },
      }),
    );
  });
});

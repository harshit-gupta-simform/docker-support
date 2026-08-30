import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { EMBEDDING_PROVIDER_PORT } from './../src/embedding/embedding-provider.port';
import { FakeEmbeddingProvider } from './../src/embedding/providers/fake-embedding-provider';
import { EmbeddingConfigService } from './../src/embedding/embedding-config.service';
import { LLM_PROVIDER_PORT } from './../src/generation/llm-provider.port';
import { FakeLlmProvider } from './../src/generation/providers/fake-llm-provider';
import { INSUFFICIENT_CONTEXT_ANSWER } from './../src/generation/generation.service';
import { VECTOR_STORE_PORT } from './../src/vector-store/vector-store.port';
import { FakeVectorStoreAdapter } from './../src/vector-store/providers/fake-vector-store.adapter';
import { VectorStoreConfigService } from './../src/vector-store/vector-store-config.service';
import { deriveCollectionName } from './../src/vector-store/vector-store-collection-name.util';

const fakeEmbeddingMetadata = {
  provider: 'fake',
  model: 'fake-model',
  modelVersion: '1',
  dimensions: 4,
};

describe('RetrievalController (e2e)', () => {
  let app: INestApplication<App>;
  let embeddingProvider: FakeEmbeddingProvider;
  let store: FakeVectorStoreAdapter;

  beforeAll(async () => {
    embeddingProvider = new FakeEmbeddingProvider(fakeEmbeddingMetadata);
    store = new FakeVectorStoreAdapter();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EMBEDDING_PROVIDER_PORT)
      .useValue(embeddingProvider)
      .overrideProvider(VECTOR_STORE_PORT)
      .useValue(store)
      .overrideProvider(LLM_PROVIDER_PORT)
      .useValue(new FakeLlmProvider({ provider: 'fake', model: 'fake-llm' }))
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /query returns 400 when text is missing', () => {
    return request(app.getHttpServer()).post('/query').send({}).expect(400);
  });

  it('POST /query returns 400 for a not-yet-indexed collection', async () => {
    const response = await request(app.getHttpServer())
      .post('/query')
      .send({ text: 'anything' })
      .expect(400);

    const body = response.body as { message: { message: string } };
    expect(body.message.message).toContain('does not exist');
  });

  it('POST /query returns a controlled answer when a collection exists but has no matching chunks', async () => {
    const embeddingConfig = app.get(EmbeddingConfigService);
    const vectorStoreConfig = app.get(VectorStoreConfigService);
    const collection = deriveCollectionName({
      domain: vectorStoreConfig.domain,
      provider: embeddingConfig.provider,
      model: embeddingConfig.model,
      dimensions: embeddingConfig.dimensions,
      modelVersion: embeddingConfig.modelVersion,
    });
    await store.ensureCollection(collection, fakeEmbeddingMetadata.dimensions);

    const response = await request(app.getHttpServer())
      .post('/query')
      .send({ text: 'what is the capital of France?' })
      .expect(200);

    const body = response.body as {
      answer: string;
      sources: unknown[];
      metadata: { retrievedCount: number };
    };
    expect(body.answer).toBe(INSUFFICIENT_CONTEXT_ANSWER);
    expect(body.sources).toEqual([]);
    expect(body.metadata.retrievedCount).toBe(0);
  });

  it('POST /query returns a grounded answer with a citation mapped to the seeded point', async () => {
    const embeddingConfig = app.get(EmbeddingConfigService);
    const vectorStoreConfig = app.get(VectorStoreConfigService);

    const collection = deriveCollectionName({
      domain: vectorStoreConfig.domain,
      provider: embeddingConfig.provider,
      model: embeddingConfig.model,
      dimensions: embeddingConfig.dimensions,
      modelVersion: embeddingConfig.modelVersion,
    });

    const questionText = 'How do I check my docker version?';
    const embedded = await embeddingProvider.embed([
      { id: 'seed', text: questionText },
    ]);
    const vector = embedded[0]!.vector;

    await store.ensureCollection(collection, fakeEmbeddingMetadata.dimensions);
    await store.upsert(collection, [
      {
        id: '11111111-1111-5111-8111-111111111111',
        vector,
        payload: {
          chunkId: 'child1',
          documentId: 'doc1',
          parentChunkId: null,
          chunkType: 'child',
          contentHash: 'hash1',
          headingPath: 'Install',
          documentTitle: 'Install Docker',
          sourcePath: 'install.md',
          domain: vectorStoreConfig.domain,
          text: 'Run docker --version.',
          parentText: null,
          provider: fakeEmbeddingMetadata.provider,
          model: fakeEmbeddingMetadata.model,
          modelVersion: fakeEmbeddingMetadata.modelVersion,
          dimensions: fakeEmbeddingMetadata.dimensions,
          embeddingId: 'emb1',
          indexedAt: new Date().toISOString(),
        },
      },
    ]);

    const response = await request(app.getHttpServer())
      .post('/query')
      .send({ text: questionText })
      .expect(200);

    const body = response.body as {
      answer: string;
      sources: Array<{ chunkId: string }>;
      metadata: { retrievedCount: number; framework: string };
    };
    expect(body.answer.length).toBeGreaterThan(0);
    expect(body.metadata.retrievedCount).toBe(1);
    expect(body.metadata.framework).toBe('langchain');
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0]!.chunkId).toBe('child1');
  });
});

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { EMBEDDING_PROVIDER_PORT } from './../src/embedding/embedding-provider.port';
import { FakeEmbeddingProvider } from './../src/embedding/providers/fake-embedding-provider';
import { EmbeddingConfigService } from './../src/embedding/embedding-config.service';
import { VECTOR_STORE_PORT } from './../src/vector-store/vector-store.port';
import { FakeVectorStoreAdapter } from './../src/vector-store/providers/fake-vector-store.adapter';
import { VectorStoreConfigService } from './../src/vector-store/vector-store-config.service';
import { deriveCollectionName } from './../src/vector-store/vector-store-collection-name.util';

const fakeMetadata = {
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
    embeddingProvider = new FakeEmbeddingProvider(fakeMetadata);
    store = new FakeVectorStoreAdapter();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EMBEDDING_PROVIDER_PORT)
      .useValue(embeddingProvider)
      .overrideProvider(VECTOR_STORE_PORT)
      .useValue(store)
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

  it('POST /query returns exactly the one matching seeded point', async () => {
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

    await store.ensureCollection(collection, fakeMetadata.dimensions);
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
          provider: fakeMetadata.provider,
          model: fakeMetadata.model,
          modelVersion: fakeMetadata.modelVersion,
          dimensions: fakeMetadata.dimensions,
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
      collection: string;
      count: number;
      results: Array<{ chunkId: string }>;
    };
    expect(body.collection).toBe(collection);
    expect(body.count).toBe(1);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]!.chunkId).toBe('child1');
  });
});

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PinoLogger } from 'nestjs-pino';
import { IndexingPipelineService } from './indexing-pipeline.service';
import { IndexingBatchProcessorService } from './indexing-batch-processor.service';
import { VectorStoreConfigService } from './vector-store-config.service';
import { FakeVectorStoreAdapter } from './providers/fake-vector-store.adapter';
import { VectorStoreThresholdExceededError } from './vector-store.errors';
import { Chunk } from '../chunking/chunking.types';
import { EmbeddingRecord } from '../embedding/embedding.types';
import { EmbeddingConfigService } from '../embedding/embedding-config.service';

function buildChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    chunkId: 'child1',
    text: 'Run docker --version.',
    metadata: {
      documentId: 'doc1',
      sourcePath: 'install.md',
      documentTitle: 'Install Docker',
      headingPath: [{ level: 1, text: 'Install', anchor: 'install' }],
      chunkType: 'child',
      contentTypes: ['paragraph'],
      length: 22,
      sequenceIndex: 0,
      wasSplit: false,
      wasMerged: false,
      mergedHeadings: [],
      exceedsMaxSize: false,
      contentHash: 'hash1',
      chunkedAt: '2026-08-17T00:00:00.000Z',
    },
    relationships: {
      parentChunkId: null,
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

function buildConfig(
  overrides: Partial<VectorStoreConfigService> = {},
): VectorStoreConfigService {
  return {
    domain: 'docker',
    batchSize: 100,
    maxConcurrentBatches: 2,
    failureThreshold: 0.5,
    allowFakeProvider: false,
    maxRetries: 3,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 5,
    requestTimeoutMs: 50,
    ...overrides,
  } as VectorStoreConfigService;
}

function buildEmbeddingConfig(
  overrides: Partial<EmbeddingConfigService> = {},
): EmbeddingConfigService {
  return {
    provider: 'google',
    model: 'gemini-embedding-2',
    modelVersion: '1',
    dimensions: 3,
    ...overrides,
  } as EmbeddingConfigService;
}

function buildLogger(): PinoLogger {
  return {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  } as unknown as PinoLogger;
}

async function writeFixtures(
  root: string,
  chunks: Chunk[],
  records: EmbeddingRecord[],
): Promise<{ chunksDir: string; embeddingsFile: string }> {
  const chunksDir = join(root, 'chunks');
  await mkdir(chunksDir, { recursive: true });
  await writeFile(
    join(chunksDir, 'doc1.chunks.json'),
    JSON.stringify(chunks),
    'utf-8',
  );
  const embeddingsFile = join(root, 'embeddings.jsonl');
  await writeFile(
    embeddingsFile,
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf-8',
  );
  return { chunksDir, embeddingsFile };
}

describe('IndexingPipelineService', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vs-pipeline-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('indexes every eligible record into the target collection', async () => {
    const { chunksDir, embeddingsFile } = await writeFixtures(
      root,
      [buildChunk()],
      [buildRecord()],
    );
    const store = new FakeVectorStoreAdapter();
    const config = buildConfig();
    const logger = buildLogger();
    const batchProcessor = new IndexingBatchProcessorService(
      store,
      config,
      logger,
    );
    const pipeline = new IndexingPipelineService(
      config,
      store,
      batchProcessor,
      buildEmbeddingConfig(),
      logger,
    );

    const result = await pipeline.run(
      embeddingsFile,
      chunksDir,
      'docker__google_v1',
    );

    expect(result.attempted).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect((await store.collectionInfo('docker__google_v1'))!.pointCount).toBe(
      1,
    );
  });

  it('is idempotent — re-running against the same fixtures does not duplicate points', async () => {
    const { chunksDir, embeddingsFile } = await writeFixtures(
      root,
      [buildChunk()],
      [buildRecord()],
    );
    const store = new FakeVectorStoreAdapter();
    const config = buildConfig();
    const logger = buildLogger();
    const batchProcessor = new IndexingBatchProcessorService(
      store,
      config,
      logger,
    );
    const pipeline = new IndexingPipelineService(
      config,
      store,
      batchProcessor,
      buildEmbeddingConfig(),
      logger,
    );

    await pipeline.run(embeddingsFile, chunksDir, 'docker__google_v1');
    await pipeline.run(embeddingsFile, chunksDir, 'docker__google_v1');

    expect((await store.collectionInfo('docker__google_v1'))!.pointCount).toBe(
      1,
    );
  });

  it('skips fake-provider records by default and counts them separately', async () => {
    const { chunksDir, embeddingsFile } = await writeFixtures(
      root,
      [buildChunk()],
      [buildRecord({ provider: 'fake' })],
    );
    const store = new FakeVectorStoreAdapter();
    const config = buildConfig({ allowFakeProvider: false });
    const logger = buildLogger();
    const batchProcessor = new IndexingBatchProcessorService(
      store,
      config,
      logger,
    );
    const pipeline = new IndexingPipelineService(
      config,
      store,
      batchProcessor,
      buildEmbeddingConfig(),
      logger,
    );

    const result = await pipeline.run(
      embeddingsFile,
      chunksDir,
      'docker__fake_v1',
    );

    expect(result.skippedFakeProvider).toBe(1);
    expect(result.attempted).toBe(0);
  });

  it('skips a record whose provider/model/modelVersion do not match the configured embedding provider, even when dimensions match', async () => {
    const { chunksDir, embeddingsFile } = await writeFixtures(
      root,
      [buildChunk()],
      [
        buildRecord({
          provider: 'voyage',
          model: 'voyage-code-3',
          modelVersion: '1',
          dimensions: 3,
        }),
      ],
    );
    const store = new FakeVectorStoreAdapter();
    const config = buildConfig();
    const logger = buildLogger();
    const batchProcessor = new IndexingBatchProcessorService(
      store,
      config,
      logger,
    );
    const pipeline = new IndexingPipelineService(
      config,
      store,
      batchProcessor,
      buildEmbeddingConfig({
        provider: 'google',
        model: 'gemini-embedding-2',
        modelVersion: '1',
        dimensions: 3,
      }),
      logger,
    );

    const result = await pipeline.run(
      embeddingsFile,
      chunksDir,
      'docker__google_v1',
    );

    expect(result.skippedByProvenanceMismatch).toBe(1);
    expect(result.attempted).toBe(0);
  });

  it('throws VectorStoreThresholdExceededError when failures exceed the configured threshold', async () => {
    const { chunksDir, embeddingsFile } = await writeFixtures(
      root,
      [
        buildChunk(),
        buildChunk({
          chunkId: 'child2',
          metadata: { ...buildChunk().metadata, contentHash: 'hash2' },
        }),
      ],
      [
        buildRecord(),
        buildRecord({
          embeddingId: 'emb2',
          chunkId: 'child2',
          contentHash: 'hash2',
        }),
      ],
    );
    const store = new FakeVectorStoreAdapter();
    jest.spyOn(store, 'upsert').mockRejectedValue(new Error('down'));
    const config = buildConfig({ failureThreshold: 0.1, maxRetries: 1 });
    const logger = buildLogger();
    const batchProcessor = new IndexingBatchProcessorService(
      store,
      config,
      logger,
    );
    const pipeline = new IndexingPipelineService(
      config,
      store,
      batchProcessor,
      buildEmbeddingConfig(),
      logger,
    );

    await expect(
      pipeline.run(embeddingsFile, chunksDir, 'docker__google_v1'),
    ).rejects.toThrow(VectorStoreThresholdExceededError);
  });
});

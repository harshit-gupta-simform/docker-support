import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PinoLogger } from 'nestjs-pino';
import { Chunk } from '../chunking/chunking.types';
import { EmbeddingBatchProcessorService } from './embedding-batch-processor.service';
import { EmbeddingConfigService } from './embedding-config.service';
import { EmbeddingOutputStoreService } from './embedding-output-store.service';
import { EmbeddingThresholdExceededError } from './embedding.errors';
import {
  batchEligibleInputs,
  EmbeddingPipelineService,
} from './embedding-pipeline.service';
import { PermanentEmbeddingProviderError } from './embedding.errors';
import { EmbeddingInput } from './embedding.types';
import { FakeEmbeddingProvider } from './providers/fake-embedding-provider';

function buildInput(overrides: Partial<EmbeddingInput> = {}): EmbeddingInput {
  return {
    chunkId: 'chunk1',
    documentId: 'doc1',
    sourcePath: 'install.md',
    contentHash: 'hash1',
    text: 'hello',
    inputHash: 'inputhash1',
    tokenCount: 10,
    truncated: false,
    ...overrides,
  };
}

function buildChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    chunkId: overrides.chunkId ?? 'chunk1',
    text: 'Run `docker --version` to verify the installation.',
    metadata: {
      documentId: 'doc1',
      sourcePath: 'install.md',
      documentTitle: 'Install',
      headingPath: [{ level: 1, text: 'Install', anchor: 'install' }],
      chunkType: 'child',
      contentTypes: ['paragraph'],
      length: 40,
      sequenceIndex: 0,
      wasSplit: false,
      wasMerged: false,
      mergedHeadings: [],
      exceedsMaxSize: false,
      contentHash: 'contenthash1',
      chunkedAt: '2026-01-01T00:00:00.000Z',
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

function buildConfig(
  overrides: Partial<EmbeddingConfigService> = {},
): EmbeddingConfigService {
  return {
    batchSize: 10,
    maxConcurrentBatches: 2,
    maxRetries: 2,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 5,
    requestTimeoutMs: 1000,
    inputMaxTokens: 8000,
    includeHeadingContext: false,
    chunkTypes: ['child'],
    failureThreshold: 0.5,
    maxChunksPerRun: 0,
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

const metadata = {
  provider: 'fake',
  model: 'fake-model',
  modelVersion: '1',
  dimensions: 4,
};

describe('EmbeddingPipelineService', () => {
  let chunksDir: string;
  let outputDir: string;

  beforeEach(async () => {
    chunksDir = await mkdtemp(join(tmpdir(), 'embedding-pipeline-chunks-'));
    outputDir = await mkdtemp(join(tmpdir(), 'embedding-pipeline-output-'));
  });

  afterEach(async () => {
    await rm(chunksDir, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });
  });

  function buildPipeline(
    provider: FakeEmbeddingProvider,
    configOverrides: Partial<EmbeddingConfigService> = {},
  ) {
    const outputConfig = {
      outputDir,
      provider: provider.metadata.provider,
      model: provider.metadata.model,
      modelVersion: provider.metadata.modelVersion,
      dimensions: provider.metadata.dimensions,
    } as EmbeddingConfigService;
    const config = buildConfig(configOverrides);
    const logger = buildLogger();
    const outputStore = new EmbeddingOutputStoreService(outputConfig, logger);
    const batchProcessor = new EmbeddingBatchProcessorService(
      provider,
      config,
      logger,
    );
    return new EmbeddingPipelineService(
      config,
      outputStore,
      batchProcessor,
      provider,
      logger,
    );
  }

  it('embeds only child-type chunks by default, skipping parent-type chunks', async () => {
    await writeFile(
      join(chunksDir, 'doc1.chunks.json'),
      JSON.stringify([
        buildChunk({ chunkId: 'child1' }),
        buildChunk({
          chunkId: 'parent1',
          metadata: { ...buildChunk().metadata, chunkType: 'parent' },
        }),
      ]),
    );
    const provider = new FakeEmbeddingProvider(metadata);
    const pipeline = buildPipeline(provider);

    const result = await pipeline.run(chunksDir);

    expect(result.totalChunksScanned).toBe(2);
    expect(result.skippedByType).toBe(1);
    expect(result.attempted).toBe(1);
    expect(result.succeeded).toBe(1);
  });

  it('satisfies the accounting invariant: scanned = skippedByType + skippedEmpty + alreadyEmbedded + attempted', async () => {
    await writeFile(
      join(chunksDir, 'doc1.chunks.json'),
      JSON.stringify([
        buildChunk({ chunkId: 'child1' }),
        buildChunk({ chunkId: 'child2', text: '   ' }),
        buildChunk({
          chunkId: 'parent1',
          metadata: { ...buildChunk().metadata, chunkType: 'parent' },
        }),
      ]),
    );
    const provider = new FakeEmbeddingProvider(metadata);
    const pipeline = buildPipeline(provider);

    const result = await pipeline.run(chunksDir);

    expect(result.totalChunksScanned).toBe(
      result.skippedByType +
        result.skippedEmpty +
        result.alreadyEmbedded +
        result.skippedByMaxChunksCap +
        result.attempted,
    );
  });

  it('skips a chunk whose text is empty after normalization, recording it as skippedEmpty', async () => {
    await writeFile(
      join(chunksDir, 'doc1.chunks.json'),
      JSON.stringify([buildChunk({ chunkId: 'child1', text: '   \n\n  ' })]),
    );
    const provider = new FakeEmbeddingProvider(metadata);
    const pipeline = buildPipeline(provider);

    const result = await pipeline.run(chunksDir);

    expect(result.skippedEmpty).toBe(1);
    expect(result.attempted).toBe(0);
  });

  it('writes exactly one EmbeddingRecord per successfully embedded chunk', async () => {
    await writeFile(
      join(chunksDir, 'doc1.chunks.json'),
      JSON.stringify([buildChunk({ chunkId: 'child1' })]),
    );
    const provider = new FakeEmbeddingProvider(metadata);
    const pipeline = buildPipeline(provider);

    const result = await pipeline.run(chunksDir);

    expect(result.outputPath).toContain('embeddings.jsonl');
    const outputStore = new EmbeddingOutputStoreService(
      {
        outputDir,
        provider: metadata.provider,
        model: metadata.model,
        modelVersion: metadata.modelVersion,
        dimensions: metadata.dimensions,
      } as EmbeddingConfigService,
      buildLogger(),
    );
    const ids = await outputStore.loadExistingEmbeddingIds();
    expect(ids.size).toBe(1);
  });

  it('is resumable — a second run against the same output embeds zero new chunks', async () => {
    await writeFile(
      join(chunksDir, 'doc1.chunks.json'),
      JSON.stringify([buildChunk({ chunkId: 'child1' })]),
    );
    const provider = new FakeEmbeddingProvider(metadata);

    const firstResult = await buildPipeline(provider).run(chunksDir);
    expect(firstResult.attempted).toBe(1);
    expect(firstResult.succeeded).toBe(1);

    const secondResult = await buildPipeline(provider).run(chunksDir);
    expect(secondResult.attempted).toBe(0);
    expect(secondResult.alreadyEmbedded).toBe(1);
  });

  it('throws EmbeddingThresholdExceededError when the failure rate exceeds the configured threshold', async () => {
    await writeFile(
      join(chunksDir, 'doc1.chunks.json'),
      JSON.stringify([
        buildChunk({ chunkId: 'child1' }),
        buildChunk({ chunkId: 'child2' }),
      ]),
    );
    const provider = new FakeEmbeddingProvider(metadata, {
      failFirstNCalls: 999,
      failWith: () => new PermanentEmbeddingProviderError('boom'),
    });
    const pipeline = buildPipeline(provider, {
      failureThreshold: 0.1,
      batchSize: 1,
    });

    await expect(pipeline.run(chunksDir)).rejects.toThrow(
      EmbeddingThresholdExceededError,
    );
  });

  it('scans multiple chunk files across multiple documents', async () => {
    await writeFile(
      join(chunksDir, 'doc1.chunks.json'),
      JSON.stringify([buildChunk({ chunkId: 'doc1-child1' })]),
    );
    await writeFile(
      join(chunksDir, 'doc2.chunks.json'),
      JSON.stringify([
        buildChunk({
          chunkId: 'doc2-child1',
          metadata: { ...buildChunk().metadata, documentId: 'doc2' },
        }),
      ]),
    );
    const provider = new FakeEmbeddingProvider(metadata);
    const pipeline = buildPipeline(provider);

    const result = await pipeline.run(chunksDir);

    expect(result.totalChunksScanned).toBe(2);
    expect(result.succeeded).toBe(2);
  });

  it('does not cap the run when EMBEDDING_MAX_CHUNKS_PER_RUN is 0 (unlimited)', async () => {
    await writeFile(
      join(chunksDir, 'doc1.chunks.json'),
      JSON.stringify([
        buildChunk({ chunkId: 'child1' }),
        buildChunk({ chunkId: 'child2' }),
        buildChunk({ chunkId: 'child3' }),
      ]),
    );
    const provider = new FakeEmbeddingProvider(metadata);
    const pipeline = buildPipeline(provider, { maxChunksPerRun: 0 });

    const result = await pipeline.run(chunksDir);

    expect(result.attempted).toBe(3);
    expect(result.skippedByMaxChunksCap).toBe(0);
  });

  it('caps attempted chunks at EMBEDDING_MAX_CHUNKS_PER_RUN and reports the remainder as skippedByMaxChunksCap', async () => {
    await writeFile(
      join(chunksDir, 'doc1.chunks.json'),
      JSON.stringify([
        buildChunk({ chunkId: 'child1' }),
        buildChunk({ chunkId: 'child2' }),
        buildChunk({ chunkId: 'child3' }),
      ]),
    );
    const provider = new FakeEmbeddingProvider(metadata);
    const pipeline = buildPipeline(provider, { maxChunksPerRun: 2 });

    const result = await pipeline.run(chunksDir);

    expect(result.attempted).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(result.skippedByMaxChunksCap).toBe(1);
    expect(result.totalChunksScanned).toBe(3);
  });

  it('never attempts more than the cap even across a resumed run', async () => {
    await writeFile(
      join(chunksDir, 'doc1.chunks.json'),
      JSON.stringify([
        buildChunk({ chunkId: 'child1' }),
        buildChunk({ chunkId: 'child2' }),
        buildChunk({ chunkId: 'child3' }),
      ]),
    );
    const provider = new FakeEmbeddingProvider(metadata);

    const firstResult = await buildPipeline(provider, {
      maxChunksPerRun: 2,
    }).run(chunksDir);
    expect(firstResult.attempted).toBe(2);

    const secondResult = await buildPipeline(provider, {
      maxChunksPerRun: 2,
    }).run(chunksDir);

    expect(secondResult.alreadyEmbedded).toBe(2);
    expect(secondResult.attempted).toBe(1);
    expect(secondResult.skippedByMaxChunksCap).toBe(0);
  });
});

describe('batchEligibleInputs', () => {
  it('closes a batch once the token budget would be exceeded, even though the chunk-count limit has not been reached', () => {
    const inputs = [
      buildInput({ chunkId: 'parent1', tokenCount: 400 }),
      buildInput({ chunkId: 'parent2', tokenCount: 400 }),
      buildInput({ chunkId: 'parent3', tokenCount: 400 }), // running total 1200 > budget 1000
      buildInput({ chunkId: 'child1', tokenCount: 10 }),
    ];

    const batches = batchEligibleInputs(inputs, /* maxCount */ 50, 1000);

    // The 50-item count limit never binds; only the token budget does.
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(batch.length).toBeLessThan(50);
      const total = batch.reduce((sum, item) => sum + item.tokenCount, 0);
      expect(total).toBeLessThanOrEqual(1000);
    }
    expect(batches).toEqual([
      [inputs[0], inputs[1]],
      [inputs[2], inputs[3]],
    ]);
  });

  it('still respects the chunk-count limit when items are small enough that the token budget never binds', () => {
    const inputs = Array.from({ length: 5 }, (_, i) =>
      buildInput({ chunkId: `c${i}`, tokenCount: 1 }),
    );

    const batches = batchEligibleInputs(inputs, /* maxCount */ 2, 1000);

    expect(batches).toEqual([
      [inputs[0], inputs[1]],
      [inputs[2], inputs[3]],
      [inputs[4]],
    ]);
  });

  it('gives a lone input exceeding the token budget its own batch rather than dropping or splitting it', () => {
    const inputs = [buildInput({ chunkId: 'huge', tokenCount: 5000 })];

    const batches = batchEligibleInputs(inputs, 50, 1000);

    expect(batches).toEqual([[inputs[0]]]);
  });

  it('returns no batches for an empty input list', () => {
    expect(batchEligibleInputs([], 50, 1000)).toEqual([]);
  });
});

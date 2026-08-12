import { PinoLogger } from 'nestjs-pino';
import { EmbeddingConfigService } from './embedding-config.service';
import { EmbeddingBatchProcessorService } from './embedding-batch-processor.service';
import { PermanentEmbeddingProviderError } from './embedding.errors';
import { EmbeddingInput } from './embedding.types';
import { FakeEmbeddingProvider } from './providers/fake-embedding-provider';

function buildInput(overrides: Partial<EmbeddingInput> = {}): EmbeddingInput {
  return {
    chunkId: 'chunk1',
    documentId: 'doc1',
    sourcePath: 'install.md',
    contentHash: 'hash1',
    text: 'Run docker --version',
    inputHash: 'inputhash1',
    tokenCount: 5,
    truncated: false,
    ...overrides,
  };
}

function buildConfig(
  overrides: Partial<EmbeddingConfigService> = {},
): EmbeddingConfigService {
  return {
    maxRetries: 3,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 5,
    requestTimeoutMs: 50,
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

describe('EmbeddingBatchProcessorService', () => {
  it('produces one EmbeddingRecord per input on a successful batch', async () => {
    const provider = new FakeEmbeddingProvider(metadata);
    const service = new EmbeddingBatchProcessorService(
      provider,
      buildConfig(),
      buildLogger(),
    );

    const outcome = await service.processBatch('batch-0', [buildInput()]);

    expect(outcome.failed).toEqual([]);
    expect(outcome.succeeded).toHaveLength(1);
    expect(outcome.succeeded[0]!.chunkId).toBe('chunk1');
    expect(outcome.succeeded[0]!.vector).toHaveLength(4);
    expect(outcome.succeeded[0]!.provider).toBe('fake');
    expect(outcome.succeeded[0]!.model).toBe('fake-model');
    expect(outcome.succeeded[0]!.contentHash).toBe('hash1');
    expect(outcome.succeeded[0]!.inputTokenCount).toBe(5);
  });

  it('retries a batch that fails transiently, then succeeds, reporting a full success', async () => {
    const provider = new FakeEmbeddingProvider(metadata, {
      failFirstNCalls: 2,
    });
    const service = new EmbeddingBatchProcessorService(
      provider,
      buildConfig(),
      buildLogger(),
    );

    const outcome = await service.processBatch('batch-0', [buildInput()]);

    expect(outcome.succeeded).toHaveLength(1);
    expect(outcome.failed).toEqual([]);
  });

  it('reports every input in the batch as failed when the provider fails permanently', async () => {
    const provider = new FakeEmbeddingProvider(metadata, {
      failFirstNCalls: 999,
      failWith: () => new PermanentEmbeddingProviderError('invalid api key'),
    });
    const service = new EmbeddingBatchProcessorService(
      provider,
      buildConfig(),
      buildLogger(),
    );

    const outcome = await service.processBatch('batch-0', [
      buildInput(),
      buildInput({ chunkId: 'chunk2' }),
    ]);

    expect(outcome.succeeded).toEqual([]);
    expect(outcome.failed).toHaveLength(2);
    expect(outcome.failed[0]!.message).toContain('invalid api key');
  });

  it('reports every input as failed after exhausting retries on a persistently transient failure', async () => {
    const provider = new FakeEmbeddingProvider(metadata, {
      failFirstNCalls: 999,
    });
    const service = new EmbeddingBatchProcessorService(
      provider,
      buildConfig({ maxRetries: 2 }),
      buildLogger(),
    );

    const outcome = await service.processBatch('batch-0', [buildInput()]);

    expect(outcome.succeeded).toEqual([]);
    expect(outcome.failed).toHaveLength(1);
  });

  it('treats a provider that never responds within requestTimeoutMs as a transient, retried failure', async () => {
    const provider = new FakeEmbeddingProvider(metadata, { delayMs: 200 });
    const service = new EmbeddingBatchProcessorService(
      provider,
      buildConfig({ requestTimeoutMs: 20, maxRetries: 1 }),
      buildLogger(),
    );

    const outcome = await service.processBatch('batch-0', [buildInput()]);

    expect(outcome.succeeded).toEqual([]);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]!.message).toContain('timed out');
  });

  it('never throws out of processBatch itself — failures are always returned, not thrown', async () => {
    const provider = new FakeEmbeddingProvider(metadata, {
      failFirstNCalls: 999,
      failWith: () => new PermanentEmbeddingProviderError('boom'),
    });
    const service = new EmbeddingBatchProcessorService(
      provider,
      buildConfig(),
      buildLogger(),
    );

    await expect(
      service.processBatch('batch-0', [buildInput()]),
    ).resolves.toBeDefined();
  });
});

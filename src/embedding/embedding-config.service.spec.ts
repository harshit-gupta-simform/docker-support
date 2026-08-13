import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { EnvConfig } from '../config/env.validation';
import { EmbeddingConfigService } from './embedding-config.service';

function buildModule(overrides: Partial<EnvConfig> = {}) {
  const defaults: Partial<EnvConfig> = {
    EMBEDDING_PROVIDER: 'voyage',
    EMBEDDING_MODEL: 'voyage-code-3',
    EMBEDDING_MODEL_VERSION: '1',
    EMBEDDING_DIMENSIONS: 1024,
    EMBEDDING_API_KEY: '',
    EMBEDDING_BASE_URL: '',
    EMBEDDING_BATCH_SIZE: 128,
    EMBEDDING_MAX_CONCURRENT_BATCHES: 5,
    EMBEDDING_MAX_RETRIES: 5,
    EMBEDDING_RETRY_BASE_DELAY_MS: 500,
    EMBEDDING_RETRY_MAX_DELAY_MS: 30000,
    EMBEDDING_REQUEST_TIMEOUT_MS: 30000,
    EMBEDDING_INPUT_MAX_TOKENS: 8000,
    EMBEDDING_INCLUDE_HEADING_CONTEXT: true,
    EMBEDDING_CHUNK_TYPES: ['child'],
    EMBEDDING_OUTPUT_DIR: './data/embedding-output',
    EMBEDDING_FAILURE_THRESHOLD: 0.5,
    EMBEDDING_MAX_CHUNKS_PER_RUN: 0,
  };
  return Test.createTestingModule({
    providers: [
      EmbeddingConfigService,
      {
        provide: ConfigService,
        useValue: {
          get: (key: keyof EnvConfig) => ({ ...defaults, ...overrides })[key],
        },
      },
    ],
  }).compile();
}

describe('EmbeddingConfigService', () => {
  it('exposes every embedding config value via typed getters', async () => {
    const moduleRef = await buildModule();
    const config = moduleRef.get(EmbeddingConfigService);

    expect(config.provider).toBe('voyage');
    expect(config.model).toBe('voyage-code-3');
    expect(config.modelVersion).toBe('1');
    expect(config.dimensions).toBe(1024);
    expect(config.apiKey).toBe('');
    expect(config.baseUrl).toBe('');
    expect(config.batchSize).toBe(128);
    expect(config.maxConcurrentBatches).toBe(5);
    expect(config.maxRetries).toBe(5);
    expect(config.retryBaseDelayMs).toBe(500);
    expect(config.retryMaxDelayMs).toBe(30000);
    expect(config.requestTimeoutMs).toBe(30000);
    expect(config.inputMaxTokens).toBe(8000);
    expect(config.includeHeadingContext).toBe(true);
    expect(config.chunkTypes).toEqual(['child']);
    expect(config.outputDir).toBe('./data/embedding-output');
    expect(config.failureThreshold).toBe(0.5);
    expect(config.maxChunksPerRun).toBe(0);
  });

  it('reflects an overridden EMBEDDING_MAX_CHUNKS_PER_RUN', async () => {
    const moduleRef = await buildModule({ EMBEDDING_MAX_CHUNKS_PER_RUN: 100 });
    const config = moduleRef.get(EmbeddingConfigService);

    expect(config.maxChunksPerRun).toBe(100);
  });

  it('reflects overridden values', async () => {
    const moduleRef = await buildModule({
      EMBEDDING_PROVIDER: 'openai',
      EMBEDDING_CHUNK_TYPES: ['parent', 'child'],
    });
    const config = moduleRef.get(EmbeddingConfigService);

    expect(config.provider).toBe('openai');
    expect(config.chunkTypes).toEqual(['parent', 'child']);
  });
});

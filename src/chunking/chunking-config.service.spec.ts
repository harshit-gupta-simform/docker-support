import { ConfigService } from '@nestjs/config';
import { EnvConfig } from '../config/env.validation';
import { ChunkingConfigService } from './chunking-config.service';

describe('ChunkingConfigService', () => {
  function build(overrides: Partial<EnvConfig> = {}): ChunkingConfigService {
    const values: EnvConfig = {
      NODE_ENV: 'test',
      PORT: 3000,
      LOG_LEVEL: 'info',
      INGESTION_OUTPUT_DIR: './data/ingestion-output',
      INGESTION_MAX_ENTRY_COUNT: 10000,
      INGESTION_MAX_UNCOMPRESSED_BYTES: 524288000,
      INGESTION_INCLUDE_GLOB: '**/*.md',
      INGESTION_DEFAULT_LANGUAGE: 'en',
      CHUNKING_MAX_CHUNK_SIZE: 500,
      CHUNKING_MIN_CHUNK_SIZE: 100,
      CHUNKING_LENGTH_STRATEGY: 'approx-token',
      CHUNKING_OVERLAP_STRATEGY: 'heading-context',
      CHUNKING_OVERLAP_SENTENCES: 1,
      CHUNKING_INCLUDE_PARENT_CHUNKS: true,
      CHUNKING_OUTPUT_DIR: './data/chunks-output',
      ...overrides,
    };
    const configService = {
      get: (key: keyof EnvConfig) => values[key],
    } as ConfigService<EnvConfig, true>;
    return new ChunkingConfigService(configService);
  }

  it('exposes maxChunkSize from config', () => {
    expect(build({ CHUNKING_MAX_CHUNK_SIZE: 800 }).maxChunkSize).toBe(800);
  });

  it('exposes minChunkSize from config', () => {
    expect(build({ CHUNKING_MIN_CHUNK_SIZE: 50 }).minChunkSize).toBe(50);
  });

  it('exposes lengthStrategy from config', () => {
    expect(build({ CHUNKING_LENGTH_STRATEGY: 'word' }).lengthStrategy).toBe(
      'word',
    );
  });

  it('exposes overlapStrategy from config', () => {
    expect(build({ CHUNKING_OVERLAP_STRATEGY: 'none' }).overlapStrategy).toBe(
      'none',
    );
  });

  it('exposes overlapSentences from config', () => {
    expect(build({ CHUNKING_OVERLAP_SENTENCES: 2 }).overlapSentences).toBe(2);
  });

  it('exposes includeParentChunks from config', () => {
    expect(
      build({ CHUNKING_INCLUDE_PARENT_CHUNKS: false }).includeParentChunks,
    ).toBe(false);
  });

  it('exposes outputDir from config', () => {
    expect(build({ CHUNKING_OUTPUT_DIR: '/tmp/out' }).outputDir).toBe(
      '/tmp/out',
    );
  });
});

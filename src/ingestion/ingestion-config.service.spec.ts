import { ConfigService } from '@nestjs/config';
import { EnvConfig } from '../config/env.validation';
import { IngestionConfigService } from './ingestion-config.service';

describe('IngestionConfigService', () => {
  function build(overrides: Partial<EnvConfig> = {}): IngestionConfigService {
    const values: EnvConfig = {
      NODE_ENV: 'test',
      PORT: 3000,
      LOG_LEVEL: 'info',
      INGESTION_OUTPUT_DIR: './data/ingestion-output',
      INGESTION_MAX_ENTRY_COUNT: 10000,
      INGESTION_MAX_UNCOMPRESSED_BYTES: 524288000,
      INGESTION_INCLUDE_GLOB: '**/*.md',
      INGESTION_DEFAULT_LANGUAGE: 'en',
      ...overrides,
    };
    const configService = {
      get: (key: keyof EnvConfig) => values[key],
    } as ConfigService<EnvConfig, true>;
    return new IngestionConfigService(configService);
  }

  it('exposes outputDir from config', () => {
    expect(build({ INGESTION_OUTPUT_DIR: '/tmp/out' }).outputDir).toBe(
      '/tmp/out',
    );
  });

  it('exposes maxEntryCount from config', () => {
    expect(build({ INGESTION_MAX_ENTRY_COUNT: 500 }).maxEntryCount).toBe(500);
  });

  it('exposes maxUncompressedBytes from config', () => {
    expect(
      build({ INGESTION_MAX_UNCOMPRESSED_BYTES: 1024 }).maxUncompressedBytes,
    ).toBe(1024);
  });

  it('exposes includeGlob from config', () => {
    expect(build({ INGESTION_INCLUDE_GLOB: '**/*.mdx' }).includeGlob).toBe(
      '**/*.mdx',
    );
  });

  it('exposes defaultLanguage from config', () => {
    expect(build({ INGESTION_DEFAULT_LANGUAGE: 'fr' }).defaultLanguage).toBe(
      'fr',
    );
  });
});

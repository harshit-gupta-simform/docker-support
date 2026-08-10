import { validateEnv } from './env.validation';

describe('validateEnv', () => {
  it('applies defaults when optional variables are absent', () => {
    const result = validateEnv({});

    expect(result).toEqual({
      NODE_ENV: 'development',
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
    });
  });

  it('coerces PORT from a string to a number', () => {
    const result = validateEnv({ PORT: '4000' });

    expect(result.PORT).toBe(4000);
  });

  it('accepts a fully specified valid configuration', () => {
    const result = validateEnv({
      NODE_ENV: 'production',
      PORT: '8080',
      LOG_LEVEL: 'debug',
      INGESTION_OUTPUT_DIR: '/data/out',
      INGESTION_MAX_ENTRY_COUNT: '5000',
      INGESTION_MAX_UNCOMPRESSED_BYTES: '1000000',
      INGESTION_INCLUDE_GLOB: '**/*.mdx',
      INGESTION_DEFAULT_LANGUAGE: 'fr',
      CHUNKING_MAX_CHUNK_SIZE: '600',
      CHUNKING_MIN_CHUNK_SIZE: '150',
      CHUNKING_LENGTH_STRATEGY: 'word',
      CHUNKING_OVERLAP_STRATEGY: 'sentence-overlap',
      CHUNKING_OVERLAP_SENTENCES: '2',
      CHUNKING_INCLUDE_PARENT_CHUNKS: 'false',
      CHUNKING_OUTPUT_DIR: '/data/chunks-out',
    });

    expect(result).toEqual({
      NODE_ENV: 'production',
      PORT: 8080,
      LOG_LEVEL: 'debug',
      INGESTION_OUTPUT_DIR: '/data/out',
      INGESTION_MAX_ENTRY_COUNT: 5000,
      INGESTION_MAX_UNCOMPRESSED_BYTES: 1000000,
      INGESTION_INCLUDE_GLOB: '**/*.mdx',
      INGESTION_DEFAULT_LANGUAGE: 'fr',
      CHUNKING_MAX_CHUNK_SIZE: 600,
      CHUNKING_MIN_CHUNK_SIZE: 150,
      CHUNKING_LENGTH_STRATEGY: 'word',
      CHUNKING_OVERLAP_STRATEGY: 'sentence-overlap',
      CHUNKING_OVERLAP_SENTENCES: 2,
      CHUNKING_INCLUDE_PARENT_CHUNKS: false,
      CHUNKING_OUTPUT_DIR: '/data/chunks-out',
    });
  });

  it('throws with a descriptive message for an invalid NODE_ENV', () => {
    expect(() => validateEnv({ NODE_ENV: 'staging' })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it('throws for a non-numeric PORT', () => {
    expect(() => validateEnv({ PORT: 'not-a-number' })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it('throws when CHUNKING_MIN_CHUNK_SIZE is not less than CHUNKING_MAX_CHUNK_SIZE', () => {
    expect(() =>
      validateEnv({
        CHUNKING_MIN_CHUNK_SIZE: '500',
        CHUNKING_MAX_CHUNK_SIZE: '500',
      }),
    ).toThrow(/Invalid environment configuration/);
  });
});

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
    });
  });

  it('accepts google as a valid EMBEDDING_PROVIDER', () => {
    const result = validateEnv({ EMBEDDING_PROVIDER: 'google' });

    expect(result.EMBEDDING_PROVIDER).toBe('google');
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
      EMBEDDING_PROVIDER: 'openai',
      EMBEDDING_MODEL: 'text-embedding-3-large',
      EMBEDDING_MODEL_VERSION: '2',
      EMBEDDING_DIMENSIONS: '3072',
      EMBEDDING_API_KEY: 'test-api-key',
      EMBEDDING_BASE_URL: 'https://api.example.com',
      EMBEDDING_BATCH_SIZE: '64',
      EMBEDDING_MAX_CONCURRENT_BATCHES: '3',
      EMBEDDING_MAX_RETRIES: '3',
      EMBEDDING_RETRY_BASE_DELAY_MS: '250',
      EMBEDDING_RETRY_MAX_DELAY_MS: '15000',
      EMBEDDING_REQUEST_TIMEOUT_MS: '20000',
      EMBEDDING_INPUT_MAX_TOKENS: '4000',
      EMBEDDING_INCLUDE_HEADING_CONTEXT: 'false',
      EMBEDDING_CHUNK_TYPES: 'parent,child',
      EMBEDDING_OUTPUT_DIR: '/data/embedding-out',
      EMBEDDING_FAILURE_THRESHOLD: '0.25',
      EMBEDDING_MAX_CHUNKS_PER_RUN: '50',
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
      EMBEDDING_PROVIDER: 'openai',
      EMBEDDING_MODEL: 'text-embedding-3-large',
      EMBEDDING_MODEL_VERSION: '2',
      EMBEDDING_DIMENSIONS: 3072,
      EMBEDDING_API_KEY: 'test-api-key',
      EMBEDDING_BASE_URL: 'https://api.example.com',
      EMBEDDING_BATCH_SIZE: 64,
      EMBEDDING_MAX_CONCURRENT_BATCHES: 3,
      EMBEDDING_MAX_RETRIES: 3,
      EMBEDDING_RETRY_BASE_DELAY_MS: 250,
      EMBEDDING_RETRY_MAX_DELAY_MS: 15000,
      EMBEDDING_REQUEST_TIMEOUT_MS: 20000,
      EMBEDDING_INPUT_MAX_TOKENS: 4000,
      EMBEDDING_INCLUDE_HEADING_CONTEXT: false,
      EMBEDDING_CHUNK_TYPES: ['parent', 'child'],
      EMBEDDING_OUTPUT_DIR: '/data/embedding-out',
      EMBEDDING_FAILURE_THRESHOLD: 0.25,
      EMBEDDING_MAX_CHUNKS_PER_RUN: 50,
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

  it('throws when EMBEDDING_RETRY_BASE_DELAY_MS is not less than EMBEDDING_RETRY_MAX_DELAY_MS', () => {
    expect(() =>
      validateEnv({
        EMBEDDING_RETRY_BASE_DELAY_MS: '30000',
        EMBEDDING_RETRY_MAX_DELAY_MS: '30000',
      }),
    ).toThrow(/Invalid environment configuration/);
  });
});

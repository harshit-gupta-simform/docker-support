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
      VECTOR_STORE_PROVIDER: 'qdrant',
      VECTOR_STORE_URL: 'http://localhost:6333',
      VECTOR_STORE_API_KEY: '',
      VECTOR_STORE_DOMAIN: 'docker',
      VECTOR_STORE_BATCH_SIZE: 200,
      VECTOR_STORE_MAX_CONCURRENT_BATCHES: 4,
      VECTOR_STORE_MAX_RETRIES: 5,
      VECTOR_STORE_RETRY_BASE_DELAY_MS: 200,
      VECTOR_STORE_RETRY_MAX_DELAY_MS: 10000,
      VECTOR_STORE_REQUEST_TIMEOUT_MS: 10000,
      VECTOR_STORE_FAILURE_THRESHOLD: 0.5,
      VECTOR_STORE_SKIP_EXISTING: true,
      VECTOR_STORE_ALLOW_FAKE_PROVIDER: false,
      RETRIEVAL_DEFAULT_TOP_K: 10,
      RETRIEVAL_MAX_TOP_K: 100,
      RETRIEVAL_SCORE_THRESHOLD: 0,
      RETRIEVAL_EXPAND_TO_PARENT: true,
      RETRIEVAL_REQUEST_TIMEOUT_MS: 10000,
      RETRIEVAL_MAX_RETRIES: 2,
      LLM_PROVIDER: 'google',
      LLM_MODEL: 'gemini-3.6-flash',
      LLM_API_KEY: '',
      LLM_TIMEOUT_MS: 30000,
      LLM_MAX_RETRIES: 2,
      LLM_MAX_OUTPUT_TOKENS: 1024,
      LLM_TEMPERATURE: 0.2,
      LLM_MAX_CONTEXT_CHUNKS: 5,
      LLM_MIN_RETRIEVAL_SCORE: 0,
      LLM_MAX_CONTEXT_CHARS: 12000,
      LLM_THINKING_LEVEL: '',
      LLM_MAX_PROMPT_TOKENS: 8000,
      LLM_INPUT_PRICE_PER_1M_TOKENS: 0.75,
      LLM_OUTPUT_PRICE_PER_1M_TOKENS: 3.75,
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
      RETRIEVAL_DEFAULT_TOP_K: '5',
      RETRIEVAL_MAX_TOP_K: '20',
      RETRIEVAL_SCORE_THRESHOLD: '0.7',
      RETRIEVAL_EXPAND_TO_PARENT: 'false',
      RETRIEVAL_REQUEST_TIMEOUT_MS: '15000',
      RETRIEVAL_MAX_RETRIES: '4',
      LLM_PROVIDER: 'fake',
      LLM_MODEL: 'custom-model',
      LLM_API_KEY: 'llm-test-key',
      LLM_TIMEOUT_MS: '5000',
      LLM_MAX_RETRIES: '3',
      LLM_MAX_OUTPUT_TOKENS: '2048',
      LLM_TEMPERATURE: '0.7',
      LLM_MAX_CONTEXT_CHUNKS: '8',
      LLM_MIN_RETRIEVAL_SCORE: '0.4',
      LLM_MAX_CONTEXT_CHARS: '9000',
      LLM_THINKING_LEVEL: 'LOW',
      LLM_MAX_PROMPT_TOKENS: '4000',
      LLM_INPUT_PRICE_PER_1M_TOKENS: '1.5',
      LLM_OUTPUT_PRICE_PER_1M_TOKENS: '7.5',
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
      VECTOR_STORE_PROVIDER: 'qdrant',
      VECTOR_STORE_URL: 'http://localhost:6333',
      VECTOR_STORE_API_KEY: '',
      VECTOR_STORE_DOMAIN: 'docker',
      VECTOR_STORE_BATCH_SIZE: 200,
      VECTOR_STORE_MAX_CONCURRENT_BATCHES: 4,
      VECTOR_STORE_MAX_RETRIES: 5,
      VECTOR_STORE_RETRY_BASE_DELAY_MS: 200,
      VECTOR_STORE_RETRY_MAX_DELAY_MS: 10000,
      VECTOR_STORE_REQUEST_TIMEOUT_MS: 10000,
      VECTOR_STORE_FAILURE_THRESHOLD: 0.5,
      VECTOR_STORE_SKIP_EXISTING: true,
      VECTOR_STORE_ALLOW_FAKE_PROVIDER: false,
      RETRIEVAL_DEFAULT_TOP_K: 5,
      RETRIEVAL_MAX_TOP_K: 20,
      RETRIEVAL_SCORE_THRESHOLD: 0.7,
      RETRIEVAL_EXPAND_TO_PARENT: false,
      RETRIEVAL_REQUEST_TIMEOUT_MS: 15000,
      RETRIEVAL_MAX_RETRIES: 4,
      LLM_PROVIDER: 'fake',
      LLM_MODEL: 'custom-model',
      LLM_API_KEY: 'llm-test-key',
      LLM_TIMEOUT_MS: 5000,
      LLM_MAX_RETRIES: 3,
      LLM_MAX_OUTPUT_TOKENS: 2048,
      LLM_TEMPERATURE: 0.7,
      LLM_MAX_CONTEXT_CHUNKS: 8,
      LLM_MIN_RETRIEVAL_SCORE: 0.4,
      LLM_MAX_CONTEXT_CHARS: 9000,
      LLM_THINKING_LEVEL: 'LOW',
      LLM_MAX_PROMPT_TOKENS: 4000,
      LLM_INPUT_PRICE_PER_1M_TOKENS: 1.5,
      LLM_OUTPUT_PRICE_PER_1M_TOKENS: 7.5,
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

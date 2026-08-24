import { z } from 'zod';

export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'production', 'test'])
      .default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    INGESTION_OUTPUT_DIR: z.string().min(1).default('./data/ingestion-output'),
    INGESTION_MAX_ENTRY_COUNT: z.coerce
      .number()
      .int()
      .positive()
      .default(10000),
    INGESTION_MAX_UNCOMPRESSED_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(524288000),
    INGESTION_INCLUDE_GLOB: z.string().min(1).default('**/*.md'),
    INGESTION_DEFAULT_LANGUAGE: z.string().min(1).default('en'),
    CHUNKING_MAX_CHUNK_SIZE: z.coerce.number().int().positive().default(500),
    CHUNKING_MIN_CHUNK_SIZE: z.coerce.number().int().positive().default(100),
    CHUNKING_LENGTH_STRATEGY: z
      .enum(['char', 'word', 'approx-token'])
      .default('approx-token'),
    CHUNKING_OVERLAP_STRATEGY: z
      .enum(['none', 'heading-context', 'sentence-overlap'])
      .default('heading-context'),
    CHUNKING_OVERLAP_SENTENCES: z.coerce.number().int().positive().default(1),
    CHUNKING_INCLUDE_PARENT_CHUNKS: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .default(true)
      .transform((value) =>
        typeof value === 'boolean' ? value : value === 'true',
      ),
    CHUNKING_OUTPUT_DIR: z.string().min(1).default('./data/chunks-output'),
    EMBEDDING_PROVIDER: z
      .enum(['voyage', 'openai', 'google', 'fake'])
      .default('voyage'),
    EMBEDDING_MODEL: z.string().min(1).default('voyage-code-3'),
    EMBEDDING_MODEL_VERSION: z.string().min(1).default('1'),
    EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1024),
    EMBEDDING_API_KEY: z.string().default(''),
    EMBEDDING_BASE_URL: z.string().default(''),
    EMBEDDING_BATCH_SIZE: z.coerce.number().int().positive().default(128),
    EMBEDDING_MAX_CONCURRENT_BATCHES: z.coerce
      .number()
      .int()
      .positive()
      .default(5),
    EMBEDDING_MAX_RETRIES: z.coerce.number().int().positive().default(5),
    EMBEDDING_RETRY_BASE_DELAY_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(500),
    EMBEDDING_RETRY_MAX_DELAY_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(30000),
    EMBEDDING_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(30000),
    EMBEDDING_INPUT_MAX_TOKENS: z.coerce
      .number()
      .int()
      .positive()
      .default(8000),
    EMBEDDING_INCLUDE_HEADING_CONTEXT: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .default(true)
      .transform((value) =>
        typeof value === 'boolean' ? value : value === 'true',
      ),
    EMBEDDING_CHUNK_TYPES: z
      .string()
      .default('child')
      .transform((value) => value.split(',').map((entry) => entry.trim()))
      .pipe(z.array(z.enum(['parent', 'child'])).min(1)),
    EMBEDDING_OUTPUT_DIR: z.string().min(1).default('./data/embedding-output'),
    EMBEDDING_FAILURE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),
    EMBEDDING_MAX_CHUNKS_PER_RUN: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(0),
    VECTOR_STORE_PROVIDER: z.enum(['qdrant', 'fake']).default('qdrant'),
    VECTOR_STORE_URL: z.string().min(1).default('http://localhost:6333'),
    VECTOR_STORE_API_KEY: z.string().default(''),
    VECTOR_STORE_DOMAIN: z.string().min(1).default('docker'),
    VECTOR_STORE_BATCH_SIZE: z.coerce.number().int().positive().default(200),
    VECTOR_STORE_MAX_CONCURRENT_BATCHES: z.coerce
      .number()
      .int()
      .positive()
      .default(4),
    VECTOR_STORE_MAX_RETRIES: z.coerce.number().int().positive().default(5),
    VECTOR_STORE_RETRY_BASE_DELAY_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(200),
    VECTOR_STORE_RETRY_MAX_DELAY_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(10000),
    VECTOR_STORE_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(10000),
    VECTOR_STORE_FAILURE_THRESHOLD: z.coerce
      .number()
      .min(0)
      .max(1)
      .default(0.5),
    VECTOR_STORE_SKIP_EXISTING: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .default(true)
      .transform((value) =>
        typeof value === 'boolean' ? value : value === 'true',
      ),
    VECTOR_STORE_ALLOW_FAKE_PROVIDER: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .default(false)
      .transform((value) =>
        typeof value === 'boolean' ? value : value === 'true',
      ),
    RETRIEVAL_DEFAULT_TOP_K: z.coerce.number().int().positive().default(10),
    RETRIEVAL_MAX_TOP_K: z.coerce.number().int().positive().default(100),
    RETRIEVAL_SCORE_THRESHOLD: z.coerce.number().default(0),
    RETRIEVAL_EXPAND_TO_PARENT: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .default(true)
      .transform((value) =>
        typeof value === 'boolean' ? value : value === 'true',
      ),
    RETRIEVAL_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(10000),
    RETRIEVAL_MAX_RETRIES: z.coerce.number().int().positive().default(2),
    LLM_PROVIDER: z.enum(['google', 'fake']).default('google'),
    LLM_MODEL: z.string().min(1).default('gemini-3.6-flash'),
    LLM_API_KEY: z.string().default(''),
    LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    LLM_MAX_RETRIES: z.coerce.number().int().positive().default(2),
    LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(1024),
    LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
    LLM_MAX_CONTEXT_CHUNKS: z.coerce.number().int().positive().default(5),
    LLM_MIN_RETRIEVAL_SCORE: z.coerce.number().min(0).default(0),
    LLM_MAX_CONTEXT_CHARS: z.coerce.number().int().positive().default(12000),
    LLM_THINKING_LEVEL: z.enum(['', 'LOW', 'MEDIUM', 'HIGH']).default(''),
    LLM_MAX_PROMPT_TOKENS: z.coerce.number().int().positive().default(8000),
    LLM_INPUT_PRICE_PER_1M_TOKENS: z.coerce
      .number()
      .nonnegative()
      .default(0.75),
    LLM_OUTPUT_PRICE_PER_1M_TOKENS: z.coerce
      .number()
      .nonnegative()
      .default(3.75),
  })
  .refine(
    (config) => config.CHUNKING_MIN_CHUNK_SIZE < config.CHUNKING_MAX_CHUNK_SIZE,
    {
      message:
        'CHUNKING_MIN_CHUNK_SIZE must be less than CHUNKING_MAX_CHUNK_SIZE',
      path: ['CHUNKING_MIN_CHUNK_SIZE'],
    },
  )
  .refine(
    (config) =>
      config.EMBEDDING_RETRY_BASE_DELAY_MS <
      config.EMBEDDING_RETRY_MAX_DELAY_MS,
    {
      message:
        'EMBEDDING_RETRY_BASE_DELAY_MS must be less than EMBEDDING_RETRY_MAX_DELAY_MS',
      path: ['EMBEDDING_RETRY_BASE_DELAY_MS'],
    },
  )
  .refine(
    (config) =>
      config.VECTOR_STORE_RETRY_BASE_DELAY_MS <
      config.VECTOR_STORE_RETRY_MAX_DELAY_MS,
    {
      message:
        'VECTOR_STORE_RETRY_BASE_DELAY_MS must be less than VECTOR_STORE_RETRY_MAX_DELAY_MS',
      path: ['VECTOR_STORE_RETRY_BASE_DELAY_MS'],
    },
  )
  .refine(
    (config) => config.RETRIEVAL_DEFAULT_TOP_K <= config.RETRIEVAL_MAX_TOP_K,
    {
      message:
        'RETRIEVAL_DEFAULT_TOP_K must be less than or equal to RETRIEVAL_MAX_TOP_K',
      path: ['RETRIEVAL_DEFAULT_TOP_K'],
    },
  );

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const result = envSchema.safeParse(config);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `- ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return result.data;
}

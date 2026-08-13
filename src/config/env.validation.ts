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
    EMBEDDING_PROVIDER: z.enum(['voyage', 'openai', 'fake']).default('voyage'),
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

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
  })
  .refine(
    (config) => config.CHUNKING_MIN_CHUNK_SIZE < config.CHUNKING_MAX_CHUNK_SIZE,
    {
      message:
        'CHUNKING_MIN_CHUNK_SIZE must be less than CHUNKING_MAX_CHUNK_SIZE',
      path: ['CHUNKING_MIN_CHUNK_SIZE'],
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

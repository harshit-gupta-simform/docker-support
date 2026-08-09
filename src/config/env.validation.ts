import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  INGESTION_OUTPUT_DIR: z.string().min(1).default('./data/ingestion-output'),
  INGESTION_MAX_ENTRY_COUNT: z.coerce.number().int().positive().default(10000),
  INGESTION_MAX_UNCOMPRESSED_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(524288000),
  INGESTION_INCLUDE_GLOB: z.string().min(1).default('**/*.md'),
  INGESTION_DEFAULT_LANGUAGE: z.string().min(1).default('en'),
});

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

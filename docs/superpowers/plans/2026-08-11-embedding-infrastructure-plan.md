# Embedding Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a dedicated `EmbeddingModule` implementing the finalized design in `docs/architecture/embedding-infrastructure-design.md` — transforming `Chunk[]` (produced by `ChunkingPipelineService`) into deterministic, idempotent, resumable `EmbeddingRecord`s via a provider-agnostic embedding pipeline, with no vector database, Postgres/Prisma, retrieval, reranking, LLM generation, conversation, or HTTP API.

**Architecture:** Flat `src/embedding/` feature folder mirroring `src/chunking/`'s and `src/ingestion/`'s established conventions exactly. `EmbeddingPipelineService` reads `*.chunks.json` files from a directory, filters to eligible `'child'`-type chunks, builds provider input text (`buildEmbeddingInput`), skips anything already embedded (resumability via `EmbeddingOutputStoreService.loadExistingEmbeddingIds()`), batches the rest (`EMBEDDING_BATCH_SIZE`), runs each batch through `EmbeddingBatchProcessorService` (concurrency-limited via `p-limit`, retried via `withRetry`, timed out via a `Promise.race`, validated via `validateProviderResponse`), and appends successful `EmbeddingRecord`s to a single `embeddings.jsonl` file. `EMBEDDING_PROVIDER_PORT` is a Symbol-based DI token (mirroring `LENGTH_MEASURER_PORT`) bound by a factory in `EmbeddingModule` to one of `VoyageEmbeddingProviderAdapter` (default), `OpenAiEmbeddingProviderAdapter`, or `FakeEmbeddingProvider`, keyed off `EMBEDDING_PROVIDER` config — proving the pipeline is fully provider-agnostic.

**Tech Stack:** Node 22's native `fetch`/`AbortController` (no new HTTP client dependency), Node's built-in `crypto` (SHA-256 `embeddingId`/`inputHash`) and `fs/promises`, `p-limit` (new dependency — concurrency limiting, already named for exactly this purpose in `docs/architecture/rag-platform-architecture.md` §5).

## Global Constraints

- TypeScript strict mode is enabled project-wide (`strict`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`) — all new code must compile under it.
- ESLint config (`eslint.config.mjs`) sets `@typescript-eslint/no-explicit-any: error`, `@typescript-eslint/no-floating-promises: error`, `@typescript-eslint/no-unsafe-argument: error`, plus `tseslint.configs.recommendedTypeChecked`.
- Jest coverage threshold is 80% branches/functions/lines/statements globally.
- Structured logging convention: inject `PinoLogger` from `nestjs-pino`, call `this.logger.setContext(ClassName.name)` in the constructor, then `this.logger.info(obj, msg)` / `.warn(obj, msg)` / `.debug(obj, msg)`.
- Config convention: all environment variables are validated by the single zod schema in `src/config/env.validation.ts`, wrapped by a dedicated `*ConfigService` exposing typed getters — never read `process.env` directly.
- `.env.example` **cannot be edited by the assistant in this session** — the user's global `~/.claude/settings.json` denies `Read`/`Write`/`Edit` on any `.env*` path. Task 2 documents the exact 16 lines the user must add by hand; until that happens, `src/config/env-example.spec.ts`'s drift-guard test will fail (already failing today for chunking's 7 pending keys). This is not a code defect.
- No vector-database client, Postgres/Prisma, LangChain chain/agent API, or chunking _service_ import anywhere in `src/embedding/` — only a type-only import of `Chunk`/`ChunkMetadata`/`ChunkType`/`HeadingPathSegment` from `src/chunking/chunking.types.ts` (design doc §1).
- `EMBEDDING_API_KEY` must never appear in any log call anywhere in this module (design doc §20) — every task touching a provider adapter or the config service must include a test asserting this.
- No test in the normal `pnpm test`/`pnpm test:e2e` suite may call a real embedding provider — every test uses `FakeEmbeddingProvider` or a mocked `fetch`.
- Commit after each task, following this repo's Conventional Commits history (`feat:`, `test:`, `docs:`, etc.).
- Design doc reference: `docs/architecture/embedding-infrastructure-design.md` — every task below cites the relevant §.

---

### Task 1: Embedding domain types, error taxonomy, and deterministic ID derivation

**Files:**

- Create: `src/embedding/embedding.types.ts`
- Create: `src/embedding/embedding.errors.ts`
- Create: `src/embedding/embedding-id.util.ts`
- Test: `src/embedding/embedding.errors.spec.ts`
- Test: `src/embedding/embedding-id.util.spec.ts`

**Interfaces:**

- Produces: `EmbeddingModelMetadata`, `EmbeddingRecord`, `EmbeddingInput`, `EmbeddingFailure`, `EmbeddingRunResult` (types, design §2); `TransientEmbeddingProviderError`, `RateLimitEmbeddingProviderError`, `PermanentEmbeddingProviderError`, `EmbeddingResponseValidationError`, `EmbeddingThresholdExceededError` (errors, design §9/§15/§23); `deriveEmbeddingId(chunkId, contentHash, modelMetadata): string` (design §12).

- [ ] **Step 1: Write the failing error-taxonomy test**

```typescript
// src/embedding/embedding.errors.spec.ts
import {
  EmbeddingResponseValidationError,
  EmbeddingThresholdExceededError,
  PermanentEmbeddingProviderError,
  RateLimitEmbeddingProviderError,
  TransientEmbeddingProviderError,
} from './embedding.errors';

describe('embedding errors', () => {
  it('TransientEmbeddingProviderError carries name, message, and cause', () => {
    const cause = new Error('ECONNRESET');
    const err = new TransientEmbeddingProviderError('network failure', {
      cause,
    });

    expect(err.name).toBe('TransientEmbeddingProviderError');
    expect(err.message).toBe('network failure');
    expect(err.cause).toBe(cause);
    expect(err).toBeInstanceOf(Error);
  });

  it('RateLimitEmbeddingProviderError is a TransientEmbeddingProviderError and carries retryAfterMs', () => {
    const err = new RateLimitEmbeddingProviderError('rate limited', 2000);

    expect(err.name).toBe('RateLimitEmbeddingProviderError');
    expect(err.retryAfterMs).toBe(2000);
    expect(err).toBeInstanceOf(TransientEmbeddingProviderError);
  });

  it('RateLimitEmbeddingProviderError defaults retryAfterMs to null when the provider gives no hint', () => {
    const err = new RateLimitEmbeddingProviderError('rate limited');

    expect(err.retryAfterMs).toBeNull();
  });

  it('PermanentEmbeddingProviderError is NOT a TransientEmbeddingProviderError', () => {
    const err = new PermanentEmbeddingProviderError('invalid api key');

    expect(err.name).toBe('PermanentEmbeddingProviderError');
    expect(err).not.toBeInstanceOf(TransientEmbeddingProviderError);
  });

  it('EmbeddingResponseValidationError carries name and message', () => {
    const err = new EmbeddingResponseValidationError('dimension mismatch');

    expect(err.name).toBe('EmbeddingResponseValidationError');
    expect(err.message).toBe('dimension mismatch');
    expect(err).not.toBeInstanceOf(TransientEmbeddingProviderError);
  });

  it('EmbeddingThresholdExceededError reports failed/attempted counts in its message', () => {
    const err = new EmbeddingThresholdExceededError(6, 10);

    expect(err.name).toBe('EmbeddingThresholdExceededError');
    expect(err.failedCount).toBe(6);
    expect(err.attemptedCount).toBe(10);
    expect(err.message).toBe(
      'Embedding run aborted: 6/10 chunks failed, exceeding the configured failure threshold',
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- embedding.errors.spec.ts`
Expected: FAIL — `Cannot find module './embedding.errors'`.

- [ ] **Step 3: Create the error taxonomy**

```typescript
// src/embedding/embedding.errors.ts

export class TransientEmbeddingProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransientEmbeddingProviderError';
  }
}

export class RateLimitEmbeddingProviderError extends TransientEmbeddingProviderError {
  public readonly retryAfterMs: number | null;

  constructor(message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = 'RateLimitEmbeddingProviderError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class PermanentEmbeddingProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentEmbeddingProviderError';
  }
}

export class EmbeddingResponseValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingResponseValidationError';
  }
}

export class EmbeddingThresholdExceededError extends Error {
  constructor(
    public readonly failedCount: number,
    public readonly attemptedCount: number,
  ) {
    super(
      `Embedding run aborted: ${failedCount}/${attemptedCount} chunks failed, exceeding the configured failure threshold`,
    );
    this.name = 'EmbeddingThresholdExceededError';
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- embedding.errors.spec.ts`
Expected: PASS, 6/6.

- [ ] **Step 5: Create the domain types file**

```typescript
// src/embedding/embedding.types.ts
import { ChunkType } from '../chunking/chunking.types';

export interface EmbeddingModelMetadata {
  provider: string;
  model: string;
  modelVersion: string;
  dimensions: number;
}

export interface EmbeddingInput {
  chunkId: string;
  documentId: string;
  sourcePath: string;
  contentHash: string;
  text: string;
  inputHash: string;
  tokenCount: number;
  truncated: boolean;
}

export interface EmbeddingRecord {
  embeddingId: string;
  chunkId: string;
  documentId: string;
  sourcePath: string;
  vector: number[];
  dimensions: number;
  provider: string;
  model: string;
  modelVersion: string;
  contentHash: string;
  inputHash: string;
  inputTokenCount: number;
  truncated: boolean;
  createdAt: string;
}

export interface EmbeddingFailure {
  chunkId: string;
  sourcePath: string;
  message: string;
}

export interface EmbeddingRunResult {
  jobId: string;
  totalChunksScanned: number;
  skippedByType: number;
  skippedEmpty: number;
  alreadyEmbedded: number;
  attempted: number;
  succeeded: number;
  failed: number;
  failures: EmbeddingFailure[];
  totalBatches: number;
  provider: string;
  model: string;
  outputPath: string;
  durationMs: number;
}

// Re-exported so consumers of this module never need their own import of
// chunking.types for this one type (design §1: type-only cross-module
// dependency, kept to a single named re-export point).
export type { ChunkType };
```

- [ ] **Step 6: Write the failing `deriveEmbeddingId` test**

```typescript
// src/embedding/embedding-id.util.spec.ts
import { createHash } from 'node:crypto';
import { deriveEmbeddingId } from './embedding-id.util';
import { EmbeddingModelMetadata } from './embedding.types';

const modelMetadata: EmbeddingModelMetadata = {
  provider: 'voyage',
  model: 'voyage-code-3',
  modelVersion: '1',
  dimensions: 1024,
};

describe('deriveEmbeddingId', () => {
  it('produces a deterministic SHA-256 hash of chunkId + contentHash + provider + model + version + dimensions', () => {
    const expected = createHash('sha256')
      .update('chunk1::hash1::voyage::voyage-code-3::1::1024', 'utf-8')
      .digest('hex');

    expect(deriveEmbeddingId('chunk1', 'hash1', modelMetadata)).toBe(expected);
  });

  it('returns the same id for the same inputs across calls', () => {
    expect(deriveEmbeddingId('chunk1', 'hash1', modelMetadata)).toBe(
      deriveEmbeddingId('chunk1', 'hash1', modelMetadata),
    );
  });

  it('changes when chunkId changes', () => {
    expect(deriveEmbeddingId('chunk1', 'hash1', modelMetadata)).not.toBe(
      deriveEmbeddingId('chunk2', 'hash1', modelMetadata),
    );
  });

  it('changes when contentHash changes — this detects a stale embedding after a chunk content edit that did not change chunkId', () => {
    expect(deriveEmbeddingId('chunk1', 'hash1', modelMetadata)).not.toBe(
      deriveEmbeddingId('chunk1', 'hash2', modelMetadata),
    );
  });

  it('changes when provider changes', () => {
    expect(deriveEmbeddingId('chunk1', 'hash1', modelMetadata)).not.toBe(
      deriveEmbeddingId('chunk1', 'hash1', {
        ...modelMetadata,
        provider: 'openai',
      }),
    );
  });

  it('changes when model changes', () => {
    expect(deriveEmbeddingId('chunk1', 'hash1', modelMetadata)).not.toBe(
      deriveEmbeddingId('chunk1', 'hash1', {
        ...modelMetadata,
        model: 'text-embedding-3-large',
      }),
    );
  });

  it('changes when modelVersion changes — a manual version bump forces full re-embedding', () => {
    expect(deriveEmbeddingId('chunk1', 'hash1', modelMetadata)).not.toBe(
      deriveEmbeddingId('chunk1', 'hash1', {
        ...modelMetadata,
        modelVersion: '2',
      }),
    );
  });

  it('changes when dimensions changes', () => {
    expect(deriveEmbeddingId('chunk1', 'hash1', modelMetadata)).not.toBe(
      deriveEmbeddingId('chunk1', 'hash1', {
        ...modelMetadata,
        dimensions: 512,
      }),
    );
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `pnpm test -- embedding-id.util.spec.ts`
Expected: FAIL — `Cannot find module './embedding-id.util'`.

- [ ] **Step 8: Implement `deriveEmbeddingId`**

```typescript
// src/embedding/embedding-id.util.ts
import { createHash } from 'node:crypto';
import { EmbeddingModelMetadata } from './embedding.types';

export function deriveEmbeddingId(
  chunkId: string,
  contentHash: string,
  modelMetadata: EmbeddingModelMetadata,
): string {
  return createHash('sha256')
    .update(
      `${chunkId}::${contentHash}::${modelMetadata.provider}::${modelMetadata.model}::${modelMetadata.modelVersion}::${modelMetadata.dimensions}`,
      'utf-8',
    )
    .digest('hex');
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `pnpm test -- embedding-id.util.spec.ts`
Expected: PASS, 8/8.

- [ ] **Step 10: Commit**

```bash
git add src/embedding/embedding.types.ts src/embedding/embedding.errors.ts src/embedding/embedding.errors.spec.ts src/embedding/embedding-id.util.ts src/embedding/embedding-id.util.spec.ts
git commit -m "feat(embedding): add domain types, error taxonomy, and deterministic embeddingId derivation"
```

---

### Task 2: `EmbeddingConfigService` and env schema extension

**Files:**

- Modify: `src/config/env.validation.ts`
- Create: `src/embedding/embedding-config.service.ts`
- Test: `src/embedding/embedding-config.service.spec.ts`
- Modify (documentation only, blocked — see below): `.env.example`
- Modify: `README.md`

**Interfaces:**

- Consumes: `EnvConfig` (from `../config/env.validation`).
- Produces: `EmbeddingConfigService` with typed getters: `provider`, `model`, `modelVersion`, `dimensions`, `apiKey`, `baseUrl`, `batchSize`, `maxConcurrentBatches`, `maxRetries`, `retryBaseDelayMs`, `retryMaxDelayMs`, `requestTimeoutMs`, `inputMaxTokens`, `includeHeadingContext`, `chunkTypes: ChunkType[]`, `outputDir`, `failureThreshold`.

- [ ] **Step 1: Write the failing config-service test**

```typescript
// src/embedding/embedding-config.service.spec.ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- embedding-config.service.spec.ts`
Expected: FAIL — `Cannot find module './embedding-config.service'`.

- [ ] **Step 3: Extend the env schema**

Modify `src/config/env.validation.ts` — add these fields inside the existing `z.object({ ... })` (after `CHUNKING_OUTPUT_DIR`, before the closing `})`), and extend the existing `.refine()` chain with one more `.refine()` call for the retry-delay ordering check:

```typescript
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
    EMBEDDING_FAILURE_THRESHOLD: z.coerce
      .number()
      .min(0)
      .max(1)
      .default(0.5),
```

And add this `.refine()` immediately after the existing `CHUNKING_MIN_CHUNK_SIZE`/`CHUNKING_MAX_CHUNK_SIZE` one (chain a second `.refine()` call onto the same schema):

```typescript
  .refine(
    (config) =>
      config.EMBEDDING_RETRY_BASE_DELAY_MS < config.EMBEDDING_RETRY_MAX_DELAY_MS,
    {
      message:
        'EMBEDDING_RETRY_BASE_DELAY_MS must be less than EMBEDDING_RETRY_MAX_DELAY_MS',
      path: ['EMBEDDING_RETRY_BASE_DELAY_MS'],
    },
  );
```

(Remove the trailing `;` from the first `.refine()` call and chain the second one directly onto it, exactly as `z` fluent chains normally compose — there is only ever one final `;` at the end of the whole `envSchema` declaration.)

- [ ] **Step 4: Create `EmbeddingConfigService`**

```typescript
// src/embedding/embedding-config.service.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from '../config/env.validation';
import { ChunkType } from './embedding.types';

@Injectable()
export class EmbeddingConfigService {
  constructor(private readonly configService: ConfigService<EnvConfig, true>) {}

  get provider(): EnvConfig['EMBEDDING_PROVIDER'] {
    return this.configService.get('EMBEDDING_PROVIDER', { infer: true });
  }

  get model(): string {
    return this.configService.get('EMBEDDING_MODEL', { infer: true });
  }

  get modelVersion(): string {
    return this.configService.get('EMBEDDING_MODEL_VERSION', { infer: true });
  }

  get dimensions(): number {
    return this.configService.get('EMBEDDING_DIMENSIONS', { infer: true });
  }

  get apiKey(): string {
    return this.configService.get('EMBEDDING_API_KEY', { infer: true });
  }

  get baseUrl(): string {
    return this.configService.get('EMBEDDING_BASE_URL', { infer: true });
  }

  get batchSize(): number {
    return this.configService.get('EMBEDDING_BATCH_SIZE', { infer: true });
  }

  get maxConcurrentBatches(): number {
    return this.configService.get('EMBEDDING_MAX_CONCURRENT_BATCHES', {
      infer: true,
    });
  }

  get maxRetries(): number {
    return this.configService.get('EMBEDDING_MAX_RETRIES', { infer: true });
  }

  get retryBaseDelayMs(): number {
    return this.configService.get('EMBEDDING_RETRY_BASE_DELAY_MS', {
      infer: true,
    });
  }

  get retryMaxDelayMs(): number {
    return this.configService.get('EMBEDDING_RETRY_MAX_DELAY_MS', {
      infer: true,
    });
  }

  get requestTimeoutMs(): number {
    return this.configService.get('EMBEDDING_REQUEST_TIMEOUT_MS', {
      infer: true,
    });
  }

  get inputMaxTokens(): number {
    return this.configService.get('EMBEDDING_INPUT_MAX_TOKENS', {
      infer: true,
    });
  }

  get includeHeadingContext(): boolean {
    return this.configService.get('EMBEDDING_INCLUDE_HEADING_CONTEXT', {
      infer: true,
    });
  }

  get chunkTypes(): ChunkType[] {
    return this.configService.get('EMBEDDING_CHUNK_TYPES', { infer: true });
  }

  get outputDir(): string {
    return this.configService.get('EMBEDDING_OUTPUT_DIR', { infer: true });
  }

  get failureThreshold(): number {
    return this.configService.get('EMBEDDING_FAILURE_THRESHOLD', {
      infer: true,
    });
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test -- embedding-config.service.spec.ts`
Expected: PASS, 2/2.

- [ ] **Step 6: Document the required `.env.example` lines (manual step, blocked by permissions)**

This assistant cannot edit `.env.example` in this session. Print this exact block for the user to append by hand:

```
EMBEDDING_PROVIDER=voyage
EMBEDDING_MODEL=voyage-code-3
EMBEDDING_MODEL_VERSION=1
EMBEDDING_DIMENSIONS=1024
EMBEDDING_API_KEY=
EMBEDDING_BASE_URL=
EMBEDDING_BATCH_SIZE=128
EMBEDDING_MAX_CONCURRENT_BATCHES=5
EMBEDDING_MAX_RETRIES=5
EMBEDDING_RETRY_BASE_DELAY_MS=500
EMBEDDING_RETRY_MAX_DELAY_MS=30000
EMBEDDING_REQUEST_TIMEOUT_MS=30000
EMBEDDING_INPUT_MAX_TOKENS=8000
EMBEDDING_INCLUDE_HEADING_CONTEXT=true
EMBEDDING_CHUNK_TYPES=child
EMBEDDING_OUTPUT_DIR=./data/embedding-output
EMBEDDING_FAILURE_THRESHOLD=0.5
```

Until this is added, `src/config/env-example.spec.ts` fails (as it already does today for chunking's 7 pending keys) — a known, non-code-defect blocker, not something to work around by weakening the drift-guard test.

- [ ] **Step 7: Update the README's configuration table**

Modify `README.md` to add a row (or table section) documenting the 16 new `EMBEDDING_*` variables, following the exact same table format already used for the `CHUNKING_*`/`INGESTION_*` variables elsewhere in the file.

- [ ] **Step 8: Run the full config test suite**

Run: `pnpm test -- env.validation.spec.ts embedding-config.service.spec.ts`
Expected: PASS (both files). `env-example.spec.ts` is expected to still fail until the manual `.env.example` step above is done by the user — this is pre-existing, documented behavior, not a regression introduced by this task.

- [ ] **Step 9: Commit**

```bash
git add src/config/env.validation.ts src/embedding/embedding-config.service.ts src/embedding/embedding-config.service.spec.ts README.md
git commit -m "feat(embedding): add EmbeddingConfigService and extend env schema with 16 EMBEDDING_* variables"
```

---

### Task 3: Embedding input preparation

**Files:**

- Create: `src/embedding/embedding-input-builder.util.ts`
- Test: `src/embedding/embedding-input-builder.util.spec.ts`

**Interfaces:**

- Consumes: `Chunk` (type-only, from `../chunking/chunking.types`), `EmbeddingInput` (Task 1).
- Produces: `estimateTokenCount(text: string): number`, `buildEmbeddingInput(chunk: Chunk, options: { includeHeadingContext: boolean; maxInputTokens: number }): EmbeddingInput | null`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/embedding/embedding-input-builder.util.spec.ts
import { createHash } from 'node:crypto';
import { Chunk } from '../chunking/chunking.types';
import {
  buildEmbeddingInput,
  estimateTokenCount,
} from './embedding-input-builder.util';

function buildChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    chunkId: 'chunk1',
    text: '## Install Docker Engine\n\nRun `docker --version` to verify.',
    metadata: {
      documentId: 'doc1',
      sourcePath: 'install.md',
      documentTitle: 'Install',
      headingPath: [
        {
          level: 1,
          text: 'Install Docker Engine',
          anchor: 'install-docker-engine',
        },
        { level: 2, text: 'On Ubuntu', anchor: 'on-ubuntu' },
      ],
      chunkType: 'child',
      contentTypes: ['paragraph', 'code'],
      length: 40,
      sequenceIndex: 0,
      wasSplit: false,
      wasMerged: false,
      mergedHeadings: [],
      exceedsMaxSize: false,
      contentHash: 'contenthash1',
      chunkedAt: '2026-01-01T00:00:00.000Z',
    },
    relationships: {
      parentChunkId: null,
      childChunkIds: [],
      previousChunkId: null,
      nextChunkId: null,
    },
    ...overrides,
  };
}

describe('estimateTokenCount', () => {
  it('estimates roughly 4 characters per token', () => {
    expect(estimateTokenCount('a'.repeat(400))).toBe(100);
  });

  it('returns 0 for an empty string', () => {
    expect(estimateTokenCount('')).toBe(0);
  });
});

describe('buildEmbeddingInput', () => {
  const config = { includeHeadingContext: true, maxInputTokens: 8000 };

  it('copies chunkId, documentId, sourcePath, and contentHash from the chunk', () => {
    const input = buildEmbeddingInput(buildChunk(), config);

    expect(input?.chunkId).toBe('chunk1');
    expect(input?.documentId).toBe('doc1');
    expect(input?.sourcePath).toBe('install.md');
    expect(input?.contentHash).toBe('contenthash1');
  });

  it('prefixes the heading-path breadcrumb when includeHeadingContext is true', () => {
    const input = buildEmbeddingInput(buildChunk(), config);

    expect(input?.text.startsWith('Install Docker Engine › On Ubuntu')).toBe(
      true,
    );
    expect(input?.text).toContain('Run `docker --version` to verify.');
  });

  it('omits the breadcrumb when includeHeadingContext is false', () => {
    const input = buildEmbeddingInput(buildChunk(), {
      ...config,
      includeHeadingContext: false,
    });

    expect(input?.text.startsWith('Install Docker Engine ›')).toBe(false);
    expect(input?.text).toContain('Run `docker --version` to verify.');
  });

  it('omits the breadcrumb for a root-section chunk with an empty headingPath', () => {
    const input = buildEmbeddingInput(
      buildChunk({
        metadata: { ...buildChunk().metadata, headingPath: [] },
      }),
      config,
    );

    expect(input?.text).toBe(buildChunk().text);
  });

  it('normalizes 3+ consecutive newlines down to 2 and trims the result', () => {
    const chunk = buildChunk({
      text: '  paragraph one\n\n\n\nparagraph two  \n\n',
    });
    const input = buildEmbeddingInput(chunk, {
      ...config,
      includeHeadingContext: false,
    });

    expect(input?.text).toBe('paragraph one\n\nparagraph two');
  });

  it('returns null for a chunk whose text is empty after normalization', () => {
    const chunk = buildChunk({ text: '   \n\n  ' });
    const input = buildEmbeddingInput(chunk, {
      ...config,
      includeHeadingContext: false,
    });

    expect(input).toBeNull();
  });

  it('computes inputHash as the SHA-256 of the final prepared text', () => {
    const input = buildEmbeddingInput(buildChunk(), {
      ...config,
      includeHeadingContext: false,
    });
    const expected = createHash('sha256')
      .update(input!.text, 'utf-8')
      .digest('hex');

    expect(input?.inputHash).toBe(expected);
  });

  it('sets tokenCount to estimateTokenCount(finalText)', () => {
    const input = buildEmbeddingInput(buildChunk(), {
      ...config,
      includeHeadingContext: false,
    });

    expect(input?.tokenCount).toBe(estimateTokenCount(input!.text));
  });

  it('does not truncate text within the token limit', () => {
    const input = buildEmbeddingInput(buildChunk(), config);

    expect(input?.truncated).toBe(false);
  });

  it('truncates text exceeding maxInputTokens at a whitespace boundary and sets truncated true', () => {
    const longText = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ');
    const chunk = buildChunk({ text: longText });
    const input = buildEmbeddingInput(chunk, {
      includeHeadingContext: false,
      maxInputTokens: 10, // ~40 characters
    });

    expect(input?.truncated).toBe(true);
    expect(input!.text.length).toBeLessThanOrEqual(40);
    expect(input!.text.endsWith(' ')).toBe(false);
    expect(input!.text.includes('word0')).toBe(true);
  });

  it('never truncates mid-word', () => {
    const longText = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ');
    const chunk = buildChunk({ text: longText });
    const input = buildEmbeddingInput(chunk, {
      includeHeadingContext: false,
      maxInputTokens: 10,
    });

    const lastChar = input!.text[input!.text.length - 1]!;
    expect(longText.includes(input!.text)).toBe(true);
    expect(/\S/.test(lastChar)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- embedding-input-builder.util.spec.ts`
Expected: FAIL — `Cannot find module './embedding-input-builder.util'`.

- [ ] **Step 3: Implement `buildEmbeddingInput`**

```typescript
// src/embedding/embedding-input-builder.util.ts
import { createHash } from 'node:crypto';
import { Chunk } from '../chunking/chunking.types';
import { EmbeddingInput } from './embedding.types';

const CHARS_PER_APPROX_TOKEN = 4;

// Deliberately duplicates chunking's approx-token heuristic rather than
// importing LengthMeasurerPort from src/chunking/ — this module must stay
// completely independent of chunking's runtime code (design §6). The
// duplication is 3 lines and the two heuristics are free to diverge later.
export function estimateTokenCount(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return Math.ceil(text.length / CHARS_PER_APPROX_TOKEN);
}

function normalize(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncateToTokenLimit(
  text: string,
  maxInputTokens: number,
): { text: string; truncated: boolean } {
  const maxChars = maxInputTokens * CHARS_PER_APPROX_TOKEN;
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  const slice = text.slice(0, maxChars);
  const lastWhitespace = slice.search(/\s\S*$/);
  const safeSlice = lastWhitespace > 0 ? slice.slice(0, lastWhitespace) : slice;
  return { text: safeSlice.trimEnd(), truncated: true };
}

export function buildEmbeddingInput(
  chunk: Chunk,
  options: { includeHeadingContext: boolean; maxInputTokens: number },
): EmbeddingInput | null {
  const breadcrumb = chunk.metadata.headingPath
    .map((segment) => segment.text)
    .join(' › ');

  const withContext =
    options.includeHeadingContext && breadcrumb.length > 0
      ? `${breadcrumb}\n\n${chunk.text}`
      : chunk.text;

  const normalized = normalize(withContext);
  if (normalized.length === 0) {
    return null;
  }

  const { text: finalText, truncated } = truncateToTokenLimit(
    normalized,
    options.maxInputTokens,
  );

  return {
    chunkId: chunk.chunkId,
    documentId: chunk.metadata.documentId,
    sourcePath: chunk.metadata.sourcePath,
    contentHash: chunk.metadata.contentHash,
    text: finalText,
    inputHash: createHash('sha256').update(finalText, 'utf-8').digest('hex'),
    tokenCount: estimateTokenCount(finalText),
    truncated,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- embedding-input-builder.util.spec.ts`
Expected: PASS, 13/13.

- [ ] **Step 5: Commit**

```bash
git add src/embedding/embedding-input-builder.util.ts src/embedding/embedding-input-builder.util.spec.ts
git commit -m "feat(embedding): add embedding input preparation (heading context, normalization, truncation)"
```

---

### Task 4: `EmbeddingProviderPort` and `FakeEmbeddingProvider`

**Files:**

- Create: `src/embedding/embedding-provider.port.ts`
- Create: `src/embedding/providers/fake-embedding-provider.ts`
- Test: `src/embedding/providers/fake-embedding-provider.spec.ts`

**Interfaces:**

- Consumes: `EmbeddingModelMetadata` (Task 1), `TransientEmbeddingProviderError` (Task 1).
- Produces: `EMBEDDING_PROVIDER_PORT` (Symbol), `EmbeddingProviderRequestItem`, `EmbeddingProviderResponseItem`, `EmbeddingProviderPort` interface; `FakeEmbeddingProvider` class.

- [ ] **Step 1: Write the failing test**

```typescript
// src/embedding/providers/fake-embedding-provider.spec.ts
import { TransientEmbeddingProviderError } from '../embedding.errors';
import { FakeEmbeddingProvider } from './fake-embedding-provider';

const metadata = {
  provider: 'fake',
  model: 'fake-model',
  modelVersion: '1',
  dimensions: 8,
};

describe('FakeEmbeddingProvider', () => {
  it('exposes the metadata it was constructed with', () => {
    const provider = new FakeEmbeddingProvider(metadata);

    expect(provider.metadata).toBe(metadata);
  });

  it('returns one deterministic vector per input, matching the configured dimensions', async () => {
    const provider = new FakeEmbeddingProvider(metadata);

    const result = await provider.embed([
      { id: 'a', text: 'hello' },
      { id: 'b', text: 'world' },
    ]);

    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe('a');
    expect(result[0]!.vector).toHaveLength(8);
    expect(result[1]!.id).toBe('b');
  });

  it('is deterministic — the same text always produces the same vector', async () => {
    const provider = new FakeEmbeddingProvider(metadata);

    const first = await provider.embed([{ id: 'a', text: 'hello' }]);
    const second = await provider.embed([{ id: 'a', text: 'hello' }]);

    expect(first[0]!.vector).toEqual(second[0]!.vector);
  });

  it('produces different vectors for different text', async () => {
    const provider = new FakeEmbeddingProvider(metadata);

    const result = await provider.embed([
      { id: 'a', text: 'hello' },
      { id: 'b', text: 'goodbye' },
    ]);

    expect(result[0]!.vector).not.toEqual(result[1]!.vector);
  });

  it('can be configured to fail its first N calls with a given error, then succeed', async () => {
    const provider = new FakeEmbeddingProvider(metadata, {
      failFirstNCalls: 2,
      failWith: () =>
        new TransientEmbeddingProviderError('fake transient failure'),
    });

    await expect(provider.embed([{ id: 'a', text: 'x' }])).rejects.toThrow(
      TransientEmbeddingProviderError,
    );
    await expect(provider.embed([{ id: 'a', text: 'x' }])).rejects.toThrow(
      TransientEmbeddingProviderError,
    );
    await expect(
      provider.embed([{ id: 'a', text: 'x' }]),
    ).resolves.toHaveLength(1);
  });

  it('can be configured with an artificial delay, for testing timeout handling', async () => {
    const provider = new FakeEmbeddingProvider(metadata, { delayMs: 20 });
    const startedAt = Date.now();

    await provider.embed([{ id: 'a', text: 'x' }]);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- fake-embedding-provider.spec.ts`
Expected: FAIL — `Cannot find module '../embedding.errors'` resolution succeeds, but `Cannot find module './fake-embedding-provider'` fails.

- [ ] **Step 3: Create the port**

```typescript
// src/embedding/embedding-provider.port.ts
import { EmbeddingModelMetadata } from './embedding.types';

export const EMBEDDING_PROVIDER_PORT = Symbol('EMBEDDING_PROVIDER_PORT');

export interface EmbeddingProviderRequestItem {
  id: string;
  text: string;
}

export interface EmbeddingProviderResponseItem {
  id: string;
  vector: number[];
}

export interface EmbeddingProviderPort {
  readonly metadata: EmbeddingModelMetadata;
  embed(
    items: EmbeddingProviderRequestItem[],
    signal?: AbortSignal,
  ): Promise<EmbeddingProviderResponseItem[]>;
}
```

- [ ] **Step 4: Implement `FakeEmbeddingProvider`**

```typescript
// src/embedding/providers/fake-embedding-provider.ts
import { createHash } from 'node:crypto';
import {
  EmbeddingProviderPort,
  EmbeddingProviderRequestItem,
  EmbeddingProviderResponseItem,
} from '../embedding-provider.port';
import { TransientEmbeddingProviderError } from '../embedding.errors';
import { EmbeddingModelMetadata } from '../embedding.types';

export interface FakeEmbeddingProviderOptions {
  failFirstNCalls?: number;
  failWith?: () => Error;
  delayMs?: number;
}

export class FakeEmbeddingProvider implements EmbeddingProviderPort {
  private callCount = 0;

  constructor(
    public readonly metadata: EmbeddingModelMetadata,
    private readonly options: FakeEmbeddingProviderOptions = {},
  ) {}

  async embed(
    items: EmbeddingProviderRequestItem[],
  ): Promise<EmbeddingProviderResponseItem[]> {
    this.callCount += 1;

    if (this.options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    }

    if (
      this.options.failFirstNCalls &&
      this.callCount <= this.options.failFirstNCalls
    ) {
      throw this.options.failWith
        ? this.options.failWith()
        : new TransientEmbeddingProviderError('fake transient failure');
    }

    return items.map((item) => ({
      id: item.id,
      vector: this.deterministicVector(item.text),
    }));
  }

  private deterministicVector(text: string): number[] {
    const hash = createHash('sha256').update(text, 'utf-8').digest();
    const vector: number[] = [];
    for (let i = 0; i < this.metadata.dimensions; i += 1) {
      vector.push((hash[i % hash.length]! / 255) * 2 - 1);
    }
    return vector;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test -- fake-embedding-provider.spec.ts`
Expected: PASS, 6/6.

- [ ] **Step 6: Commit**

```bash
git add src/embedding/embedding-provider.port.ts src/embedding/providers/fake-embedding-provider.ts src/embedding/providers/fake-embedding-provider.spec.ts
git commit -m "feat(embedding): add EmbeddingProviderPort and FakeEmbeddingProvider test double"
```

---

### Task 5: Provider response validation

**Files:**

- Create: `src/embedding/embedding-response-validator.util.ts`
- Test: `src/embedding/embedding-response-validator.util.spec.ts`

**Interfaces:**

- Consumes: `EmbeddingProviderRequestItem`, `EmbeddingProviderResponseItem` (Task 4), `EmbeddingResponseValidationError` (Task 1).
- Produces: `validateProviderResponse(requestItems, responseItems, expectedDimensions): void`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/embedding/embedding-response-validator.util.spec.ts
import { EmbeddingResponseValidationError } from './embedding.errors';
import { validateProviderResponse } from './embedding-response-validator.util';

const requestItems = [
  { id: 'a', text: 'hello' },
  { id: 'b', text: 'world' },
];

function validResponse() {
  return [
    { id: 'a', vector: [0.1, 0.2] },
    { id: 'b', vector: [0.3, 0.4] },
  ];
}

describe('validateProviderResponse', () => {
  it('does not throw for a valid, correctly-ordered, correctly-dimensioned response', () => {
    expect(() =>
      validateProviderResponse(requestItems, validResponse(), 2),
    ).not.toThrow();
  });

  it('throws when the response has fewer items than requested', () => {
    expect(() =>
      validateProviderResponse(requestItems, [validResponse()[0]!], 2),
    ).toThrow(EmbeddingResponseValidationError);
  });

  it('throws when the response has more items than requested', () => {
    expect(() =>
      validateProviderResponse(
        requestItems,
        [...validResponse(), { id: 'c', vector: [0.5, 0.6] }],
        2,
      ),
    ).toThrow(EmbeddingResponseValidationError);
  });

  it('throws when response ordering does not match request ordering', () => {
    const reordered = [validResponse()[1]!, validResponse()[0]!];

    expect(() => validateProviderResponse(requestItems, reordered, 2)).toThrow(
      EmbeddingResponseValidationError,
    );
  });

  it('throws when a vector is missing (empty array)', () => {
    const response = [{ id: 'a', vector: [] }, validResponse()[1]!];

    expect(() => validateProviderResponse(requestItems, response, 2)).toThrow(
      EmbeddingResponseValidationError,
    );
  });

  it('throws when a vector has the wrong dimension', () => {
    const response = [
      { id: 'a', vector: [0.1, 0.2, 0.3] },
      validResponse()[1]!,
    ];

    expect(() => validateProviderResponse(requestItems, response, 2)).toThrow(
      EmbeddingResponseValidationError,
    );
  });

  it('throws when a vector contains a non-finite value', () => {
    const response = [
      { id: 'a', vector: [0.1, Infinity] },
      validResponse()[1]!,
    ];

    expect(() => validateProviderResponse(requestItems, response, 2)).toThrow(
      EmbeddingResponseValidationError,
    );
  });

  it('throws when a vector contains a NaN value', () => {
    const response = [
      { id: 'a', vector: [0.1, Number.NaN] },
      validResponse()[1]!,
    ];

    expect(() => validateProviderResponse(requestItems, response, 2)).toThrow(
      EmbeddingResponseValidationError,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- embedding-response-validator.util.spec.ts`
Expected: FAIL — `Cannot find module './embedding-response-validator.util'`.

- [ ] **Step 3: Implement `validateProviderResponse`**

```typescript
// src/embedding/embedding-response-validator.util.ts
import {
  EmbeddingProviderRequestItem,
  EmbeddingProviderResponseItem,
} from './embedding-provider.port';
import { EmbeddingResponseValidationError } from './embedding.errors';

export function validateProviderResponse(
  requestItems: EmbeddingProviderRequestItem[],
  responseItems: EmbeddingProviderResponseItem[],
  expectedDimensions: number,
): void {
  if (responseItems.length !== requestItems.length) {
    throw new EmbeddingResponseValidationError(
      `Provider returned ${responseItems.length} embeddings for ${requestItems.length} requested inputs`,
    );
  }

  requestItems.forEach((requestItem, index) => {
    const responseItem = responseItems[index]!;

    if (responseItem.id !== requestItem.id) {
      throw new EmbeddingResponseValidationError(
        `Provider response ordering mismatch at index ${index}: expected id "${requestItem.id}", got "${responseItem.id}"`,
      );
    }

    if (
      !Array.isArray(responseItem.vector) ||
      responseItem.vector.length === 0
    ) {
      throw new EmbeddingResponseValidationError(
        `Missing vector for chunk "${requestItem.id}"`,
      );
    }

    if (responseItem.vector.length !== expectedDimensions) {
      throw new EmbeddingResponseValidationError(
        `Vector for chunk "${requestItem.id}" has ${responseItem.vector.length} dimensions, expected ${expectedDimensions}`,
      );
    }

    if (
      responseItem.vector.some(
        (value) => typeof value !== 'number' || !Number.isFinite(value),
      )
    ) {
      throw new EmbeddingResponseValidationError(
        `Vector for chunk "${requestItem.id}" contains a non-numeric or non-finite value`,
      );
    }
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- embedding-response-validator.util.spec.ts`
Expected: PASS, 8/8.

- [ ] **Step 5: Commit**

```bash
git add src/embedding/embedding-response-validator.util.ts src/embedding/embedding-response-validator.util.spec.ts
git commit -m "feat(embedding): add provider response validation"
```

---

### Task 6: Retry with exponential backoff

**Files:**

- Create: `src/embedding/retry.util.ts`
- Test: `src/embedding/retry.util.spec.ts`

**Interfaces:**

- Consumes: `TransientEmbeddingProviderError`, `RateLimitEmbeddingProviderError`, `PermanentEmbeddingProviderError` (Task 1).
- Produces: `RetryOptions`, `withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T>`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/embedding/retry.util.spec.ts
import {
  PermanentEmbeddingProviderError,
  RateLimitEmbeddingProviderError,
  TransientEmbeddingProviderError,
} from './embedding.errors';
import { withRetry } from './retry.util';

function noopSleep() {
  const calls: number[] = [];
  const sleep = (ms: number) => {
    calls.push(ms);
    return Promise.resolve();
  };
  return { sleep, calls };
}

describe('withRetry', () => {
  it('returns the result on the first successful attempt without sleeping', async () => {
    const { sleep, calls } = noopSleep();
    const fn = jest.fn().mockResolvedValue('ok');

    const result = await withRetry(fn, {
      maxAttempts: 5,
      baseDelayMs: 10,
      maxDelayMs: 1000,
      sleep,
    });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it('retries a transient error up to maxAttempts, then succeeds', async () => {
    const { sleep } = noopSleep();
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new TransientEmbeddingProviderError('fail 1'))
      .mockRejectedValueOnce(new TransientEmbeddingProviderError('fail 2'))
      .mockResolvedValueOnce('ok');

    const result = await withRetry(fn, {
      maxAttempts: 5,
      baseDelayMs: 10,
      maxDelayMs: 1000,
      sleep,
    });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('rethrows a transient error once maxAttempts is exhausted', async () => {
    const { sleep } = noopSleep();
    const fn = jest
      .fn()
      .mockRejectedValue(new TransientEmbeddingProviderError('always fails'));

    await expect(
      withRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 10,
        maxDelayMs: 1000,
        sleep,
      }),
    ).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('never retries a PermanentEmbeddingProviderError — fails on the first attempt', async () => {
    const { sleep } = noopSleep();
    const fn = jest
      .fn()
      .mockRejectedValue(new PermanentEmbeddingProviderError('bad api key'));

    await expect(
      withRetry(fn, {
        maxAttempts: 5,
        baseDelayMs: 10,
        maxDelayMs: 1000,
        sleep,
      }),
    ).rejects.toThrow('bad api key');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses RateLimitEmbeddingProviderError.retryAfterMs verbatim instead of computed backoff, when present', async () => {
    const { sleep, calls } = noopSleep();
    const fn = jest
      .fn()
      .mockRejectedValueOnce(
        new RateLimitEmbeddingProviderError('slow down', 777),
      )
      .mockResolvedValueOnce('ok');

    await withRetry(fn, {
      maxAttempts: 5,
      baseDelayMs: 10,
      maxDelayMs: 1000,
      sleep,
    });

    expect(calls).toEqual([777]);
  });

  it('computes exponential backoff capped at maxDelayMs when no retryAfterMs is given', async () => {
    const { sleep, calls } = noopSleep();
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new TransientEmbeddingProviderError('fail 1'))
      .mockRejectedValueOnce(new TransientEmbeddingProviderError('fail 2'))
      .mockResolvedValueOnce('ok');

    await withRetry(fn, {
      maxAttempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 150,
      sleep,
    });

    expect(calls[0]).toBeLessThanOrEqual(100);
    expect(calls[1]).toBeLessThanOrEqual(150);
  });

  it('defaults to a real timer-based sleep when none is injected', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new TransientEmbeddingProviderError('fail once'))
      .mockResolvedValueOnce('ok');

    const startedAt = Date.now();
    await withRetry(fn, { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 20 });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(0);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- retry.util.spec.ts`
Expected: FAIL — `Cannot find module './retry.util'`.

- [ ] **Step 3: Implement `withRetry`**

```typescript
// src/embedding/retry.util.ts
import {
  RateLimitEmbeddingProviderError,
  TransientEmbeddingProviderError,
} from './embedding.errors';

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  let attempt = 0;

  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;

      if (
        !(err instanceof TransientEmbeddingProviderError) ||
        attempt >= options.maxAttempts
      ) {
        throw err;
      }

      const retryAfterMs =
        err instanceof RateLimitEmbeddingProviderError
          ? err.retryAfterMs
          : null;
      const backoff = Math.min(
        options.baseDelayMs * 2 ** (attempt - 1),
        options.maxDelayMs,
      );

      await sleep(retryAfterMs ?? backoff);
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- retry.util.spec.ts`
Expected: PASS, 7/7.

- [ ] **Step 5: Commit**

```bash
git add src/embedding/retry.util.ts src/embedding/retry.util.spec.ts
git commit -m "feat(embedding): add withRetry with exponential backoff and transient/permanent classification"
```

---

### Task 7: `EmbeddingOutputStoreService` — JSONL persistence and resumability

**Files:**

- Create: `src/embedding/embedding-output-store.service.ts`
- Test: `src/embedding/embedding-output-store.service.spec.ts`

**Interfaces:**

- Consumes: `EmbeddingConfigService` (Task 2), `EmbeddingRecord` (Task 1).
- Produces: `EmbeddingOutputStoreService` with `loadExistingEmbeddingIds(): Promise<Set<string>>`, `append(record: EmbeddingRecord): Promise<void>`, `outputFilePath(): string`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/embedding/embedding-output-store.service.spec.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendFile, mkdir } from 'node:fs/promises';
import { PinoLogger } from 'nestjs-pino';
import { EmbeddingConfigService } from './embedding-config.service';
import { EmbeddingOutputStoreService } from './embedding-output-store.service';
import { EmbeddingRecord } from './embedding.types';

function buildRecord(
  overrides: Partial<EmbeddingRecord> = {},
): EmbeddingRecord {
  return {
    embeddingId: 'emb1',
    chunkId: 'chunk1',
    documentId: 'doc1',
    sourcePath: 'install.md',
    vector: [0.1, 0.2],
    dimensions: 2,
    provider: 'fake',
    model: 'fake-model',
    modelVersion: '1',
    contentHash: 'hash1',
    inputHash: 'inputhash1',
    inputTokenCount: 10,
    truncated: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('EmbeddingOutputStoreService', () => {
  let outputDir: string;
  let logger: PinoLogger;

  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'embedding-output-store-'));
    logger = {
      setContext: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
    } as unknown as PinoLogger;
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  function buildStore(): EmbeddingOutputStoreService {
    const config = { outputDir } as EmbeddingConfigService;
    return new EmbeddingOutputStoreService(config, logger);
  }

  it('returns an empty set when no output file exists yet', async () => {
    const store = buildStore();

    const ids = await store.loadExistingEmbeddingIds();

    expect(ids.size).toBe(0);
  });

  it('appends a record and loads its embeddingId back', async () => {
    const store = buildStore();

    await store.append(buildRecord());
    const ids = await store.loadExistingEmbeddingIds();

    expect(ids.has('emb1')).toBe(true);
  });

  it('accumulates multiple appended records', async () => {
    const store = buildStore();

    await store.append(buildRecord({ embeddingId: 'emb1' }));
    await store.append(buildRecord({ embeddingId: 'emb2' }));
    const ids = await store.loadExistingEmbeddingIds();

    expect(ids).toEqual(new Set(['emb1', 'emb2']));
  });

  it('tolerates a truncated final line and logs a warning, excluding it from the result', async () => {
    await mkdir(outputDir, { recursive: true });
    const filePath = join(outputDir, 'embeddings.jsonl');
    await appendFile(
      filePath,
      `${JSON.stringify(buildRecord({ embeddingId: 'emb1' }))}\n{"embeddingId": "emb2", "trunca`,
      'utf-8',
    );
    const store = buildStore();

    const ids = await store.loadExistingEmbeddingIds();

    expect(ids).toEqual(new Set(['emb1']));
    expect(logger.warn).toHaveBeenCalled();
  });

  it('throws when a non-final line is corrupt', async () => {
    await mkdir(outputDir, { recursive: true });
    const filePath = join(outputDir, 'embeddings.jsonl');
    await appendFile(
      filePath,
      `{"embeddingId": "broken\n${JSON.stringify(buildRecord({ embeddingId: 'emb2' }))}\n`,
      'utf-8',
    );
    const store = buildStore();

    await expect(store.loadExistingEmbeddingIds()).rejects.toThrow();
  });

  it('serializes concurrent appends without interleaving partial lines', async () => {
    const store = buildStore();

    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.append(buildRecord({ embeddingId: `emb${i}` })),
      ),
    );
    const ids = await store.loadExistingEmbeddingIds();

    expect(ids.size).toBe(20);
  });

  it('reports the output file path under the configured output directory', () => {
    const store = buildStore();

    expect(store.outputFilePath()).toBe(join(outputDir, 'embeddings.jsonl'));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- embedding-output-store.service.spec.ts`
Expected: FAIL — `Cannot find module './embedding-output-store.service'`.

- [ ] **Step 3: Implement `EmbeddingOutputStoreService`**

```typescript
// src/embedding/embedding-output-store.service.ts
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { EmbeddingConfigService } from './embedding-config.service';
import { EmbeddingRecord } from './embedding.types';

@Injectable()
export class EmbeddingOutputStoreService {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: EmbeddingConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(EmbeddingOutputStoreService.name);
  }

  outputFilePath(): string {
    return join(this.config.outputDir, 'embeddings.jsonl');
  }

  async loadExistingEmbeddingIds(): Promise<Set<string>> {
    const filePath = this.outputFilePath();
    const ids = new Set<string>();

    let raw: string;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return ids;
      }
      throw err;
    }

    const lines = raw.split('\n').filter((line) => line.trim().length > 0);
    lines.forEach((line, index) => {
      try {
        const record = JSON.parse(line) as EmbeddingRecord;
        ids.add(record.embeddingId);
      } catch (err) {
        if (index === lines.length - 1) {
          this.logger.warn(
            { filePath },
            'Ignoring truncated final line in embedding output (likely an interrupted previous run)',
          );
        } else {
          throw new Error(
            `Corrupt embedding output at ${filePath}, line ${index + 1}`,
            { cause: err },
          );
        }
      }
    });

    return ids;
  }

  append(record: EmbeddingRecord): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(this.config.outputDir, { recursive: true });
      await appendFile(
        this.outputFilePath(),
        `${JSON.stringify(record)}\n`,
        'utf-8',
      );
    });
    return this.writeQueue;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- embedding-output-store.service.spec.ts`
Expected: PASS, 7/7.

- [ ] **Step 5: Commit**

```bash
git add src/embedding/embedding-output-store.service.ts src/embedding/embedding-output-store.service.spec.ts
git commit -m "feat(embedding): add EmbeddingOutputStoreService for JSONL persistence and resumability"
```

---

### Task 8: `EmbeddingBatchProcessorService` — retry, timeout, and validation orchestration

**Files:**

- Create: `src/embedding/embedding-batch-processor.service.ts`
- Test: `src/embedding/embedding-batch-processor.service.spec.ts`

**Interfaces:**

- Consumes: `EMBEDDING_PROVIDER_PORT`/`EmbeddingProviderPort` (Task 4), `EmbeddingConfigService` (Task 2), `withRetry` (Task 6), `validateProviderResponse` (Task 5), `deriveEmbeddingId` (Task 1), `EmbeddingInput`/`EmbeddingRecord`/`EmbeddingFailure` (Task 1), `FakeEmbeddingProvider` (Task 4).
- Produces: `EmbeddingBatchOutcome { batchId: string; succeeded: EmbeddingRecord[]; failed: EmbeddingFailure[] }`, `EmbeddingBatchProcessorService.processBatch(batchId: string, inputs: EmbeddingInput[]): Promise<EmbeddingBatchOutcome>`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/embedding/embedding-batch-processor.service.spec.ts
import { PinoLogger } from 'nestjs-pino';
import { EmbeddingConfigService } from './embedding-config.service';
import { EmbeddingBatchProcessorService } from './embedding-batch-processor.service';
import { PermanentEmbeddingProviderError } from './embedding.errors';
import { EmbeddingInput } from './embedding.types';
import { FakeEmbeddingProvider } from './providers/fake-embedding-provider';

function buildInput(overrides: Partial<EmbeddingInput> = {}): EmbeddingInput {
  return {
    chunkId: 'chunk1',
    documentId: 'doc1',
    sourcePath: 'install.md',
    contentHash: 'hash1',
    text: 'Run docker --version',
    inputHash: 'inputhash1',
    tokenCount: 5,
    truncated: false,
    ...overrides,
  };
}

function buildConfig(
  overrides: Partial<EmbeddingConfigService> = {},
): EmbeddingConfigService {
  return {
    maxRetries: 3,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 5,
    requestTimeoutMs: 50,
    ...overrides,
  } as EmbeddingConfigService;
}

function buildLogger(): PinoLogger {
  return {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  } as unknown as PinoLogger;
}

const metadata = {
  provider: 'fake',
  model: 'fake-model',
  modelVersion: '1',
  dimensions: 4,
};

describe('EmbeddingBatchProcessorService', () => {
  it('produces one EmbeddingRecord per input on a successful batch', async () => {
    const provider = new FakeEmbeddingProvider(metadata);
    const service = new EmbeddingBatchProcessorService(
      provider,
      buildConfig(),
      buildLogger(),
    );

    const outcome = await service.processBatch('batch-0', [buildInput()]);

    expect(outcome.failed).toEqual([]);
    expect(outcome.succeeded).toHaveLength(1);
    expect(outcome.succeeded[0]!.chunkId).toBe('chunk1');
    expect(outcome.succeeded[0]!.vector).toHaveLength(4);
    expect(outcome.succeeded[0]!.provider).toBe('fake');
    expect(outcome.succeeded[0]!.model).toBe('fake-model');
    expect(outcome.succeeded[0]!.contentHash).toBe('hash1');
    expect(outcome.succeeded[0]!.inputTokenCount).toBe(5);
  });

  it('retries a batch that fails transiently, then succeeds, reporting a full success', async () => {
    const provider = new FakeEmbeddingProvider(metadata, {
      failFirstNCalls: 2,
    });
    const service = new EmbeddingBatchProcessorService(
      provider,
      buildConfig(),
      buildLogger(),
    );

    const outcome = await service.processBatch('batch-0', [buildInput()]);

    expect(outcome.succeeded).toHaveLength(1);
    expect(outcome.failed).toEqual([]);
  });

  it('reports every input in the batch as failed when the provider fails permanently', async () => {
    const provider = new FakeEmbeddingProvider(metadata, {
      failFirstNCalls: 999,
      failWith: () => new PermanentEmbeddingProviderError('invalid api key'),
    });
    const service = new EmbeddingBatchProcessorService(
      provider,
      buildConfig(),
      buildLogger(),
    );

    const outcome = await service.processBatch('batch-0', [
      buildInput(),
      buildInput({ chunkId: 'chunk2' }),
    ]);

    expect(outcome.succeeded).toEqual([]);
    expect(outcome.failed).toHaveLength(2);
    expect(outcome.failed[0]!.message).toContain('invalid api key');
  });

  it('reports every input as failed after exhausting retries on a persistently transient failure', async () => {
    const provider = new FakeEmbeddingProvider(metadata, {
      failFirstNCalls: 999,
    });
    const service = new EmbeddingBatchProcessorService(
      provider,
      buildConfig({ maxRetries: 2 }),
      buildLogger(),
    );

    const outcome = await service.processBatch('batch-0', [buildInput()]);

    expect(outcome.succeeded).toEqual([]);
    expect(outcome.failed).toHaveLength(1);
  });

  it('treats a provider that never responds within requestTimeoutMs as a transient, retried failure', async () => {
    const provider = new FakeEmbeddingProvider(metadata, { delayMs: 200 });
    const service = new EmbeddingBatchProcessorService(
      provider,
      buildConfig({ requestTimeoutMs: 20, maxRetries: 1 }),
      buildLogger(),
    );

    const outcome = await service.processBatch('batch-0', [buildInput()]);

    expect(outcome.succeeded).toEqual([]);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]!.message).toContain('timed out');
  });

  it('never throws out of processBatch itself — failures are always returned, not thrown', async () => {
    const provider = new FakeEmbeddingProvider(metadata, {
      failFirstNCalls: 999,
      failWith: () => new PermanentEmbeddingProviderError('boom'),
    });
    const service = new EmbeddingBatchProcessorService(
      provider,
      buildConfig(),
      buildLogger(),
    );

    await expect(
      service.processBatch('batch-0', [buildInput()]),
    ).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- embedding-batch-processor.service.spec.ts`
Expected: FAIL — `Cannot find module './embedding-batch-processor.service'`.

- [ ] **Step 3: Implement `EmbeddingBatchProcessorService`**

```typescript
// src/embedding/embedding-batch-processor.service.ts
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { EmbeddingConfigService } from './embedding-config.service';
import {
  EMBEDDING_PROVIDER_PORT,
  EmbeddingProviderPort,
  EmbeddingProviderRequestItem,
  EmbeddingProviderResponseItem,
} from './embedding-provider.port';
import { validateProviderResponse } from './embedding-response-validator.util';
import { deriveEmbeddingId } from './embedding-id.util';
import { TransientEmbeddingProviderError } from './embedding.errors';
import {
  EmbeddingFailure,
  EmbeddingInput,
  EmbeddingRecord,
} from './embedding.types';
import { withRetry } from './retry.util';

export interface EmbeddingBatchOutcome {
  batchId: string;
  succeeded: EmbeddingRecord[];
  failed: EmbeddingFailure[];
}

@Injectable()
export class EmbeddingBatchProcessorService {
  constructor(
    @Inject(EMBEDDING_PROVIDER_PORT)
    private readonly provider: EmbeddingProviderPort,
    private readonly config: EmbeddingConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(EmbeddingBatchProcessorService.name);
  }

  async processBatch(
    batchId: string,
    inputs: EmbeddingInput[],
  ): Promise<EmbeddingBatchOutcome> {
    const requestItems: EmbeddingProviderRequestItem[] = inputs.map(
      (input) => ({
        id: input.chunkId,
        text: input.text,
      }),
    );

    try {
      const responseItems = await withRetry(
        () => this.embedWithTimeout(requestItems),
        {
          maxAttempts: this.config.maxRetries,
          baseDelayMs: this.config.retryBaseDelayMs,
          maxDelayMs: this.config.retryMaxDelayMs,
        },
      );

      validateProviderResponse(
        requestItems,
        responseItems,
        this.provider.metadata.dimensions,
      );

      const succeeded = inputs.map((input, index) =>
        this.toRecord(input, responseItems[index]!.vector),
      );
      return { batchId, succeeded, failed: [] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        { batchId, chunkCount: inputs.length, error: message },
        'Embedding batch failed permanently after retries',
      );
      return {
        batchId,
        succeeded: [],
        failed: inputs.map((input) => ({
          chunkId: input.chunkId,
          sourcePath: input.sourcePath,
          message,
        })),
      };
    }
  }

  private embedWithTimeout(
    items: EmbeddingProviderRequestItem[],
  ): Promise<EmbeddingProviderResponseItem[]> {
    const controller = new AbortController();
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        controller.abort();
        reject(
          new TransientEmbeddingProviderError(
            `Embedding request timed out after ${this.config.requestTimeoutMs}ms`,
          ),
        );
      }, this.config.requestTimeoutMs);
    });

    return Promise.race([
      this.provider.embed(items, controller.signal),
      timeoutPromise,
    ]);
  }

  private toRecord(input: EmbeddingInput, vector: number[]): EmbeddingRecord {
    const modelMetadata = this.provider.metadata;
    return {
      embeddingId: deriveEmbeddingId(
        input.chunkId,
        input.contentHash,
        modelMetadata,
      ),
      chunkId: input.chunkId,
      documentId: input.documentId,
      sourcePath: input.sourcePath,
      vector,
      dimensions: modelMetadata.dimensions,
      provider: modelMetadata.provider,
      model: modelMetadata.model,
      modelVersion: modelMetadata.modelVersion,
      contentHash: input.contentHash,
      inputHash: input.inputHash,
      inputTokenCount: input.tokenCount,
      truncated: input.truncated,
      createdAt: new Date().toISOString(),
    };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- embedding-batch-processor.service.spec.ts`
Expected: PASS, 6/6.

- [ ] **Step 5: Commit**

```bash
git add src/embedding/embedding-batch-processor.service.ts src/embedding/embedding-batch-processor.service.spec.ts
git commit -m "feat(embedding): add EmbeddingBatchProcessorService with retry, timeout, and validation"
```

---

### Task 9: `p-limit` dependency and `EmbeddingPipelineService` orchestrator

**Files:**

- Modify: `package.json` (add `p-limit` dependency)
- Create: `src/embedding/embedding-pipeline.service.ts`
- Test: `src/embedding/embedding-pipeline.service.spec.ts`

**Interfaces:**

- Consumes: `EmbeddingConfigService` (Task 2), `EmbeddingOutputStoreService` (Task 7), `EmbeddingBatchProcessorService` (Task 8), `EMBEDDING_PROVIDER_PORT`/`EmbeddingProviderPort` (Task 4), `buildEmbeddingInput` (Task 3), `deriveEmbeddingId` (Task 1), `EmbeddingThresholdExceededError` (Task 1), `Chunk` (type-only, `../chunking/chunking.types`).
- Produces: `EmbeddingPipelineService.run(chunksDir: string): Promise<EmbeddingRunResult>`.

- [ ] **Step 1: Install `p-limit`**

Run: `pnpm add p-limit`
Expected: `package.json`'s `dependencies` gains `"p-limit": "^<version>"`.

- [ ] **Step 2: Write the failing test**

```typescript
// src/embedding/embedding-pipeline.service.spec.ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PinoLogger } from 'nestjs-pino';
import { Chunk } from '../chunking/chunking.types';
import { EmbeddingBatchProcessorService } from './embedding-batch-processor.service';
import { EmbeddingConfigService } from './embedding-config.service';
import { EmbeddingOutputStoreService } from './embedding-output-store.service';
import { EmbeddingThresholdExceededError } from './embedding.errors';
import { EmbeddingPipelineService } from './embedding-pipeline.service';
import { PermanentEmbeddingProviderError } from './embedding.errors';
import { FakeEmbeddingProvider } from './providers/fake-embedding-provider';

function buildChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    chunkId: overrides.chunkId ?? 'chunk1',
    text: 'Run `docker --version` to verify the installation.',
    metadata: {
      documentId: 'doc1',
      sourcePath: 'install.md',
      documentTitle: 'Install',
      headingPath: [{ level: 1, text: 'Install', anchor: 'install' }],
      chunkType: 'child',
      contentTypes: ['paragraph'],
      length: 40,
      sequenceIndex: 0,
      wasSplit: false,
      wasMerged: false,
      mergedHeadings: [],
      exceedsMaxSize: false,
      contentHash: 'contenthash1',
      chunkedAt: '2026-01-01T00:00:00.000Z',
    },
    relationships: {
      parentChunkId: null,
      childChunkIds: [],
      previousChunkId: null,
      nextChunkId: null,
    },
    ...overrides,
  } as Chunk;
}

function buildConfig(
  overrides: Partial<EmbeddingConfigService> = {},
): EmbeddingConfigService {
  return {
    batchSize: 10,
    maxConcurrentBatches: 2,
    maxRetries: 2,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 5,
    requestTimeoutMs: 1000,
    inputMaxTokens: 8000,
    includeHeadingContext: false,
    chunkTypes: ['child'],
    failureThreshold: 0.5,
    ...overrides,
  } as EmbeddingConfigService;
}

function buildLogger(): PinoLogger {
  return {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  } as unknown as PinoLogger;
}

const metadata = {
  provider: 'fake',
  model: 'fake-model',
  modelVersion: '1',
  dimensions: 4,
};

describe('EmbeddingPipelineService', () => {
  let chunksDir: string;
  let outputDir: string;

  beforeEach(async () => {
    chunksDir = await mkdtemp(join(tmpdir(), 'embedding-pipeline-chunks-'));
    outputDir = await mkdtemp(join(tmpdir(), 'embedding-pipeline-output-'));
  });

  afterEach(async () => {
    await rm(chunksDir, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });
  });

  function buildPipeline(
    provider: FakeEmbeddingProvider,
    configOverrides: Partial<EmbeddingConfigService> = {},
  ) {
    const outputConfig = { outputDir } as EmbeddingConfigService;
    const config = buildConfig(configOverrides);
    const logger = buildLogger();
    const outputStore = new EmbeddingOutputStoreService(outputConfig, logger);
    const batchProcessor = new EmbeddingBatchProcessorService(
      provider,
      config,
      logger,
    );
    return new EmbeddingPipelineService(
      config,
      outputStore,
      batchProcessor,
      provider,
      logger,
    );
  }

  it('embeds only child-type chunks by default, skipping parent-type chunks', async () => {
    await writeFile(
      join(chunksDir, 'doc1.chunks.json'),
      JSON.stringify([
        buildChunk({ chunkId: 'child1' }),
        buildChunk({
          chunkId: 'parent1',
          metadata: { ...buildChunk().metadata, chunkType: 'parent' },
        }),
      ]),
    );
    const provider = new FakeEmbeddingProvider(metadata);
    const pipeline = buildPipeline(provider);

    const result = await pipeline.run(chunksDir);

    expect(result.totalChunksScanned).toBe(2);
    expect(result.skippedByType).toBe(1);
    expect(result.attempted).toBe(1);
    expect(result.succeeded).toBe(1);
  });

  it('satisfies the accounting invariant: scanned = skippedByType + skippedEmpty + alreadyEmbedded + attempted', async () => {
    await writeFile(
      join(chunksDir, 'doc1.chunks.json'),
      JSON.stringify([
        buildChunk({ chunkId: 'child1' }),
        buildChunk({ chunkId: 'child2', text: '   ' }),
        buildChunk({
          chunkId: 'parent1',
          metadata: { ...buildChunk().metadata, chunkType: 'parent' },
        }),
      ]),
    );
    const provider = new FakeEmbeddingProvider(metadata);
    const pipeline = buildPipeline(provider);

    const result = await pipeline.run(chunksDir);

    expect(result.totalChunksScanned).toBe(
      result.skippedByType +
        result.skippedEmpty +
        result.alreadyEmbedded +
        result.attempted,
    );
  });

  it('skips a chunk whose text is empty after normalization, recording it as skippedEmpty', async () => {
    await writeFile(
      join(chunksDir, 'doc1.chunks.json'),
      JSON.stringify([buildChunk({ chunkId: 'child1', text: '   \n\n  ' })]),
    );
    const provider = new FakeEmbeddingProvider(metadata);
    const pipeline = buildPipeline(provider);

    const result = await pipeline.run(chunksDir);

    expect(result.skippedEmpty).toBe(1);
    expect(result.attempted).toBe(0);
  });

  it('writes exactly one EmbeddingRecord per successfully embedded chunk', async () => {
    await writeFile(
      join(chunksDir, 'doc1.chunks.json'),
      JSON.stringify([buildChunk({ chunkId: 'child1' })]),
    );
    const provider = new FakeEmbeddingProvider(metadata);
    const pipeline = buildPipeline(provider);

    const result = await pipeline.run(chunksDir);

    expect(result.outputPath).toContain('embeddings.jsonl');
    const outputStore = new EmbeddingOutputStoreService(
      { outputDir } as EmbeddingConfigService,
      buildLogger(),
    );
    const ids = await outputStore.loadExistingEmbeddingIds();
    expect(ids.size).toBe(1);
  });

  it('is resumable — a second run against the same output embeds zero new chunks', async () => {
    await writeFile(
      join(chunksDir, 'doc1.chunks.json'),
      JSON.stringify([buildChunk({ chunkId: 'child1' })]),
    );
    const provider = new FakeEmbeddingProvider(metadata);

    const firstResult = await buildPipeline(provider).run(chunksDir);
    expect(firstResult.attempted).toBe(1);
    expect(firstResult.succeeded).toBe(1);

    const secondResult = await buildPipeline(provider).run(chunksDir);
    expect(secondResult.attempted).toBe(0);
    expect(secondResult.alreadyEmbedded).toBe(1);
  });

  it('throws EmbeddingThresholdExceededError when the failure rate exceeds the configured threshold', async () => {
    await writeFile(
      join(chunksDir, 'doc1.chunks.json'),
      JSON.stringify([
        buildChunk({ chunkId: 'child1' }),
        buildChunk({ chunkId: 'child2' }),
      ]),
    );
    const provider = new FakeEmbeddingProvider(metadata, {
      failFirstNCalls: 999,
      failWith: () => new PermanentEmbeddingProviderError('boom'),
    });
    const pipeline = buildPipeline(provider, {
      failureThreshold: 0.1,
      batchSize: 1,
    });

    await expect(pipeline.run(chunksDir)).rejects.toThrow(
      EmbeddingThresholdExceededError,
    );
  });

  it('scans multiple chunk files across multiple documents', async () => {
    await writeFile(
      join(chunksDir, 'doc1.chunks.json'),
      JSON.stringify([buildChunk({ chunkId: 'doc1-child1' })]),
    );
    await writeFile(
      join(chunksDir, 'doc2.chunks.json'),
      JSON.stringify([
        buildChunk({
          chunkId: 'doc2-child1',
          metadata: { ...buildChunk().metadata, documentId: 'doc2' },
        }),
      ]),
    );
    const provider = new FakeEmbeddingProvider(metadata);
    const pipeline = buildPipeline(provider);

    const result = await pipeline.run(chunksDir);

    expect(result.totalChunksScanned).toBe(2);
    expect(result.succeeded).toBe(2);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test -- embedding-pipeline.service.spec.ts`
Expected: FAIL — `Cannot find module './embedding-pipeline.service'`.

- [ ] **Step 4: Implement `EmbeddingPipelineService`**

```typescript
// src/embedding/embedding-pipeline.service.ts
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import pLimit from 'p-limit';
import { Chunk } from '../chunking/chunking.types';
import { EmbeddingBatchProcessorService } from './embedding-batch-processor.service';
import { EmbeddingConfigService } from './embedding-config.service';
import {
  EMBEDDING_PROVIDER_PORT,
  EmbeddingProviderPort,
} from './embedding-provider.port';
import { buildEmbeddingInput } from './embedding-input-builder.util';
import { deriveEmbeddingId } from './embedding-id.util';
import { EmbeddingOutputStoreService } from './embedding-output-store.service';
import { EmbeddingThresholdExceededError } from './embedding.errors';
import {
  EmbeddingFailure,
  EmbeddingInput,
  EmbeddingRunResult,
} from './embedding.types';

function chunkArray<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

@Injectable()
export class EmbeddingPipelineService {
  constructor(
    private readonly config: EmbeddingConfigService,
    private readonly outputStore: EmbeddingOutputStoreService,
    private readonly batchProcessor: EmbeddingBatchProcessorService,
    @Inject(EMBEDDING_PROVIDER_PORT)
    private readonly provider: EmbeddingProviderPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(EmbeddingPipelineService.name);
  }

  async run(chunksDir: string): Promise<EmbeddingRunResult> {
    const startedAt = Date.now();
    const jobId = randomUUID();

    this.logger.info(
      {
        jobId,
        provider: this.provider.metadata.provider,
        model: this.provider.metadata.model,
        chunksDir,
      },
      'Embedding run started',
    );

    const existingIds = await this.outputStore.loadExistingEmbeddingIds();

    let totalChunksScanned = 0;
    let skippedByType = 0;
    let skippedEmpty = 0;
    let alreadyEmbedded = 0;
    const eligibleInputs: EmbeddingInput[] = [];

    const files = (await readdir(chunksDir)).filter((file) =>
      file.endsWith('.chunks.json'),
    );
    for (const file of files) {
      const raw = await readFile(join(chunksDir, file), 'utf-8');
      const chunks = JSON.parse(raw) as Chunk[];

      for (const chunk of chunks) {
        totalChunksScanned += 1;

        if (!this.config.chunkTypes.includes(chunk.metadata.chunkType)) {
          skippedByType += 1;
          continue;
        }

        const input = buildEmbeddingInput(chunk, {
          includeHeadingContext: this.config.includeHeadingContext,
          maxInputTokens: this.config.inputMaxTokens,
        });
        if (!input) {
          skippedEmpty += 1;
          this.logger.debug(
            { chunkId: chunk.chunkId },
            'Skipping empty chunk — nothing to embed',
          );
          continue;
        }

        const embeddingId = deriveEmbeddingId(
          input.chunkId,
          input.contentHash,
          this.provider.metadata,
        );
        if (existingIds.has(embeddingId)) {
          alreadyEmbedded += 1;
          continue;
        }

        eligibleInputs.push(input);
      }
    }

    const batches = chunkArray(eligibleInputs, this.config.batchSize);
    const limit = pLimit(this.config.maxConcurrentBatches);
    let succeededCount = 0;
    const failures: EmbeddingFailure[] = [];

    await Promise.all(
      batches.map((batchInputs, index) =>
        limit(async () => {
          const batchId = `${jobId}-${index}`;
          const outcome = await this.batchProcessor.processBatch(
            batchId,
            batchInputs,
          );

          for (const record of outcome.succeeded) {
            await this.outputStore.append(record);
          }
          succeededCount += outcome.succeeded.length;
          failures.push(...outcome.failed);

          this.logger.info(
            {
              jobId,
              batchId,
              chunkCount: batchInputs.length,
              succeeded: outcome.succeeded.length,
              failed: outcome.failed.length,
              provider: this.provider.metadata.provider,
              model: this.provider.metadata.model,
            },
            'Embedding batch completed',
          );
        }),
      ),
    );

    const attempted = eligibleInputs.length;
    if (
      attempted > 0 &&
      failures.length / attempted > this.config.failureThreshold
    ) {
      throw new EmbeddingThresholdExceededError(failures.length, attempted);
    }

    const result: EmbeddingRunResult = {
      jobId,
      totalChunksScanned,
      skippedByType,
      skippedEmpty,
      alreadyEmbedded,
      attempted,
      succeeded: succeededCount,
      failed: failures.length,
      failures,
      totalBatches: batches.length,
      provider: this.provider.metadata.provider,
      model: this.provider.metadata.model,
      outputPath: this.outputStore.outputFilePath(),
      durationMs: Date.now() - startedAt,
    };

    this.logger.info(
      { ...result, failures: undefined },
      'Embedding run completed',
    );
    return result;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test -- embedding-pipeline.service.spec.ts`
Expected: PASS, 7/7.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/embedding/embedding-pipeline.service.ts src/embedding/embedding-pipeline.service.spec.ts
git commit -m "feat(embedding): add EmbeddingPipelineService orchestrator with p-limit concurrency"
```

---

### Task 10: `VoyageEmbeddingProviderAdapter` and `OpenAiEmbeddingProviderAdapter`

**Files:**

- Create: `src/embedding/providers/voyage-embedding-provider.adapter.ts`
- Create: `src/embedding/providers/openai-embedding-provider.adapter.ts`
- Test: `src/embedding/providers/voyage-embedding-provider.adapter.spec.ts`
- Test: `src/embedding/providers/openai-embedding-provider.adapter.spec.ts`

**Interfaces:**

- Consumes: `EmbeddingProviderPort`, `EmbeddingProviderRequestItem`, `EmbeddingProviderResponseItem` (Task 4), `TransientEmbeddingProviderError`, `RateLimitEmbeddingProviderError`, `PermanentEmbeddingProviderError` (Task 1), `EmbeddingModelMetadata` (Task 1).
- Produces: `VoyageEmbeddingProviderAdapter`, `OpenAiEmbeddingProviderAdapter`, both implementing `EmbeddingProviderPort`, constructed with `(apiKey: string, metadata: EmbeddingModelMetadata, baseUrl?: string)`.

- [ ] **Step 1: Write the failing Voyage adapter test**

```typescript
// src/embedding/providers/voyage-embedding-provider.adapter.spec.ts
import {
  PermanentEmbeddingProviderError,
  RateLimitEmbeddingProviderError,
  TransientEmbeddingProviderError,
} from '../embedding.errors';
import { VoyageEmbeddingProviderAdapter } from './voyage-embedding-provider.adapter';

const metadata = {
  provider: 'voyage',
  model: 'voyage-code-3',
  modelVersion: '1',
  dimensions: 4,
};

function mockFetchOnce(response: {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}) {
  return jest.spyOn(global, 'fetch').mockResolvedValueOnce({
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    headers: { get: (name: string) => response.headers?.[name] ?? null },
    json: () => Promise.resolve(response.body),
  } as unknown as Response);
}

describe('VoyageEmbeddingProviderAdapter', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends the expected request shape and reconstructs id-tagged output from the positional response', async () => {
    const fetchSpy = mockFetchOnce({
      status: 200,
      body: {
        data: [{ embedding: [0.1, 0.2, 0.3, 0.4], index: 0 }],
        model: 'voyage-code-3',
      },
    });
    const adapter = new VoyageEmbeddingProviderAdapter('secret-key', metadata);

    const result = await adapter.embed([{ id: 'chunk1', text: 'hello' }]);

    expect(result).toEqual([{ id: 'chunk1', vector: [0.1, 0.2, 0.3, 0.4] }]);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.voyageai.com/v1/embeddings');
    expect((init!.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer secret-key',
    );
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      input: ['hello'],
      model: 'voyage-code-3',
      output_dimension: 4,
    });
  });

  it("reorders a provider response that does not preserve request order, using each item's own index", async () => {
    mockFetchOnce({
      status: 200,
      body: {
        data: [
          { embedding: [9, 9, 9, 9], index: 1 },
          { embedding: [1, 1, 1, 1], index: 0 },
        ],
      },
    });
    const adapter = new VoyageEmbeddingProviderAdapter('secret-key', metadata);

    const result = await adapter.embed([
      { id: 'a', text: 'first' },
      { id: 'b', text: 'second' },
    ]);

    expect(result).toEqual([
      { id: 'a', vector: [1, 1, 1, 1] },
      { id: 'b', vector: [9, 9, 9, 9] },
    ]);
  });

  it('maps a 401 response to PermanentEmbeddingProviderError', async () => {
    mockFetchOnce({ status: 401, body: { error: 'invalid api key' } });
    const adapter = new VoyageEmbeddingProviderAdapter('bad-key', metadata);

    await expect(adapter.embed([{ id: 'a', text: 'x' }])).rejects.toThrow(
      PermanentEmbeddingProviderError,
    );
  });

  it('maps a 400 response to PermanentEmbeddingProviderError', async () => {
    mockFetchOnce({ status: 400, body: { error: 'invalid input' } });
    const adapter = new VoyageEmbeddingProviderAdapter('secret-key', metadata);

    await expect(adapter.embed([{ id: 'a', text: 'x' }])).rejects.toThrow(
      PermanentEmbeddingProviderError,
    );
  });

  it('maps a 429 response to RateLimitEmbeddingProviderError, parsing Retry-After when present', async () => {
    mockFetchOnce({
      status: 429,
      body: { error: 'rate limited' },
      headers: { 'retry-after': '3' },
    });
    const adapter = new VoyageEmbeddingProviderAdapter('secret-key', metadata);

    await expect(adapter.embed([{ id: 'a', text: 'x' }])).rejects.toThrow(
      RateLimitEmbeddingProviderError,
    );
  });

  it('maps a 500 response to TransientEmbeddingProviderError', async () => {
    mockFetchOnce({ status: 500, body: { error: 'internal error' } });
    const adapter = new VoyageEmbeddingProviderAdapter('secret-key', metadata);

    await expect(adapter.embed([{ id: 'a', text: 'x' }])).rejects.toThrow(
      TransientEmbeddingProviderError,
    );
  });

  it('maps a network-level fetch rejection to TransientEmbeddingProviderError', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ECONNRESET'));
    const adapter = new VoyageEmbeddingProviderAdapter('secret-key', metadata);

    await expect(adapter.embed([{ id: 'a', text: 'x' }])).rejects.toThrow(
      TransientEmbeddingProviderError,
    );
  });

  it('never includes the API key in any thrown error message', async () => {
    mockFetchOnce({ status: 401, body: { error: 'invalid api key' } });
    const adapter = new VoyageEmbeddingProviderAdapter(
      'super-secret-key-value',
      metadata,
    );

    try {
      await adapter.embed([{ id: 'a', text: 'x' }]);
      fail('expected embed() to throw');
    } catch (err) {
      expect((err as Error).message).not.toContain('super-secret-key-value');
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- voyage-embedding-provider.adapter.spec.ts`
Expected: FAIL — `Cannot find module './voyage-embedding-provider.adapter'`.

- [ ] **Step 3: Implement `VoyageEmbeddingProviderAdapter`**

```typescript
// src/embedding/providers/voyage-embedding-provider.adapter.ts
import {
  EmbeddingProviderPort,
  EmbeddingProviderRequestItem,
  EmbeddingProviderResponseItem,
} from '../embedding-provider.port';
import {
  PermanentEmbeddingProviderError,
  RateLimitEmbeddingProviderError,
  TransientEmbeddingProviderError,
} from '../embedding.errors';
import { EmbeddingModelMetadata } from '../embedding.types';

interface VoyageResponseBody {
  data: { embedding: number[]; index: number }[];
}

const DEFAULT_BASE_URL = 'https://api.voyageai.com/v1/embeddings';

export class VoyageEmbeddingProviderAdapter implements EmbeddingProviderPort {
  constructor(
    private readonly apiKey: string,
    public readonly metadata: EmbeddingModelMetadata,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
  ) {}

  async embed(
    items: EmbeddingProviderRequestItem[],
    signal?: AbortSignal,
  ): Promise<EmbeddingProviderResponseItem[]> {
    let response: Response;
    try {
      response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          input: items.map((item) => item.text),
          model: this.metadata.model,
          input_type: 'document',
          output_dimension: this.metadata.dimensions,
        }),
        signal,
      });
    } catch (err) {
      throw new TransientEmbeddingProviderError(
        'Voyage embeddings request failed',
        {
          cause: err,
        },
      );
    }

    if (!response.ok) {
      throw await this.toError(response);
    }

    const body = (await response.json()) as VoyageResponseBody;
    return items.map((item, index) => {
      const entry = body.data.find((candidate) => candidate.index === index);
      return { id: item.id, vector: entry?.embedding ?? [] };
    });
  }

  private async toError(response: Response): Promise<Error> {
    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterMs = retryAfterHeader
        ? Number(retryAfterHeader) * 1000
        : null;
      return new RateLimitEmbeddingProviderError(
        'Voyage rate limit exceeded',
        retryAfterMs,
      );
    }
    if (response.status >= 500) {
      return new TransientEmbeddingProviderError(
        `Voyage embeddings request failed with status ${response.status}`,
      );
    }
    return new PermanentEmbeddingProviderError(
      `Voyage embeddings request failed with status ${response.status}`,
    );
  }
}
```

- [ ] **Step 4: Run the Voyage adapter test to verify it passes**

Run: `pnpm test -- voyage-embedding-provider.adapter.spec.ts`
Expected: PASS, 8/8.

- [ ] **Step 5: Write the failing OpenAI adapter test**

```typescript
// src/embedding/providers/openai-embedding-provider.adapter.spec.ts
import {
  PermanentEmbeddingProviderError,
  RateLimitEmbeddingProviderError,
  TransientEmbeddingProviderError,
} from '../embedding.errors';
import { OpenAiEmbeddingProviderAdapter } from './openai-embedding-provider.adapter';

const metadata = {
  provider: 'openai',
  model: 'text-embedding-3-large',
  modelVersion: '1',
  dimensions: 4,
};

function mockFetchOnce(response: {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}) {
  return jest.spyOn(global, 'fetch').mockResolvedValueOnce({
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    headers: { get: (name: string) => response.headers?.[name] ?? null },
    json: () => Promise.resolve(response.body),
  } as unknown as Response);
}

describe('OpenAiEmbeddingProviderAdapter', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends the expected request shape and reconstructs id-tagged output', async () => {
    const fetchSpy = mockFetchOnce({
      status: 200,
      body: { data: [{ embedding: [0.1, 0.2, 0.3, 0.4], index: 0 }] },
    });
    const adapter = new OpenAiEmbeddingProviderAdapter('secret-key', metadata);

    const result = await adapter.embed([{ id: 'chunk1', text: 'hello' }]);

    expect(result).toEqual([{ id: 'chunk1', vector: [0.1, 0.2, 0.3, 0.4] }]);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/embeddings');
    expect((init!.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer secret-key',
    );
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      input: ['hello'],
      model: 'text-embedding-3-large',
      dimensions: 4,
    });
  });

  it('honors a custom baseUrl, enabling a self-hosted OpenAI-compatible endpoint', async () => {
    const fetchSpy = mockFetchOnce({
      status: 200,
      body: { data: [{ embedding: [0.1, 0.2, 0.3, 0.4], index: 0 }] },
    });
    const adapter = new OpenAiEmbeddingProviderAdapter(
      'secret-key',
      metadata,
      'http://localhost:8080/v1/embeddings',
    );

    await adapter.embed([{ id: 'chunk1', text: 'hello' }]);

    expect(fetchSpy.mock.calls[0]![0]).toBe(
      'http://localhost:8080/v1/embeddings',
    );
  });

  it('maps a 401 response to PermanentEmbeddingProviderError', async () => {
    mockFetchOnce({ status: 401, body: { error: 'invalid api key' } });
    const adapter = new OpenAiEmbeddingProviderAdapter('bad-key', metadata);

    await expect(adapter.embed([{ id: 'a', text: 'x' }])).rejects.toThrow(
      PermanentEmbeddingProviderError,
    );
  });

  it('maps a 429 response to RateLimitEmbeddingProviderError', async () => {
    mockFetchOnce({ status: 429, body: { error: 'rate limited' } });
    const adapter = new OpenAiEmbeddingProviderAdapter('secret-key', metadata);

    await expect(adapter.embed([{ id: 'a', text: 'x' }])).rejects.toThrow(
      RateLimitEmbeddingProviderError,
    );
  });

  it('maps a 500 response to TransientEmbeddingProviderError', async () => {
    mockFetchOnce({ status: 500, body: { error: 'internal error' } });
    const adapter = new OpenAiEmbeddingProviderAdapter('secret-key', metadata);

    await expect(adapter.embed([{ id: 'a', text: 'x' }])).rejects.toThrow(
      TransientEmbeddingProviderError,
    );
  });

  it('never includes the API key in any thrown error message', async () => {
    mockFetchOnce({ status: 401, body: { error: 'invalid api key' } });
    const adapter = new OpenAiEmbeddingProviderAdapter(
      'super-secret-key-value',
      metadata,
    );

    try {
      await adapter.embed([{ id: 'a', text: 'x' }]);
      fail('expected embed() to throw');
    } catch (err) {
      expect((err as Error).message).not.toContain('super-secret-key-value');
    }
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `pnpm test -- openai-embedding-provider.adapter.spec.ts`
Expected: FAIL — `Cannot find module './openai-embedding-provider.adapter'`.

- [ ] **Step 7: Implement `OpenAiEmbeddingProviderAdapter`**

```typescript
// src/embedding/providers/openai-embedding-provider.adapter.ts
import {
  EmbeddingProviderPort,
  EmbeddingProviderRequestItem,
  EmbeddingProviderResponseItem,
} from '../embedding-provider.port';
import {
  PermanentEmbeddingProviderError,
  RateLimitEmbeddingProviderError,
  TransientEmbeddingProviderError,
} from '../embedding.errors';
import { EmbeddingModelMetadata } from '../embedding.types';

interface OpenAiResponseBody {
  data: { embedding: number[]; index: number }[];
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1/embeddings';

// Deliberately shaped so that pointing `baseUrl` at a self-hosted,
// OpenAI-compatible inference server (e.g. Hugging Face TEI) requires zero
// new adapter code — see design doc §4's local-model migration note.
export class OpenAiEmbeddingProviderAdapter implements EmbeddingProviderPort {
  constructor(
    private readonly apiKey: string,
    public readonly metadata: EmbeddingModelMetadata,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
  ) {}

  async embed(
    items: EmbeddingProviderRequestItem[],
    signal?: AbortSignal,
  ): Promise<EmbeddingProviderResponseItem[]> {
    let response: Response;
    try {
      response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          input: items.map((item) => item.text),
          model: this.metadata.model,
          dimensions: this.metadata.dimensions,
        }),
        signal,
      });
    } catch (err) {
      throw new TransientEmbeddingProviderError(
        'OpenAI embeddings request failed',
        {
          cause: err,
        },
      );
    }

    if (!response.ok) {
      throw await this.toError(response);
    }

    const body = (await response.json()) as OpenAiResponseBody;
    return items.map((item, index) => {
      const entry = body.data.find((candidate) => candidate.index === index);
      return { id: item.id, vector: entry?.embedding ?? [] };
    });
  }

  private async toError(response: Response): Promise<Error> {
    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterMs = retryAfterHeader
        ? Number(retryAfterHeader) * 1000
        : null;
      return new RateLimitEmbeddingProviderError(
        'OpenAI rate limit exceeded',
        retryAfterMs,
      );
    }
    if (response.status >= 500) {
      return new TransientEmbeddingProviderError(
        `OpenAI embeddings request failed with status ${response.status}`,
      );
    }
    return new PermanentEmbeddingProviderError(
      `OpenAI embeddings request failed with status ${response.status}`,
    );
  }
}
```

- [ ] **Step 8: Run both adapter tests to verify they pass**

Run: `pnpm test -- voyage-embedding-provider.adapter.spec.ts openai-embedding-provider.adapter.spec.ts`
Expected: PASS, 8/8 and 6/6.

- [ ] **Step 9: Commit**

```bash
git add src/embedding/providers/voyage-embedding-provider.adapter.ts src/embedding/providers/voyage-embedding-provider.adapter.spec.ts src/embedding/providers/openai-embedding-provider.adapter.ts src/embedding/providers/openai-embedding-provider.adapter.spec.ts
git commit -m "feat(embedding): add Voyage and OpenAI provider adapters, proving the provider-swap guarantee"
```

---

### Task 11: `EmbeddingModule` — DI wiring and provider factory

**Files:**

- Create: `src/embedding/embedding.module.ts`
- Test: `src/embedding/embedding.module.spec.ts`

**Interfaces:**

- Consumes: every service/port/adapter from Tasks 1–10.
- Produces: `EmbeddingModule`, exporting `EmbeddingPipelineService`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/embedding/embedding.module.spec.ts
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from '../config/env.validation';
import { EmbeddingModule } from './embedding.module';
import { EmbeddingPipelineService } from './embedding-pipeline.service';
import { EMBEDDING_PROVIDER_PORT } from './embedding-provider.port';
import { FakeEmbeddingProvider } from './providers/fake-embedding-provider';
import { VoyageEmbeddingProviderAdapter } from './providers/voyage-embedding-provider.adapter';
import { OpenAiEmbeddingProviderAdapter } from './providers/openai-embedding-provider.adapter';

async function buildModule(env: Record<string, string>) {
  process.env = { ...process.env, ...env };
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        validate: validateEnv,
        cache: false,
      }),
      LoggerModule.forRoot(),
      EmbeddingModule,
    ],
  }).compile();
}

describe('EmbeddingModule', () => {
  it('exports a working EmbeddingPipelineService', async () => {
    const moduleRef = await buildModule({ EMBEDDING_PROVIDER: 'fake' });

    expect(moduleRef.get(EmbeddingPipelineService)).toBeInstanceOf(
      EmbeddingPipelineService,
    );
  });

  it('binds EMBEDDING_PROVIDER_PORT to FakeEmbeddingProvider when EMBEDDING_PROVIDER=fake', async () => {
    const moduleRef = await buildModule({ EMBEDDING_PROVIDER: 'fake' });

    expect(moduleRef.get(EMBEDDING_PROVIDER_PORT)).toBeInstanceOf(
      FakeEmbeddingProvider,
    );
  });

  it('binds EMBEDDING_PROVIDER_PORT to VoyageEmbeddingProviderAdapter when EMBEDDING_PROVIDER=voyage', async () => {
    const moduleRef = await buildModule({
      EMBEDDING_PROVIDER: 'voyage',
      EMBEDDING_API_KEY: 'key',
    });

    expect(moduleRef.get(EMBEDDING_PROVIDER_PORT)).toBeInstanceOf(
      VoyageEmbeddingProviderAdapter,
    );
  });

  it('binds EMBEDDING_PROVIDER_PORT to OpenAiEmbeddingProviderAdapter when EMBEDDING_PROVIDER=openai', async () => {
    const moduleRef = await buildModule({
      EMBEDDING_PROVIDER: 'openai',
      EMBEDDING_API_KEY: 'key',
    });

    expect(moduleRef.get(EMBEDDING_PROVIDER_PORT)).toBeInstanceOf(
      OpenAiEmbeddingProviderAdapter,
    );
  });

  it('throws a clear config error when a real provider is selected without an API key', async () => {
    await expect(
      buildModule({ EMBEDDING_PROVIDER: 'voyage', EMBEDDING_API_KEY: '' }),
    ).rejects.toThrow(/EMBEDDING_API_KEY/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- embedding.module.spec.ts`
Expected: FAIL — `Cannot find module './embedding.module'`.

- [ ] **Step 3: Implement `EmbeddingModule`**

```typescript
// src/embedding/embedding.module.ts
import { Module } from '@nestjs/common';
import { EmbeddingBatchProcessorService } from './embedding-batch-processor.service';
import { EmbeddingConfigService } from './embedding-config.service';
import { EmbeddingOutputStoreService } from './embedding-output-store.service';
import { EmbeddingPipelineService } from './embedding-pipeline.service';
import {
  EMBEDDING_PROVIDER_PORT,
  EmbeddingProviderPort,
} from './embedding-provider.port';
import { FakeEmbeddingProvider } from './providers/fake-embedding-provider';
import { OpenAiEmbeddingProviderAdapter } from './providers/openai-embedding-provider.adapter';
import { VoyageEmbeddingProviderAdapter } from './providers/voyage-embedding-provider.adapter';

function createEmbeddingProvider(
  config: EmbeddingConfigService,
): EmbeddingProviderPort {
  const metadata = {
    provider: config.provider,
    model: config.model,
    modelVersion: config.modelVersion,
    dimensions: config.dimensions,
  };

  if (config.provider === 'fake') {
    return new FakeEmbeddingProvider(metadata);
  }

  if (!config.apiKey) {
    throw new Error(
      `EMBEDDING_API_KEY is required when EMBEDDING_PROVIDER=${config.provider}`,
    );
  }

  if (config.provider === 'voyage') {
    return config.baseUrl
      ? new VoyageEmbeddingProviderAdapter(
          config.apiKey,
          metadata,
          config.baseUrl,
        )
      : new VoyageEmbeddingProviderAdapter(config.apiKey, metadata);
  }

  return config.baseUrl
    ? new OpenAiEmbeddingProviderAdapter(
        config.apiKey,
        metadata,
        config.baseUrl,
      )
    : new OpenAiEmbeddingProviderAdapter(config.apiKey, metadata);
}

@Module({
  providers: [
    EmbeddingConfigService,
    {
      provide: EMBEDDING_PROVIDER_PORT,
      useFactory: createEmbeddingProvider,
      inject: [EmbeddingConfigService],
    },
    EmbeddingOutputStoreService,
    EmbeddingBatchProcessorService,
    EmbeddingPipelineService,
  ],
  exports: [EmbeddingPipelineService],
})
export class EmbeddingModule {}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- embedding.module.spec.ts`
Expected: PASS, 5/5.

- [ ] **Step 5: Commit**

```bash
git add src/embedding/embedding.module.ts src/embedding/embedding.module.spec.ts
git commit -m "feat(embedding): add EmbeddingModule with provider factory"
```

---

### Task 12: `pnpm embed` CLI

**Files:**

- Create: `src/cli/embed.ts`
- Modify: `package.json` (add `"embed": "node dist/cli/embed.js"` script)
- Modify: `README.md` (document the new script, mirroring the existing `pnpm run ingest` row)

**Interfaces:**

- Consumes: `EmbeddingModule`, `EmbeddingPipelineService` (Task 11), `AppConfigService`, `validateEnv`, `buildPinoHttpOptions` (existing `src/config/*`).
- Produces: a runnable `pnpm embed [chunks-dir]` command.

- [ ] **Step 1: Implement the CLI**

```typescript
// src/cli/embed.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger, LoggerModule } from 'nestjs-pino';
import { AppConfigService } from '../config/app-config.service';
import { validateEnv } from '../config/env.validation';
import { buildPinoHttpOptions } from '../config/pino-http-options.factory';
import { EmbeddingModule } from '../embedding/embedding.module';
import { EmbeddingPipelineService } from '../embedding/embedding-pipeline.service';

const DEFAULT_CHUNKS_DIR = './data/chunks-output';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      cache: true,
    }),
    LoggerModule.forRootAsync({
      providers: [AppConfigService],
      inject: [AppConfigService],
      useFactory: (appConfig: AppConfigService) => ({
        pinoHttp: buildPinoHttpOptions(appConfig),
      }),
    }),
    EmbeddingModule,
  ],
  providers: [AppConfigService],
})
class EmbedCliModule {}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const chunksDir = args[0] ?? DEFAULT_CHUNKS_DIR;

  const app = await NestFactory.createApplicationContext(EmbedCliModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  const pipeline = app.get(EmbeddingPipelineService);

  try {
    const result = await pipeline.run(chunksDir);

    console.log('\n=== Embedding Result ===');
    console.log(JSON.stringify(result, null, 2));
    console.log(`\nEmbeddings written to: ${result.outputPath}`);

    if (result.failed > 0) {
      console.error(
        `\n${result.failed} chunk(s) failed to embed — see "failures" above.`,
      );
      process.exitCode = 1;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nEmbedding run failed: ${message}`);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main();
```

- [ ] **Step 2: Add the `embed` script and confirm coverage exclusion already covers it**

Modify `package.json`'s `scripts` (after `"ingest": "node dist/cli/ingest.js",`):

```json
    "embed": "node dist/cli/embed.js",
```

`jest.collectCoverageFrom`'s existing `"!cli/**"` entry already excludes this new file — no change needed there.

- [ ] **Step 3: Update the README**

Modify `README.md`'s script table to add a row mirroring the existing `pnpm run ingest <path-to-zip>` row:

```
| `pnpm run embed [chunks-dir]` | Run the real embedding pipeline against a directory of `*.chunks.json` files (defaults to `./data/chunks-output`), for manual inspection. Requires `pnpm run build` first and a configured `EMBEDDING_API_KEY` unless `EMBEDDING_PROVIDER=fake`. |
```

- [ ] **Step 4: Build and manually verify against the fake provider**

Run:

```bash
pnpm build
EMBEDDING_PROVIDER=fake pnpm embed ./data/chunks-output
```

Expected: a JSON `EmbeddingRunResult` printed to stdout, `data/embedding-output/embeddings.jsonl` created, `failed: 0`.

- [ ] **Step 5: Commit**

```bash
git add src/cli/embed.ts package.json README.md
git commit -m "feat(cli): add pnpm embed CLI for manual embedding pipeline testing"
```

---

### Task 13: End-to-end integration test with a real `Chunk[]` fixture

**Files:**

- Create: `test/fixtures/embedding/docker-install-guide.chunks.json`
- Create: `test/embedding.e2e-spec.ts`

**Interfaces:**

- Consumes: `EmbeddingModule`, `EmbeddingPipelineService`, `EmbeddingOutputStoreService` (Tasks 7–11), `test/fixtures/chunking/docker-install-guide.json` (existing chunking fixture, as the source to actually run through the real chunking pipeline once to produce this task's fixture).

- [ ] **Step 1: Generate the fixture by actually running the real chunking pipeline**

Run a small one-off script (not committed) that loads `test/fixtures/chunking/docker-install-guide.json` (the existing real `StructuredDocument` fixture used by `test/chunking.e2e-spec.ts`) through `ChunkingModule`'s real `ChunkingPipelineService`, and writes the resulting `Chunk[]` to `test/fixtures/embedding/docker-install-guide.chunks.json`. This mirrors exactly how the chunking fixture itself was produced by actually running ingestion once (`semantic-chunking-design.md` §7's fixture provenance note) — never hand-authored from scratch, so the fixture is guaranteed to be a shape the real pipeline actually produces.

- [ ] **Step 2: Write the failing e2e test**

```typescript
// test/embedding.e2e-spec.ts
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from '../src/config/env.validation';
import { EmbeddingModule } from '../src/embedding/embedding.module';
import { EmbeddingPipelineService } from '../src/embedding/embedding-pipeline.service';

describe('Embedding e2e', () => {
  let chunksDir: string;
  let outputDir: string;

  beforeEach(async () => {
    chunksDir = await mkdtemp(join(tmpdir(), 'embedding-e2e-chunks-'));
    outputDir = await mkdtemp(join(tmpdir(), 'embedding-e2e-output-'));
    const fixture = await readFile(
      join(
        __dirname,
        'fixtures',
        'embedding',
        'docker-install-guide.chunks.json',
      ),
      'utf-8',
    );
    await mkdir(chunksDir, { recursive: true });
    await writeFile(
      join(chunksDir, 'docker-install-guide.chunks.json'),
      fixture,
      'utf-8',
    );
  });

  afterEach(async () => {
    await rm(chunksDir, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });
  });

  async function buildPipeline(): Promise<EmbeddingPipelineService> {
    process.env['EMBEDDING_PROVIDER'] = 'fake';
    process.env['EMBEDDING_OUTPUT_DIR'] = outputDir;
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          validate: validateEnv,
          cache: false,
        }),
        LoggerModule.forRoot(),
        EmbeddingModule,
      ],
    }).compile();
    return moduleRef.get(EmbeddingPipelineService);
  }

  it('embeds every eligible chunk from a real fixture with correct provenance', async () => {
    const pipeline = await buildPipeline();

    const result = await pipeline.run(chunksDir);

    expect(result.failed).toBe(0);
    expect(result.succeeded).toBeGreaterThan(0);
    expect(result.succeeded).toBe(result.attempted);
  });

  it('is resumable across two real pipeline instances sharing the same output directory', async () => {
    const first = await buildPipeline();
    const firstResult = await first.run(chunksDir);

    const second = await buildPipeline();
    const secondResult = await second.run(chunksDir);

    expect(secondResult.attempted).toBe(0);
    expect(secondResult.alreadyEmbedded).toBe(firstResult.succeeded);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test:e2e -- embedding.e2e-spec.ts`
Expected: FAIL until the fixture file from Step 1 exists.

- [ ] **Step 4: Confirm the fixture exists and run again**

Run: `pnpm test:e2e -- embedding.e2e-spec.ts`
Expected: PASS, 2/2.

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/embedding/docker-install-guide.chunks.json test/embedding.e2e-spec.ts
git commit -m "test(embedding): add end-to-end integration test with a real Chunk[] fixture"
```

---

### Task 14: Full verification pass and implementation report

**Files:** none (verification only).

- [ ] **Step 1: Run the full unit suite**

Run: `pnpm test`
Expected: all embedding specs pass; the only pre-existing failure is `env-example.spec.ts` (blocked on the manual `.env.example` update from Task 2, and the earlier pending chunking keys) — not a regression from this plan.

- [ ] **Step 2: Run the e2e suite**

Run: `pnpm test:e2e`
Expected: all suites pass, including the new `embedding.e2e-spec.ts`.

- [ ] **Step 3: Run lint**

Run: `pnpm lint`
Expected: no errors.

- [ ] **Step 4: Run the build**

Run: `pnpm build`
Expected: succeeds, `dist/cli/embed.js` exists.

- [ ] **Step 5: Run the real CLI against the real, already-ingested-and-chunked Docker docs corpus, using the fake provider (no API key required for this verification pass)**

Run:

```bash
EMBEDDING_PROVIDER=fake pnpm embed ./data/chunks-output
```

Expected: `EmbeddingRunResult.attempted` equals the corpus's real `'child'`-type chunk count (14,387, per this session's own already-measured full-corpus figures), `failed: 0`, and `data/embedding-output/embeddings.jsonl` contains exactly that many lines.

- [ ] **Step 6: Re-run the same command a second time to verify real-corpus-scale resumability**

Run:

```bash
EMBEDDING_PROVIDER=fake pnpm embed ./data/chunks-output
```

Expected: `attempted: 0`, `alreadyEmbedded` equal to the first run's `succeeded` count, near-instant completion.

- [ ] **Step 7: Confirm coverage floor**

Run: `pnpm test:cov`
Expected: branches/functions/lines/statements each ≥ 80% globally.

- [ ] **Step 8: Write the implementation report**

Summarize, in the final commit message or a message to the user (not a new file — this project does not create standalone report documents per its "no unrequested docs" convention): total new files, total new tests, real-corpus verification numbers from Steps 5–6, and the two pending manual steps (`.env.example`'s now-23-total pending keys across chunking + embedding, and optionally confirming Voyage's exact current pricing/token-limit per design doc §3/§23 before a real production run against `EMBEDDING_PROVIDER=voyage`).

- [ ] **Step 9: Final commit (only if any of Steps 1–7 required a fix)**

```bash
git add -A
git commit -m "fix(embedding): address issues found during full verification pass"
```

If no fixes were needed, skip this step — there is nothing to commit.

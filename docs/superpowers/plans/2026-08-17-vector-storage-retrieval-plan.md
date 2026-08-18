# Vector Storage & Retrieval Foundation (M4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist `EmbeddingRecord`s into a real, queryable vector store (Qdrant) and build the first retrieval path — embed a query, search, return normalized results with parent context.

**Architecture:** Two new flat feature modules, `src/vector-store/` (port + Qdrant/Fake adapters + indexing pipeline) and `src/retrieval/` (query embedding via the existing `EmbeddingProviderPort` + vector search + result normalization), plus a relocated/generalized `src/common/retry.util.ts`. No Postgres, no second database, no HTTP API — CLI-driven, exactly like `pnpm ingest`/`pnpm embed`.

**Tech Stack:** NestJS 11, TypeScript, pnpm, Pino/nestjs-pino, Zod, Jest, `p-limit`, native `fetch`, Qdrant (`qdrant/qdrant:v1.19.0`, self-hosted via Docker Compose), no new npm dependency for the Qdrant client (native `fetch` against its REST API, matching the embedding module's own zero-HTTP-client-dependency convention).

**Spec:** `docs/architecture/vector-storage-retrieval-design.md`

## Global Constraints

- No Postgres, Redis, BullMQ, or any second database (design §2).
- No hybrid/lexical retrieval, BM25, score fusion, reranking, LLM calls, prompt assembly, conversation state, HTTP API, SSE, auth, or rate limiting (design §1, §26).
- Every new env var goes into the single zod schema in `src/config/env.validation.ts`, wrapped by a dedicated `*ConfigService` — never read `process.env` directly (design §16).
- Every injectable logs via constructor-injected `PinoLogger` with `this.logger.setContext(ClassName.name)`, structured object first (design §23).
- Unit tests never require a running external database — only `test:integration` (a new, separate Jest config) does (design §25).
- No new runtime npm dependency for the Qdrant client or for UUID derivation — native `fetch` and native `node:crypto` only (design §8, §3).
- `.env.example` cannot be edited directly by the assistant (pre-existing tooling permission constraint) — each task that adds env vars ends with a manual-copy instruction for the user instead of an `Edit` call.
- Collection naming, point-ID derivation, and the fake-provider guard are structural safety mechanisms, not just documentation — implement them exactly as specified in design §8, §9, §16.

---

### Task 1: Relocate and generalize `withRetry` into `src/common/`

**Files:**

- Create: `src/common/retry.util.ts`
- Create: `src/common/retry.util.spec.ts`
- Modify: `src/embedding/embedding-batch-processor.service.ts` (import path + call-site predicate)
- Delete: `src/embedding/retry.util.ts`
- Delete: `src/embedding/retry.util.spec.ts`

**Interfaces:**

- Produces: `RetryOptions { maxAttempts: number; baseDelayMs: number; maxDelayMs: number; isRetryable: (err: unknown) => boolean; getRetryAfterMs?: (err: unknown) => number | null; sleep?: (ms: number) => Promise<void> }`, `withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T>` — consumed by every later task's batch processors (Task 6) and by `embedding`'s own existing call site.

- [ ] **Step 1: Write the failing test for the generalized utility**

```typescript
// src/common/retry.util.spec.ts
import { withRetry } from './retry.util';

class FakeTransientError extends Error {}
class FakeRateLimitError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs: number,
  ) {
    super(message);
  }
}
class FakePermanentError extends Error {}

describe('withRetry', () => {
  it('returns the result on first success without sleeping', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const fn = jest.fn().mockResolvedValue('ok');

    const result = await withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 5,
      isRetryable: () => true,
      sleep,
    });

    expect(result).toBe('ok');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a retryable error and eventually succeeds', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new FakeTransientError('boom'))
      .mockResolvedValueOnce('ok');

    const result = await withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 5,
      isRetryable: (err) => err instanceof FakeTransientError,
      sleep,
    });

    expect(result).toBe('ok');
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('does not retry an error the predicate rejects', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const fn = jest.fn().mockRejectedValue(new FakePermanentError('nope'));

    await expect(
      withRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 5,
        isRetryable: (err) => err instanceof FakeTransientError,
        sleep,
      }),
    ).rejects.toThrow('nope');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws once maxAttempts is exhausted', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const fn = jest.fn().mockRejectedValue(new FakeTransientError('boom'));

    await expect(
      withRetry(fn, {
        maxAttempts: 2,
        baseDelayMs: 1,
        maxDelayMs: 5,
        isRetryable: () => true,
        sleep,
      }),
    ).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('honors getRetryAfterMs, clamped to maxDelayMs, without jitter', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new FakeRateLimitError('slow down', 9999))
      .mockResolvedValueOnce('ok');

    await withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 100,
      isRetryable: () => true,
      getRetryAfterMs: (err) =>
        err instanceof FakeRateLimitError ? err.retryAfterMs : null,
      sleep,
    });

    expect(sleep).toHaveBeenCalledWith(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/common/retry.util.spec.ts`
Expected: FAIL — `Cannot find module './retry.util'`

- [ ] **Step 3: Write the generalized implementation**

```typescript
// src/common/retry.util.ts
export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  isRetryable: (err: unknown) => boolean;
  getRetryAfterMs?: (err: unknown) => number | null;
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

      if (!options.isRetryable(err) || attempt >= options.maxAttempts) {
        throw err;
      }

      const retryAfterMs = options.getRetryAfterMs?.(err) ?? null;

      // A provider's stated wait time is honored close to verbatim (just
      // clamped to our own ceiling) — never jittered, since it isn't a
      // guess we're making, it's what the provider told us to do.
      if (retryAfterMs !== null) {
        await sleep(Math.min(retryAfterMs, options.maxDelayMs));
        continue;
      }

      const backoff = Math.min(
        options.baseDelayMs * 2 ** (attempt - 1),
        options.maxDelayMs,
      );
      // Jitter to 0.5x-1.0x of the computed value to avoid thundering-herd
      // retries across concurrent batches.
      const jitteredBackoff = backoff * (0.5 + Math.random() * 0.5);

      await sleep(jitteredBackoff);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/common/retry.util.spec.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Update `embedding-batch-processor.service.ts`'s call site**

Change the import and the `withRetry` call in `src/embedding/embedding-batch-processor.service.ts`:

```typescript
// replace: import { withRetry } from './retry.util';
import { withRetry } from '../common/retry.util';
import {
  RateLimitEmbeddingProviderError,
  TransientEmbeddingProviderError,
} from './embedding.errors';
```

```typescript
// replace the existing withRetry(...) call inside processBatch with:
const responseItems = await withRetry(
  () => this.embedWithTimeout(requestItems),
  {
    maxAttempts: this.config.maxRetries,
    baseDelayMs: this.config.retryBaseDelayMs,
    maxDelayMs: this.config.retryMaxDelayMs,
    isRetryable: (err) => err instanceof TransientEmbeddingProviderError,
    getRetryAfterMs: (err) =>
      err instanceof RateLimitEmbeddingProviderError ? err.retryAfterMs : null,
  },
);
```

Delete `src/embedding/retry.util.ts` and `src/embedding/retry.util.spec.ts`.

- [ ] **Step 6: Run the full embedding suite to verify zero behavior change**

Run: `pnpm test src/embedding`
Expected: PASS, same test count as before this task (this is a pure refactor — no embedding test's expectations change)

- [ ] **Step 7: Run build and lint**

Run: `pnpm build && pnpm lint`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add src/common/retry.util.ts src/common/retry.util.spec.ts src/embedding/embedding-batch-processor.service.ts
git rm src/embedding/retry.util.ts src/embedding/retry.util.spec.ts
git commit -m "refactor(common): relocate and generalize withRetry for reuse by vector-store"
```

---

### Task 2: Vector-store domain types, error taxonomy, and point-ID derivation

**Files:**

- Create: `src/vector-store/vector-store.types.ts`
- Create: `src/vector-store/vector-store.errors.ts`
- Create: `src/vector-store/vector-store.errors.spec.ts`
- Create: `src/vector-store/vector-store-id.util.ts`
- Create: `src/vector-store/vector-store-id.util.spec.ts`

**Interfaces:**

- Consumes: `ChunkType` from `../chunking/chunking.types`.
- Produces: `VectorPayload`, `VectorPoint`, `VectorSearchFilter`, `VectorSearchQuery`, `VectorSearchMatch`, `IndexFailure`, `IndexRunResult` (all consumed by Tasks 4–9); `TransientVectorStoreError`, `PermanentVectorStoreError`, `VectorStoreValidationError`, `VectorStoreThresholdExceededError` (consumed by Tasks 5, 6, 7, 8); `deriveVectorPointId(embeddingId: string): string` (consumed by Tasks 5, 7).

- [ ] **Step 1: Write the failing test for point-ID derivation**

```typescript
// src/vector-store/vector-store-id.util.spec.ts
import { deriveVectorPointId } from './vector-store-id.util';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('deriveVectorPointId', () => {
  it('is deterministic for the same embeddingId', () => {
    const a = deriveVectorPointId('abc123');
    const b = deriveVectorPointId('abc123');
    expect(a).toBe(b);
  });

  it('produces different UUIDs for different embeddingIds', () => {
    expect(deriveVectorPointId('abc123')).not.toBe(
      deriveVectorPointId('def456'),
    );
  });

  it('produces a well-formed RFC 4122 v5 UUID (version and variant nibbles set)', () => {
    expect(deriveVectorPointId('abc123')).toMatch(UUID_RE);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/vector-store/vector-store-id.util.spec.ts`
Expected: FAIL — `Cannot find module './vector-store-id.util'`

- [ ] **Step 3: Implement point-ID derivation**

```typescript
// src/vector-store/vector-store-id.util.ts
import { createHash } from 'node:crypto';

// Fixed, arbitrary namespace — never changes. embeddingId itself remains
// the single source of truth (design §8); this is a pure format
// conversion to satisfy Qdrant's uint64-or-UUID point ID constraint, not a
// second identity scheme.
const NAMESPACE = 'f47ee6f2-30c1-4b1e-9e17-embedding-id-v5';

export function deriveVectorPointId(embeddingId: string): string {
  const hash = createHash('sha1')
    .update(NAMESPACE + embeddingId, 'utf-8')
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8]! & 0x3f) | 0x80; // variant 10
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/vector-store/vector-store-id.util.spec.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the failing test for the error taxonomy**

```typescript
// src/vector-store/vector-store.errors.spec.ts
import {
  PermanentVectorStoreError,
  TransientVectorStoreError,
  VectorStoreThresholdExceededError,
  VectorStoreValidationError,
} from './vector-store.errors';

describe('vector-store error taxonomy', () => {
  it('names each error class after itself', () => {
    expect(new TransientVectorStoreError('x').name).toBe(
      'TransientVectorStoreError',
    );
    expect(new PermanentVectorStoreError('x').name).toBe(
      'PermanentVectorStoreError',
    );
    expect(new VectorStoreValidationError('x').name).toBe(
      'VectorStoreValidationError',
    );
  });

  it('VectorStoreThresholdExceededError composes a clear message from counts', () => {
    const err = new VectorStoreThresholdExceededError(6, 10);
    expect(err.name).toBe('VectorStoreThresholdExceededError');
    expect(err.failedCount).toBe(6);
    expect(err.attemptedCount).toBe(10);
    expect(err.message).toContain('6/10');
  });

  it('TransientVectorStoreError preserves a cause', () => {
    const cause = new Error('network down');
    const err = new TransientVectorStoreError('upsert failed', { cause });
    expect(err.cause).toBe(cause);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm test src/vector-store/vector-store.errors.spec.ts`
Expected: FAIL — `Cannot find module './vector-store.errors'`

- [ ] **Step 7: Implement the error taxonomy**

```typescript
// src/vector-store/vector-store.errors.ts
export class TransientVectorStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransientVectorStoreError';
  }
}

export class PermanentVectorStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentVectorStoreError';
  }
}

export class VectorStoreValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VectorStoreValidationError';
  }
}

export class VectorStoreThresholdExceededError extends Error {
  constructor(
    public readonly failedCount: number,
    public readonly attemptedCount: number,
  ) {
    super(
      `Indexing run aborted: ${failedCount}/${attemptedCount} points failed, exceeding the configured failure threshold`,
    );
    this.name = 'VectorStoreThresholdExceededError';
  }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm test src/vector-store/vector-store.errors.spec.ts`
Expected: PASS (3 tests)

- [ ] **Step 9: Create the domain types file (no test — pure type declarations)**

```typescript
// src/vector-store/vector-store.types.ts
import { ChunkType } from '../chunking/chunking.types';

export interface VectorPayload {
  chunkId: string;
  documentId: string;
  parentChunkId: string | null;
  chunkType: ChunkType;
  contentHash: string;
  headingPath: string;
  documentTitle: string;
  sourcePath: string;
  domain: string;
  text: string;
  parentText: string | null;
  provider: string;
  model: string;
  modelVersion: string;
  dimensions: number;
  embeddingId: string;
  indexedAt: string;
}

export interface VectorPoint {
  id: string;
  vector: number[];
  payload: VectorPayload;
}

export interface VectorSearchFilter {
  domain?: string;
  documentId?: string;
  chunkType?: ChunkType;
  sourcePath?: string;
}

export interface VectorSearchQuery {
  collection: string;
  vector: number[];
  topK: number;
  scoreThreshold?: number;
  filter?: VectorSearchFilter;
}

export interface VectorSearchMatch {
  id: string;
  score: number;
  payload: VectorPayload;
}

export interface CollectionInfo {
  dimensions: number;
  pointCount: number;
}

export interface IndexFailure {
  chunkId: string;
  message: string;
}

export interface IndexRunResult {
  jobId: string;
  collection: string;
  totalRecordsScanned: number;
  skippedByProvenanceMismatch: number;
  skippedFakeProvider: number;
  attempted: number;
  succeeded: number;
  failed: number;
  failures: IndexFailure[];
  totalBatches: number;
  durationMs: number;
}

export type { ChunkType };
```

- [ ] **Step 10: Run build and lint**

Run: `pnpm build && pnpm lint`
Expected: no errors (types file has no runtime behavior to test directly; correctness is verified by every later task that imports it compiling cleanly)

- [ ] **Step 11: Commit**

```bash
git add src/vector-store/
git commit -m "feat(vector-store): add domain types, error taxonomy, and point-ID derivation"
```

---

### Task 3: `VectorStoreConfigService` and env schema extension

**Files:**

- Modify: `src/config/env.validation.ts`
- Create: `src/vector-store/vector-store-config.service.ts`
- Create: `src/vector-store/vector-store-config.service.spec.ts`

**Interfaces:**

- Consumes: `EnvConfig` from `../config/env.validation`.
- Produces: `VectorStoreConfigService` with getters `provider, url, apiKey, domain, batchSize, maxConcurrentBatches, maxRetries, retryBaseDelayMs, retryMaxDelayMs, requestTimeoutMs, failureThreshold, skipExisting, allowFakeProvider` — consumed by Tasks 4, 6, 7, 8, 9, 10.

- [ ] **Step 1: Add the new env vars to the schema**

In `src/config/env.validation.ts`, add these keys inside the `.object({...})` block, immediately after `EMBEDDING_MAX_CHUNKS_PER_RUN`:

```typescript
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
```

Also add this `.refine(...)` immediately after the existing `EMBEDDING_RETRY_BASE_DELAY_MS < EMBEDDING_RETRY_MAX_DELAY_MS` refine block (before the closing `;`):

```typescript
  .refine(
    (config) =>
      config.VECTOR_STORE_RETRY_BASE_DELAY_MS <
      config.VECTOR_STORE_RETRY_MAX_DELAY_MS,
    {
      message:
        'VECTOR_STORE_RETRY_BASE_DELAY_MS must be less than VECTOR_STORE_RETRY_MAX_DELAY_MS',
      path: ['VECTOR_STORE_RETRY_BASE_DELAY_MS'],
    },
  );
```

(This replaces the trailing `;` that currently ends the `.refine(...)` chain — chain this new `.refine(...)` onto it instead of terminating early.)

- [ ] **Step 2: Write the failing test for `VectorStoreConfigService`**

```typescript
// src/vector-store/vector-store-config.service.spec.ts
import { ConfigService } from '@nestjs/config';
import { EnvConfig, validateEnv } from '../config/env.validation';
import { VectorStoreConfigService } from './vector-store-config.service';

function buildService(
  overrides: Partial<Record<string, string>> = {},
): VectorStoreConfigService {
  const env = validateEnv({ ...overrides });
  const configService = new ConfigService<EnvConfig, true>(env);
  return new VectorStoreConfigService(configService);
}

describe('VectorStoreConfigService', () => {
  it('exposes defaults matching the schema', () => {
    const service = buildService();
    expect(service.provider).toBe('qdrant');
    expect(service.url).toBe('http://localhost:6333');
    expect(service.domain).toBe('docker');
    expect(service.batchSize).toBe(200);
    expect(service.maxConcurrentBatches).toBe(4);
    expect(service.failureThreshold).toBe(0.5);
    expect(service.skipExisting).toBe(true);
    expect(service.allowFakeProvider).toBe(false);
  });

  it('reflects overridden values', () => {
    const service = buildService({
      VECTOR_STORE_PROVIDER: 'fake',
      VECTOR_STORE_ALLOW_FAKE_PROVIDER: 'true',
    });
    expect(service.provider).toBe('fake');
    expect(service.allowFakeProvider).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test src/vector-store/vector-store-config.service.spec.ts`
Expected: FAIL — `Cannot find module './vector-store-config.service'`

- [ ] **Step 4: Implement `VectorStoreConfigService`**

```typescript
// src/vector-store/vector-store-config.service.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from '../config/env.validation';

@Injectable()
export class VectorStoreConfigService {
  constructor(private readonly configService: ConfigService<EnvConfig, true>) {}

  get provider(): EnvConfig['VECTOR_STORE_PROVIDER'] {
    return this.configService.get('VECTOR_STORE_PROVIDER', { infer: true });
  }

  get url(): string {
    return this.configService.get('VECTOR_STORE_URL', { infer: true });
  }

  get apiKey(): string {
    return this.configService.get('VECTOR_STORE_API_KEY', { infer: true });
  }

  get domain(): string {
    return this.configService.get('VECTOR_STORE_DOMAIN', { infer: true });
  }

  get batchSize(): number {
    return this.configService.get('VECTOR_STORE_BATCH_SIZE', { infer: true });
  }

  get maxConcurrentBatches(): number {
    return this.configService.get('VECTOR_STORE_MAX_CONCURRENT_BATCHES', {
      infer: true,
    });
  }

  get maxRetries(): number {
    return this.configService.get('VECTOR_STORE_MAX_RETRIES', {
      infer: true,
    });
  }

  get retryBaseDelayMs(): number {
    return this.configService.get('VECTOR_STORE_RETRY_BASE_DELAY_MS', {
      infer: true,
    });
  }

  get retryMaxDelayMs(): number {
    return this.configService.get('VECTOR_STORE_RETRY_MAX_DELAY_MS', {
      infer: true,
    });
  }

  get requestTimeoutMs(): number {
    return this.configService.get('VECTOR_STORE_REQUEST_TIMEOUT_MS', {
      infer: true,
    });
  }

  get failureThreshold(): number {
    return this.configService.get('VECTOR_STORE_FAILURE_THRESHOLD', {
      infer: true,
    });
  }

  get skipExisting(): boolean {
    return this.configService.get('VECTOR_STORE_SKIP_EXISTING', {
      infer: true,
    });
  }

  get allowFakeProvider(): boolean {
    return this.configService.get('VECTOR_STORE_ALLOW_FAKE_PROVIDER', {
      infer: true,
    });
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test src/vector-store/vector-store-config.service.spec.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Run the config suite to confirm the schema change is safe**

Run: `pnpm test src/config`
Expected: PASS. Note: `env-example.spec.ts`'s pre-existing drift-guard will now fail (this is expected and pre-existing behavior for every milestone's new env vars, per Global Constraints) — confirm the failure is _only_ about the newly added `VECTOR_STORE_*`/keys, not an unrelated regression.

- [ ] **Step 7: Print the exact `.env.example` lines for manual addition**

Since `.env.example` cannot be edited directly, print this block for the user to append manually:

```
VECTOR_STORE_PROVIDER=qdrant
VECTOR_STORE_URL=http://localhost:6333
VECTOR_STORE_API_KEY=
VECTOR_STORE_DOMAIN=docker
VECTOR_STORE_BATCH_SIZE=200
VECTOR_STORE_MAX_CONCURRENT_BATCHES=4
VECTOR_STORE_MAX_RETRIES=5
VECTOR_STORE_RETRY_BASE_DELAY_MS=200
VECTOR_STORE_RETRY_MAX_DELAY_MS=10000
VECTOR_STORE_REQUEST_TIMEOUT_MS=10000
VECTOR_STORE_FAILURE_THRESHOLD=0.5
VECTOR_STORE_SKIP_EXISTING=true
VECTOR_STORE_ALLOW_FAKE_PROVIDER=false
```

- [ ] **Step 8: Run build and lint**

Run: `pnpm build && pnpm lint`
Expected: no errors

- [ ] **Step 9: Commit**

```bash
git add src/config/env.validation.ts src/vector-store/vector-store-config.service.ts src/vector-store/vector-store-config.service.spec.ts
git commit -m "feat(vector-store): add VectorStoreConfigService and VECTOR_STORE_* env schema"
```

---

### Task 4: `VectorStorePort` and `FakeVectorStoreAdapter`

**Files:**

- Create: `src/vector-store/vector-store.port.ts`
- Create: `src/vector-store/providers/fake-vector-store.adapter.ts`
- Create: `src/vector-store/providers/fake-vector-store.adapter.spec.ts`

**Interfaces:**

- Consumes: `VectorPoint, VectorSearchQuery, VectorSearchMatch, VectorSearchFilter, CollectionInfo` from `../vector-store.types`.
- Produces: `VECTOR_STORE_PORT` symbol, `VectorStorePort` interface (consumed by Tasks 6, 7, 9, 12); `FakeVectorStoreAdapter` (consumed by Tasks 5, 6, 7, 12 unit tests).

- [ ] **Step 1: Define the port (no test — pure interface)**

```typescript
// src/vector-store/vector-store.port.ts
import {
  CollectionInfo,
  VectorPoint,
  VectorSearchFilter,
  VectorSearchQuery,
  VectorSearchMatch,
} from './vector-store.types';

export const VECTOR_STORE_PORT = Symbol('VECTOR_STORE_PORT');

export interface VectorStorePort {
  ensureCollection(collection: string, dimensions: number): Promise<void>;
  collectionInfo(collection: string): Promise<CollectionInfo | null>;
  upsert(collection: string, points: VectorPoint[]): Promise<void>;
  search(query: VectorSearchQuery): Promise<VectorSearchMatch[]>;
  deleteByFilter(
    collection: string,
    filter: VectorSearchFilter,
  ): Promise<number>;
}
```

- [ ] **Step 2: Write the failing test for `FakeVectorStoreAdapter`**

```typescript
// src/vector-store/providers/fake-vector-store.adapter.spec.ts
import { FakeVectorStoreAdapter } from './fake-vector-store.adapter';
import { VectorPoint } from '../vector-store.types';

function buildPoint(overrides: Partial<VectorPoint> = {}): VectorPoint {
  return {
    id: '11111111-1111-5111-8111-111111111111',
    vector: [1, 0, 0],
    payload: {
      chunkId: 'chunk1',
      documentId: 'doc1',
      parentChunkId: null,
      chunkType: 'child',
      contentHash: 'hash1',
      headingPath: 'Install',
      documentTitle: 'Install Docker',
      sourcePath: 'install.md',
      domain: 'docker',
      text: 'Run docker --version',
      parentText: null,
      provider: 'fake',
      model: 'fake-model',
      modelVersion: '1',
      dimensions: 3,
      embeddingId: 'emb1',
      indexedAt: '2026-08-17T00:00:00.000Z',
    },
    ...overrides,
  };
}

describe('FakeVectorStoreAdapter', () => {
  it('creates a collection and reports its info', async () => {
    const store = new FakeVectorStoreAdapter();
    await store.ensureCollection('docker__fake_v1', 3);
    expect(await store.collectionInfo('docker__fake_v1')).toEqual({
      dimensions: 3,
      pointCount: 0,
    });
  });

  it('returns null collectionInfo for a collection that was never created', async () => {
    const store = new FakeVectorStoreAdapter();
    expect(await store.collectionInfo('missing')).toBeNull();
  });

  it('ensureCollection is idempotent', async () => {
    const store = new FakeVectorStoreAdapter();
    await store.ensureCollection('c', 3);
    await store.ensureCollection('c', 3);
    expect(await store.collectionInfo('c')).toEqual({
      dimensions: 3,
      pointCount: 0,
    });
  });

  it('upserts points and reflects the new count', async () => {
    const store = new FakeVectorStoreAdapter();
    await store.ensureCollection('c', 3);
    await store.upsert('c', [buildPoint()]);
    expect(await store.collectionInfo('c')).toEqual({
      dimensions: 3,
      pointCount: 1,
    });
  });

  it('upserting the same point id twice results in exactly one point', async () => {
    const store = new FakeVectorStoreAdapter();
    await store.ensureCollection('c', 3);
    await store.upsert('c', [buildPoint()]);
    await store.upsert('c', [buildPoint({ vector: [0, 1, 0] })]);
    expect(await store.collectionInfo('c')).toEqual({
      dimensions: 3,
      pointCount: 1,
    });
  });

  it('search returns points ranked by cosine similarity descending', async () => {
    const store = new FakeVectorStoreAdapter();
    await store.ensureCollection('c', 3);
    await store.upsert('c', [
      buildPoint({ id: 'a', vector: [1, 0, 0] }),
      buildPoint({ id: 'b', vector: [0, 1, 0] }),
    ]);

    const matches = await store.search({
      collection: 'c',
      vector: [1, 0, 0],
      topK: 2,
    });

    expect(matches[0]!.id).toBe('a');
    expect(matches[0]!.score).toBeCloseTo(1, 5);
    expect(matches[1]!.id).toBe('b');
    expect(matches[1]!.score).toBeCloseTo(0, 5);
  });

  it('search applies the filter before ranking', async () => {
    const store = new FakeVectorStoreAdapter();
    await store.ensureCollection('c', 3);
    await store.upsert('c', [
      buildPoint({
        id: 'a',
        vector: [1, 0, 0],
        payload: { ...buildPoint().payload, documentId: 'doc1' },
      }),
      buildPoint({
        id: 'b',
        vector: [1, 0, 0],
        payload: { ...buildPoint().payload, documentId: 'doc2' },
      }),
    ]);

    const matches = await store.search({
      collection: 'c',
      vector: [1, 0, 0],
      topK: 10,
      filter: { documentId: 'doc2' },
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]!.id).toBe('b');
  });

  it('search respects scoreThreshold', async () => {
    const store = new FakeVectorStoreAdapter();
    await store.ensureCollection('c', 3);
    await store.upsert('c', [
      buildPoint({ id: 'a', vector: [1, 0, 0] }),
      buildPoint({ id: 'b', vector: [0, 1, 0] }),
    ]);

    const matches = await store.search({
      collection: 'c',
      vector: [1, 0, 0],
      topK: 10,
      scoreThreshold: 0.5,
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]!.id).toBe('a');
  });

  it('deleteByFilter removes matching points and returns the deleted count', async () => {
    const store = new FakeVectorStoreAdapter();
    await store.ensureCollection('c', 3);
    await store.upsert('c', [
      buildPoint({
        id: 'a',
        payload: { ...buildPoint().payload, documentId: 'doc1' },
      }),
      buildPoint({
        id: 'b',
        payload: { ...buildPoint().payload, documentId: 'doc2' },
      }),
    ]);

    const deleted = await store.deleteByFilter('c', { documentId: 'doc1' });

    expect(deleted).toBe(1);
    expect(await store.collectionInfo('c')).toEqual({
      dimensions: 3,
      pointCount: 1,
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test src/vector-store/providers/fake-vector-store.adapter.spec.ts`
Expected: FAIL — `Cannot find module './fake-vector-store.adapter'`

- [ ] **Step 4: Implement `FakeVectorStoreAdapter`**

```typescript
// src/vector-store/providers/fake-vector-store.adapter.ts
import { VectorStorePort } from '../vector-store.port';
import {
  CollectionInfo,
  VectorPoint,
  VectorSearchFilter,
  VectorSearchMatch,
  VectorSearchQuery,
} from '../vector-store.types';

interface FakeCollection {
  dimensions: number;
  points: Map<string, VectorPoint>;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function matchesFilter(
  payload: VectorPoint['payload'],
  filter?: VectorSearchFilter,
): boolean {
  if (!filter) return true;
  if (filter.domain !== undefined && payload.domain !== filter.domain)
    return false;
  if (
    filter.documentId !== undefined &&
    payload.documentId !== filter.documentId
  )
    return false;
  if (filter.chunkType !== undefined && payload.chunkType !== filter.chunkType)
    return false;
  if (
    filter.sourcePath !== undefined &&
    payload.sourcePath !== filter.sourcePath
  )
    return false;
  return true;
}

export class FakeVectorStoreAdapter implements VectorStorePort {
  private readonly collections = new Map<string, FakeCollection>();

  async ensureCollection(
    collection: string,
    dimensions: number,
  ): Promise<void> {
    if (!this.collections.has(collection)) {
      this.collections.set(collection, { dimensions, points: new Map() });
    }
  }

  async collectionInfo(collection: string): Promise<CollectionInfo | null> {
    const found = this.collections.get(collection);
    if (!found) return null;
    return { dimensions: found.dimensions, pointCount: found.points.size };
  }

  async upsert(collection: string, points: VectorPoint[]): Promise<void> {
    const found = this.collections.get(collection);
    if (!found) {
      throw new Error(`Collection "${collection}" does not exist`);
    }
    for (const point of points) {
      found.points.set(point.id, point);
    }
  }

  async search(query: VectorSearchQuery): Promise<VectorSearchMatch[]> {
    const found = this.collections.get(query.collection);
    if (!found) return [];

    const scored = Array.from(found.points.values())
      .filter((point) => matchesFilter(point.payload, query.filter))
      .map((point) => ({
        id: point.id,
        score: cosineSimilarity(query.vector, point.vector),
        payload: point.payload,
      }))
      .filter(
        (match) =>
          query.scoreThreshold === undefined ||
          match.score >= query.scoreThreshold,
      )
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, query.topK);
  }

  async deleteByFilter(
    collection: string,
    filter: VectorSearchFilter,
  ): Promise<number> {
    const found = this.collections.get(collection);
    if (!found) return 0;

    let deleted = 0;
    for (const [id, point] of found.points) {
      if (matchesFilter(point.payload, filter)) {
        found.points.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test src/vector-store/providers/fake-vector-store.adapter.spec.ts`
Expected: PASS (9 tests)

- [ ] **Step 6: Run build and lint**

Run: `pnpm build && pnpm lint`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src/vector-store/vector-store.port.ts src/vector-store/providers/fake-vector-store.adapter.ts src/vector-store/providers/fake-vector-store.adapter.spec.ts
git commit -m "feat(vector-store): add VectorStorePort and in-memory FakeVectorStoreAdapter"
```

---

### Task 5: Record validator and transformer (parent-text join)

**Files:**

- Create: `src/vector-store/vector-store-record-validator.util.ts`
- Create: `src/vector-store/vector-store-record-validator.util.spec.ts`
- Create: `src/vector-store/vector-store-record-transformer.util.ts`
- Create: `src/vector-store/vector-store-record-transformer.util.spec.ts`

**Interfaces:**

- Consumes: `EmbeddingRecord` from `../embedding/embedding.types`; `Chunk` from `../chunking/chunking.types`; `VectorPoint` from `./vector-store.types`; `deriveVectorPointId` from `./vector-store-id.util`; `VectorStoreValidationError` from `./vector-store.errors`.
- Produces: `validateRecordForIndexing(record: EmbeddingRecord, target: { dimensions: number }, options: { allowFakeProvider: boolean }): void` (throws `VectorStoreValidationError`); `transformToVectorPoint(record: EmbeddingRecord, chunk: Chunk, parentChunk: Chunk | null, domain: string): VectorPoint` — both consumed by Task 7.

- [ ] **Step 1: Write the failing test for the validator**

```typescript
// src/vector-store/vector-store-record-validator.util.spec.ts
import { validateRecordForIndexing } from './vector-store-record-validator.util';
import { VectorStoreValidationError } from './vector-store.errors';
import { EmbeddingRecord } from '../embedding/embedding.types';

function buildRecord(
  overrides: Partial<EmbeddingRecord> = {},
): EmbeddingRecord {
  return {
    embeddingId: 'emb1',
    chunkId: 'chunk1',
    documentId: 'doc1',
    sourcePath: 'install.md',
    vector: [0.1, 0.2, 0.3],
    dimensions: 3,
    provider: 'google',
    model: 'gemini-embedding-2',
    modelVersion: '1',
    contentHash: 'hash1',
    inputHash: 'inputhash1',
    inputTokenCount: 5,
    truncated: false,
    createdAt: '2026-08-17T00:00:00.000Z',
    ...overrides,
  };
}

describe('validateRecordForIndexing', () => {
  it('accepts a valid, dimension-matching, non-fake record', () => {
    expect(() =>
      validateRecordForIndexing(
        buildRecord(),
        { dimensions: 3 },
        { allowFakeProvider: false },
      ),
    ).not.toThrow();
  });

  it('rejects a record whose dimensions do not match the target collection', () => {
    expect(() =>
      validateRecordForIndexing(
        buildRecord({ dimensions: 3 }),
        { dimensions: 768 },
        { allowFakeProvider: false },
      ),
    ).toThrow(VectorStoreValidationError);
  });

  it('rejects a fake-provider record unless explicitly allowed', () => {
    expect(() =>
      validateRecordForIndexing(
        buildRecord({ provider: 'fake' }),
        { dimensions: 3 },
        { allowFakeProvider: false },
      ),
    ).toThrow(/fake/i);
  });

  it('accepts a fake-provider record when explicitly allowed', () => {
    expect(() =>
      validateRecordForIndexing(
        buildRecord({ provider: 'fake' }),
        { dimensions: 3 },
        { allowFakeProvider: true },
      ),
    ).not.toThrow();
  });

  it('rejects an empty vector', () => {
    expect(() =>
      validateRecordForIndexing(
        buildRecord({ vector: [] }),
        { dimensions: 3 },
        { allowFakeProvider: false },
      ),
    ).toThrow(VectorStoreValidationError);
  });

  it('rejects a vector containing a non-finite value', () => {
    expect(() =>
      validateRecordForIndexing(
        buildRecord({ vector: [0.1, Number.NaN, 0.3] }),
        { dimensions: 3 },
        { allowFakeProvider: false },
      ),
    ).toThrow(VectorStoreValidationError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/vector-store/vector-store-record-validator.util.spec.ts`
Expected: FAIL — `Cannot find module './vector-store-record-validator.util'`

- [ ] **Step 3: Implement the validator**

```typescript
// src/vector-store/vector-store-record-validator.util.ts
import { EmbeddingRecord } from '../embedding/embedding.types';
import { VectorStoreValidationError } from './vector-store.errors';

export function validateRecordForIndexing(
  record: EmbeddingRecord,
  target: { dimensions: number },
  options: { allowFakeProvider: boolean },
): void {
  if (record.provider === 'fake' && !options.allowFakeProvider) {
    throw new VectorStoreValidationError(
      `Refusing to index a "fake"-provider embedding (chunkId="${record.chunkId}") — set VECTOR_STORE_ALLOW_FAKE_PROVIDER=true to explicitly allow this for development/testing`,
    );
  }

  if (record.dimensions !== target.dimensions) {
    throw new VectorStoreValidationError(
      `Embedding record for chunkId="${record.chunkId}" has ${record.dimensions} dimensions, but the target collection expects ${target.dimensions}`,
    );
  }

  if (!Array.isArray(record.vector) || record.vector.length === 0) {
    throw new VectorStoreValidationError(
      `Embedding record for chunkId="${record.chunkId}" has an empty vector`,
    );
  }

  if (record.vector.length !== record.dimensions) {
    throw new VectorStoreValidationError(
      `Embedding record for chunkId="${record.chunkId}" declares dimensions=${record.dimensions} but its vector has length ${record.vector.length}`,
    );
  }

  if (
    record.vector.some(
      (value) => typeof value !== 'number' || !Number.isFinite(value),
    )
  ) {
    throw new VectorStoreValidationError(
      `Embedding record for chunkId="${record.chunkId}" contains a non-numeric or non-finite vector value`,
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/vector-store/vector-store-record-validator.util.spec.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Write the failing test for the transformer**

```typescript
// src/vector-store/vector-store-record-transformer.util.spec.ts
import { transformToVectorPoint } from './vector-store-record-transformer.util';
import { EmbeddingRecord } from '../embedding/embedding.types';
import { Chunk } from '../chunking/chunking.types';
import { deriveVectorPointId } from './vector-store-id.util';

function buildChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    chunkId: 'child1',
    text: 'Run docker --version to check your install.',
    metadata: {
      documentId: 'doc1',
      sourcePath: 'install.md',
      documentTitle: 'Install Docker',
      headingPath: [
        { level: 1, text: 'Install Docker', anchor: 'install-docker' },
        { level: 2, text: 'On Ubuntu', anchor: 'on-ubuntu' },
      ],
      chunkType: 'child',
      contentTypes: ['paragraph'],
      length: 44,
      sequenceIndex: 0,
      wasSplit: false,
      wasMerged: false,
      mergedHeadings: [],
      exceedsMaxSize: false,
      contentHash: 'hash1',
      chunkedAt: '2026-08-17T00:00:00.000Z',
    },
    relationships: {
      parentChunkId: 'parent1',
      childChunkIds: [],
      previousChunkId: null,
      nextChunkId: null,
    },
    ...overrides,
  };
}

function buildRecord(
  overrides: Partial<EmbeddingRecord> = {},
): EmbeddingRecord {
  return {
    embeddingId: 'emb1',
    chunkId: 'child1',
    documentId: 'doc1',
    sourcePath: 'install.md',
    vector: [0.1, 0.2, 0.3],
    dimensions: 3,
    provider: 'google',
    model: 'gemini-embedding-2',
    modelVersion: '1',
    contentHash: 'hash1',
    inputHash: 'inputhash1',
    inputTokenCount: 5,
    truncated: false,
    createdAt: '2026-08-17T00:00:00.000Z',
    ...overrides,
  };
}

describe('transformToVectorPoint', () => {
  it('maps a record + its chunk + its parent into a VectorPoint', () => {
    const record = buildRecord();
    const chunk = buildChunk();
    const parentChunk = buildChunk({
      chunkId: 'parent1',
      text: 'Full section text about installing Docker on Ubuntu.',
    });

    const point = transformToVectorPoint(record, chunk, parentChunk, 'docker');

    expect(point.id).toBe(deriveVectorPointId('emb1'));
    expect(point.vector).toEqual([0.1, 0.2, 0.3]);
    expect(point.payload).toMatchObject({
      chunkId: 'child1',
      documentId: 'doc1',
      parentChunkId: 'parent1',
      chunkType: 'child',
      contentHash: 'hash1',
      headingPath: 'Install Docker › On Ubuntu',
      documentTitle: 'Install Docker',
      sourcePath: 'install.md',
      domain: 'docker',
      text: 'Run docker --version to check your install.',
      parentText: 'Full section text about installing Docker on Ubuntu.',
      provider: 'google',
      model: 'gemini-embedding-2',
      modelVersion: '1',
      dimensions: 3,
      embeddingId: 'emb1',
    });
    expect(typeof point.payload.indexedAt).toBe('string');
  });

  it('sets parentText to null when parentChunkId is null', () => {
    const chunk = buildChunk({
      relationships: {
        parentChunkId: null,
        childChunkIds: [],
        previousChunkId: null,
        nextChunkId: null,
      },
    });

    const point = transformToVectorPoint(buildRecord(), chunk, null, 'docker');

    expect(point.payload.parentChunkId).toBeNull();
    expect(point.payload.parentText).toBeNull();
  });

  it('sets parentText to null when the parent chunk could not be found', () => {
    const point = transformToVectorPoint(
      buildRecord(),
      buildChunk(),
      null,
      'docker',
    );

    expect(point.payload.parentChunkId).toBe('parent1');
    expect(point.payload.parentText).toBeNull();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm test src/vector-store/vector-store-record-transformer.util.spec.ts`
Expected: FAIL — `Cannot find module './vector-store-record-transformer.util'`

- [ ] **Step 7: Implement the transformer**

```typescript
// src/vector-store/vector-store-record-transformer.util.ts
import { Chunk } from '../chunking/chunking.types';
import { EmbeddingRecord } from '../embedding/embedding.types';
import { deriveVectorPointId } from './vector-store-id.util';
import { VectorPoint } from './vector-store.types';

export function transformToVectorPoint(
  record: EmbeddingRecord,
  chunk: Chunk,
  parentChunk: Chunk | null,
  domain: string,
): VectorPoint {
  const headingPath = chunk.metadata.headingPath
    .map((segment) => segment.text)
    .join(' › ');

  return {
    id: deriveVectorPointId(record.embeddingId),
    vector: record.vector,
    payload: {
      chunkId: chunk.chunkId,
      documentId: chunk.metadata.documentId,
      parentChunkId: chunk.relationships.parentChunkId,
      chunkType: chunk.metadata.chunkType,
      contentHash: chunk.metadata.contentHash,
      headingPath,
      documentTitle: chunk.metadata.documentTitle,
      sourcePath: chunk.metadata.sourcePath,
      domain,
      text: chunk.text,
      parentText: parentChunk ? parentChunk.text : null,
      provider: record.provider,
      model: record.model,
      modelVersion: record.modelVersion,
      dimensions: record.dimensions,
      embeddingId: record.embeddingId,
      indexedAt: new Date().toISOString(),
    },
  };
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm test src/vector-store/vector-store-record-transformer.util.spec.ts`
Expected: PASS (3 tests)

- [ ] **Step 9: Run build and lint**

Run: `pnpm build && pnpm lint`
Expected: no errors

- [ ] **Step 10: Commit**

```bash
git add src/vector-store/vector-store-record-validator.util.ts src/vector-store/vector-store-record-validator.util.spec.ts src/vector-store/vector-store-record-transformer.util.ts src/vector-store/vector-store-record-transformer.util.spec.ts
git commit -m "feat(vector-store): add record validator and EmbeddingRecord+Chunk to VectorPoint transformer"
```

---

### Task 6: `IndexingBatchProcessorService`

**Files:**

- Create: `src/vector-store/indexing-batch-processor.service.ts`
- Create: `src/vector-store/indexing-batch-processor.service.spec.ts`

**Interfaces:**

- Consumes: `VECTOR_STORE_PORT`, `VectorStorePort` from `./vector-store.port`; `VectorStoreConfigService` from `./vector-store-config.service`; `withRetry` from `../common/retry.util`; `TransientVectorStoreError` from `./vector-store.errors`; `VectorPoint` from `./vector-store.types`.
- Produces: `IndexBatchOutcome { batchId: string; succeededIds: string[]; failed: IndexFailure[] }`, `IndexingBatchProcessorService.processBatch(batchId: string, collection: string, points: VectorPoint[]): Promise<IndexBatchOutcome>` — consumed by Task 7.

- [ ] **Step 1: Write the failing test**

```typescript
// src/vector-store/indexing-batch-processor.service.spec.ts
import { PinoLogger } from 'nestjs-pino';
import { IndexingBatchProcessorService } from './indexing-batch-processor.service';
import { VectorStoreConfigService } from './vector-store-config.service';
import { FakeVectorStoreAdapter } from './providers/fake-vector-store.adapter';
import { TransientVectorStoreError } from './vector-store.errors';
import { VectorPoint } from './vector-store.types';

function buildPoint(overrides: Partial<VectorPoint> = {}): VectorPoint {
  return {
    id: '11111111-1111-5111-8111-111111111111',
    vector: [1, 0, 0],
    payload: {
      chunkId: 'chunk1',
      documentId: 'doc1',
      parentChunkId: null,
      chunkType: 'child',
      contentHash: 'hash1',
      headingPath: 'Install',
      documentTitle: 'Install Docker',
      sourcePath: 'install.md',
      domain: 'docker',
      text: 'text',
      parentText: null,
      provider: 'google',
      model: 'gemini-embedding-2',
      modelVersion: '1',
      dimensions: 3,
      embeddingId: 'emb1',
      indexedAt: '2026-08-17T00:00:00.000Z',
    },
    ...overrides,
  };
}

function buildConfig(
  overrides: Partial<VectorStoreConfigService> = {},
): VectorStoreConfigService {
  return {
    maxRetries: 3,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 5,
    requestTimeoutMs: 50,
    ...overrides,
  } as VectorStoreConfigService;
}

function buildLogger(): PinoLogger {
  return {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  } as unknown as PinoLogger;
}

describe('IndexingBatchProcessorService', () => {
  it('reports every point as succeeded on a successful upsert', async () => {
    const store = new FakeVectorStoreAdapter();
    await store.ensureCollection('c', 3);
    const service = new IndexingBatchProcessorService(
      store,
      buildConfig(),
      buildLogger(),
    );

    const outcome = await service.processBatch('batch-0', 'c', [buildPoint()]);

    expect(outcome.failed).toEqual([]);
    expect(outcome.succeededIds).toEqual([buildPoint().id]);
    expect((await store.collectionInfo('c'))!.pointCount).toBe(1);
  });

  it('retries a batch that fails transiently, then succeeds', async () => {
    const store = new FakeVectorStoreAdapter();
    await store.ensureCollection('c', 3);
    let calls = 0;
    jest.spyOn(store, 'upsert').mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 1) throw new TransientVectorStoreError('flaky');
      return FakeVectorStoreAdapter.prototype.upsert.apply(store, args);
    });
    const service = new IndexingBatchProcessorService(
      store,
      buildConfig(),
      buildLogger(),
    );

    const outcome = await service.processBatch('batch-0', 'c', [buildPoint()]);

    expect(outcome.succeededIds).toEqual([buildPoint().id]);
    expect(outcome.failed).toEqual([]);
  });

  it('reports every point in the batch as failed when upsert fails permanently after retries', async () => {
    const store = new FakeVectorStoreAdapter();
    await store.ensureCollection('c', 3);
    jest
      .spyOn(store, 'upsert')
      .mockRejectedValue(new TransientVectorStoreError('down'));
    const service = new IndexingBatchProcessorService(
      store,
      buildConfig({ maxRetries: 2 }),
      buildLogger(),
    );

    const outcome = await service.processBatch('batch-0', 'c', [
      buildPoint(),
      buildPoint({ id: '22222222-1111-5111-8111-111111111111' }),
    ]);

    expect(outcome.succeededIds).toEqual([]);
    expect(outcome.failed).toHaveLength(2);
  });

  it('classifies a timeout as a transient, retried failure', async () => {
    const store = new FakeVectorStoreAdapter();
    await store.ensureCollection('c', 3);
    jest.spyOn(store, 'upsert').mockImplementation(() => new Promise(() => {}));
    const service = new IndexingBatchProcessorService(
      store,
      buildConfig({ requestTimeoutMs: 20, maxRetries: 1 }),
      buildLogger(),
    );

    const outcome = await service.processBatch('batch-0', 'c', [buildPoint()]);

    expect(outcome.succeededIds).toEqual([]);
    expect(outcome.failed[0]!.message).toContain('timed out');
  });

  it('never throws out of processBatch itself', async () => {
    const store = new FakeVectorStoreAdapter();
    await store.ensureCollection('c', 3);
    jest
      .spyOn(store, 'upsert')
      .mockRejectedValue(new TransientVectorStoreError('down'));
    const service = new IndexingBatchProcessorService(
      store,
      buildConfig(),
      buildLogger(),
    );

    await expect(
      service.processBatch('batch-0', 'c', [buildPoint()]),
    ).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/vector-store/indexing-batch-processor.service.spec.ts`
Expected: FAIL — `Cannot find module './indexing-batch-processor.service'`

- [ ] **Step 3: Implement `IndexingBatchProcessorService`**

```typescript
// src/vector-store/indexing-batch-processor.service.ts
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { withRetry } from '../common/retry.util';
import { VectorStoreConfigService } from './vector-store-config.service';
import { VECTOR_STORE_PORT, VectorStorePort } from './vector-store.port';
import { TransientVectorStoreError } from './vector-store.errors';
import { IndexFailure, VectorPoint } from './vector-store.types';

export interface IndexBatchOutcome {
  batchId: string;
  succeededIds: string[];
  failed: IndexFailure[];
}

@Injectable()
export class IndexingBatchProcessorService {
  constructor(
    @Inject(VECTOR_STORE_PORT) private readonly store: VectorStorePort,
    private readonly config: VectorStoreConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(IndexingBatchProcessorService.name);
  }

  async processBatch(
    batchId: string,
    collection: string,
    points: VectorPoint[],
  ): Promise<IndexBatchOutcome> {
    try {
      await withRetry(() => this.upsertWithTimeout(collection, points), {
        maxAttempts: this.config.maxRetries,
        baseDelayMs: this.config.retryBaseDelayMs,
        maxDelayMs: this.config.retryMaxDelayMs,
        isRetryable: (err) => err instanceof TransientVectorStoreError,
        getRetryAfterMs: () => null,
      });
      return {
        batchId,
        succeededIds: points.map((p) => p.id),
        failed: [],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        { batchId, pointCount: points.length, error: message },
        'Index batch failed permanently after retries',
      );
      return {
        batchId,
        succeededIds: [],
        failed: points.map((p) => ({
          chunkId: p.payload.chunkId,
          message,
        })),
      };
    }
  }

  private upsertWithTimeout(
    collection: string,
    points: VectorPoint[],
  ): Promise<void> {
    let timeoutHandle!: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(
          new TransientVectorStoreError(
            `Vector store upsert timed out after ${this.config.requestTimeoutMs}ms`,
          ),
        );
      }, this.config.requestTimeoutMs);
    });

    return Promise.race([
      this.store.upsert(collection, points),
      timeoutPromise,
    ]).finally(() => {
      clearTimeout(timeoutHandle);
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/vector-store/indexing-batch-processor.service.spec.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Run build and lint**

Run: `pnpm build && pnpm lint`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/vector-store/indexing-batch-processor.service.ts src/vector-store/indexing-batch-processor.service.spec.ts
git commit -m "feat(vector-store): add IndexingBatchProcessorService with retry and timeout handling"
```

---

### Task 7: `IndexingPipelineService` orchestrator

**Files:**

- Create: `src/vector-store/indexing-pipeline.service.ts`
- Create: `src/vector-store/indexing-pipeline.service.spec.ts`

**Interfaces:**

- Consumes: `IndexingBatchProcessorService` (Task 6); `VectorStoreConfigService` (Task 3); `VECTOR_STORE_PORT`/`VectorStorePort` (Task 4); `validateRecordForIndexing`, `transformToVectorPoint` (Task 5); `EmbeddingRecord` from `../embedding/embedding.types`; `Chunk` from `../chunking/chunking.types`; `VectorStoreThresholdExceededError` from `./vector-store.errors`.
- Produces: `IndexingPipelineService.run(embeddingsFile: string, chunksDir: string, collection: string): Promise<IndexRunResult>` — consumed by Task 10 (CLI).

- [ ] **Step 1: Write the failing test**

```typescript
// src/vector-store/indexing-pipeline.service.spec.ts
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PinoLogger } from 'nestjs-pino';
import { IndexingPipelineService } from './indexing-pipeline.service';
import { IndexingBatchProcessorService } from './indexing-batch-processor.service';
import { VectorStoreConfigService } from './vector-store-config.service';
import { FakeVectorStoreAdapter } from './providers/fake-vector-store.adapter';
import { VectorStoreThresholdExceededError } from './vector-store.errors';
import { Chunk } from '../chunking/chunking.types';
import { EmbeddingRecord } from '../embedding/embedding.types';

function buildChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    chunkId: 'child1',
    text: 'Run docker --version.',
    metadata: {
      documentId: 'doc1',
      sourcePath: 'install.md',
      documentTitle: 'Install Docker',
      headingPath: [{ level: 1, text: 'Install', anchor: 'install' }],
      chunkType: 'child',
      contentTypes: ['paragraph'],
      length: 22,
      sequenceIndex: 0,
      wasSplit: false,
      wasMerged: false,
      mergedHeadings: [],
      exceedsMaxSize: false,
      contentHash: 'hash1',
      chunkedAt: '2026-08-17T00:00:00.000Z',
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

function buildRecord(
  overrides: Partial<EmbeddingRecord> = {},
): EmbeddingRecord {
  return {
    embeddingId: 'emb1',
    chunkId: 'child1',
    documentId: 'doc1',
    sourcePath: 'install.md',
    vector: [0.1, 0.2, 0.3],
    dimensions: 3,
    provider: 'google',
    model: 'gemini-embedding-2',
    modelVersion: '1',
    contentHash: 'hash1',
    inputHash: 'inputhash1',
    inputTokenCount: 5,
    truncated: false,
    createdAt: '2026-08-17T00:00:00.000Z',
    ...overrides,
  };
}

function buildConfig(
  overrides: Partial<VectorStoreConfigService> = {},
): VectorStoreConfigService {
  return {
    domain: 'docker',
    batchSize: 100,
    maxConcurrentBatches: 2,
    failureThreshold: 0.5,
    allowFakeProvider: false,
    maxRetries: 3,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 5,
    requestTimeoutMs: 50,
    ...overrides,
  } as VectorStoreConfigService;
}

function buildLogger(): PinoLogger {
  return {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  } as unknown as PinoLogger;
}

async function writeFixtures(
  root: string,
  chunks: Chunk[],
  records: EmbeddingRecord[],
): Promise<{ chunksDir: string; embeddingsFile: string }> {
  const chunksDir = join(root, 'chunks');
  await mkdir(chunksDir, { recursive: true });
  await writeFile(
    join(chunksDir, 'doc1.chunks.json'),
    JSON.stringify(chunks),
    'utf-8',
  );
  const embeddingsFile = join(root, 'embeddings.jsonl');
  await writeFile(
    embeddingsFile,
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf-8',
  );
  return { chunksDir, embeddingsFile };
}

describe('IndexingPipelineService', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vs-pipeline-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('indexes every eligible record into the target collection', async () => {
    const { chunksDir, embeddingsFile } = await writeFixtures(
      root,
      [buildChunk()],
      [buildRecord()],
    );
    const store = new FakeVectorStoreAdapter();
    const config = buildConfig();
    const logger = buildLogger();
    const batchProcessor = new IndexingBatchProcessorService(
      store,
      config,
      logger,
    );
    const pipeline = new IndexingPipelineService(
      config,
      store,
      batchProcessor,
      logger,
    );

    const result = await pipeline.run(
      embeddingsFile,
      chunksDir,
      'docker__google_v1',
    );

    expect(result.attempted).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect((await store.collectionInfo('docker__google_v1'))!.pointCount).toBe(
      1,
    );
  });

  it('is idempotent — re-running against the same fixtures does not duplicate points', async () => {
    const { chunksDir, embeddingsFile } = await writeFixtures(
      root,
      [buildChunk()],
      [buildRecord()],
    );
    const store = new FakeVectorStoreAdapter();
    const config = buildConfig();
    const logger = buildLogger();
    const batchProcessor = new IndexingBatchProcessorService(
      store,
      config,
      logger,
    );
    const pipeline = new IndexingPipelineService(
      config,
      store,
      batchProcessor,
      logger,
    );

    await pipeline.run(embeddingsFile, chunksDir, 'docker__google_v1');
    await pipeline.run(embeddingsFile, chunksDir, 'docker__google_v1');

    expect((await store.collectionInfo('docker__google_v1'))!.pointCount).toBe(
      1,
    );
  });

  it('skips fake-provider records by default and counts them separately', async () => {
    const { chunksDir, embeddingsFile } = await writeFixtures(
      root,
      [buildChunk()],
      [buildRecord({ provider: 'fake' })],
    );
    const store = new FakeVectorStoreAdapter();
    const config = buildConfig({ allowFakeProvider: false });
    const logger = buildLogger();
    const batchProcessor = new IndexingBatchProcessorService(
      store,
      config,
      logger,
    );
    const pipeline = new IndexingPipelineService(
      config,
      store,
      batchProcessor,
      logger,
    );

    const result = await pipeline.run(
      embeddingsFile,
      chunksDir,
      'docker__fake_v1',
    );

    expect(result.skippedFakeProvider).toBe(1);
    expect(result.attempted).toBe(0);
  });

  it('throws VectorStoreThresholdExceededError when failures exceed the configured threshold', async () => {
    const { chunksDir, embeddingsFile } = await writeFixtures(
      root,
      [
        buildChunk(),
        buildChunk({
          chunkId: 'child2',
          metadata: { ...buildChunk().metadata, contentHash: 'hash2' },
        }),
      ],
      [
        buildRecord(),
        buildRecord({
          embeddingId: 'emb2',
          chunkId: 'child2',
          contentHash: 'hash2',
        }),
      ],
    );
    const store = new FakeVectorStoreAdapter();
    jest.spyOn(store, 'upsert').mockRejectedValue(new Error('down'));
    const config = buildConfig({ failureThreshold: 0.1, maxRetries: 1 });
    const logger = buildLogger();
    const batchProcessor = new IndexingBatchProcessorService(
      store,
      config,
      logger,
    );
    const pipeline = new IndexingPipelineService(
      config,
      store,
      batchProcessor,
      logger,
    );

    await expect(
      pipeline.run(embeddingsFile, chunksDir, 'docker__google_v1'),
    ).rejects.toThrow(VectorStoreThresholdExceededError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/vector-store/indexing-pipeline.service.spec.ts`
Expected: FAIL — `Cannot find module './indexing-pipeline.service'`

- [ ] **Step 3: Implement `IndexingPipelineService`**

```typescript
// src/vector-store/indexing-pipeline.service.ts
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import pLimit from 'p-limit';
import { Chunk } from '../chunking/chunking.types';
import { EmbeddingRecord } from '../embedding/embedding.types';
import { IndexingBatchProcessorService } from './indexing-batch-processor.service';
import { VectorStoreConfigService } from './vector-store-config.service';
import { VECTOR_STORE_PORT, VectorStorePort } from './vector-store.port';
import { validateRecordForIndexing } from './vector-store-record-validator.util';
import { transformToVectorPoint } from './vector-store-record-transformer.util';
import { VectorStoreThresholdExceededError } from './vector-store.errors';
import {
  IndexFailure,
  IndexRunResult,
  VectorPoint,
} from './vector-store.types';

function chunkArray<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

@Injectable()
export class IndexingPipelineService {
  constructor(
    private readonly config: VectorStoreConfigService,
    @Inject(VECTOR_STORE_PORT) private readonly store: VectorStorePort,
    private readonly batchProcessor: IndexingBatchProcessorService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(IndexingPipelineService.name);
  }

  async run(
    embeddingsFile: string,
    chunksDir: string,
    collection: string,
  ): Promise<IndexRunResult> {
    const startedAt = Date.now();
    const jobId = randomUUID();

    const records = await this.readEmbeddingRecords(embeddingsFile);
    const chunksById = await this.readChunksById(chunksDir);

    this.logger.info(
      { jobId, collection, recordCount: records.length },
      'Indexing run started',
    );

    const dimensions =
      records[0]?.dimensions ?? this.inferDimensionsFallback(records);
    await this.store.ensureCollection(collection, dimensions);
    const info = await this.store.collectionInfo(collection);
    if (info && info.dimensions !== dimensions) {
      throw new Error(
        `Collection "${collection}" was created with dimensions=${info.dimensions}, but these records have dimensions=${dimensions}`,
      );
    }

    let skippedByProvenanceMismatch = 0;
    let skippedFakeProvider = 0;
    const points: VectorPoint[] = [];

    for (const record of records) {
      try {
        validateRecordForIndexing(
          record,
          { dimensions },
          { allowFakeProvider: this.config.allowFakeProvider },
        );
      } catch (err) {
        if (record.provider === 'fake' && !this.config.allowFakeProvider) {
          skippedFakeProvider += 1;
        } else {
          skippedByProvenanceMismatch += 1;
        }
        this.logger.debug(
          { chunkId: record.chunkId, error: (err as Error).message },
          'Skipping record during indexing validation',
        );
        continue;
      }

      const chunk = chunksById.get(record.chunkId);
      if (!chunk) {
        skippedByProvenanceMismatch += 1;
        this.logger.warn(
          { chunkId: record.chunkId },
          'No matching chunk found for embedding record — skipping',
        );
        continue;
      }

      const parentChunk = chunk.relationships.parentChunkId
        ? (chunksById.get(chunk.relationships.parentChunkId) ?? null)
        : null;
      if (chunk.relationships.parentChunkId && !parentChunk) {
        this.logger.warn(
          {
            chunkId: chunk.chunkId,
            parentChunkId: chunk.relationships.parentChunkId,
          },
          'Parent chunk not found — indexing without parent context',
        );
      }

      points.push(
        transformToVectorPoint(record, chunk, parentChunk, this.config.domain),
      );
    }

    const batches = chunkArray(points, this.config.batchSize);
    const limit = pLimit(this.config.maxConcurrentBatches);
    let succeededCount = 0;
    const failures: IndexFailure[] = [];

    await Promise.all(
      batches.map((batchPoints, index) =>
        limit(async () => {
          const batchId = `${jobId}-${index}`;
          const outcome = await this.batchProcessor.processBatch(
            batchId,
            collection,
            batchPoints,
          );
          succeededCount += outcome.succeededIds.length;
          failures.push(...outcome.failed);

          this.logger.info(
            {
              jobId,
              batchId,
              pointCount: batchPoints.length,
              succeeded: outcome.succeededIds.length,
              failed: outcome.failed.length,
            },
            'Index batch completed',
          );
        }),
      ),
    );

    const attempted = points.length;
    if (
      attempted > 0 &&
      failures.length / attempted > this.config.failureThreshold
    ) {
      throw new VectorStoreThresholdExceededError(failures.length, attempted);
    }

    const result: IndexRunResult = {
      jobId,
      collection,
      totalRecordsScanned: records.length,
      skippedByProvenanceMismatch,
      skippedFakeProvider,
      attempted,
      succeeded: succeededCount,
      failed: failures.length,
      failures,
      totalBatches: batches.length,
      durationMs: Date.now() - startedAt,
    };

    this.logger.info(
      { ...result, failures: undefined },
      'Indexing run completed',
    );
    return result;
  }

  private inferDimensionsFallback(records: EmbeddingRecord[]): number {
    return records[0]?.vector.length ?? 0;
  }

  private async readEmbeddingRecords(
    embeddingsFile: string,
  ): Promise<EmbeddingRecord[]> {
    const raw = await readFile(embeddingsFile, 'utf-8');
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as EmbeddingRecord);
  }

  private async readChunksById(chunksDir: string): Promise<Map<string, Chunk>> {
    const byId = new Map<string, Chunk>();
    const files = (await readdir(chunksDir)).filter((file) =>
      file.endsWith('.chunks.json'),
    );
    for (const file of files) {
      const raw = await readFile(join(chunksDir, file), 'utf-8');
      const chunks = JSON.parse(raw) as Chunk[];
      for (const chunk of chunks) {
        byId.set(chunk.chunkId, chunk);
      }
    }
    return byId;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/vector-store/indexing-pipeline.service.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Run build and lint**

Run: `pnpm build && pnpm lint`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/vector-store/indexing-pipeline.service.ts src/vector-store/indexing-pipeline.service.spec.ts
git commit -m "feat(vector-store): add IndexingPipelineService orchestrator"
```

---

### Task 8: `QdrantVectorStoreAdapter`

**Files:**

- Create: `src/vector-store/providers/qdrant-vector-store.adapter.ts`
- Create: `src/vector-store/providers/qdrant-vector-store.adapter.spec.ts`

**Interfaces:**

- Consumes: `VectorStorePort` (Task 4); all `vector-store.types` types; `TransientVectorStoreError`, `PermanentVectorStoreError` (Task 2).
- Produces: `QdrantVectorStoreAdapter` (constructed with `url: string, apiKey: string`) implementing `VectorStorePort` — consumed by Task 9 (module wiring).

- [ ] **Step 1: Write the failing test (mocks `global.fetch`, mirroring the Google embedding adapter's own test style)**

```typescript
// src/vector-store/providers/qdrant-vector-store.adapter.spec.ts
import { QdrantVectorStoreAdapter } from './qdrant-vector-store.adapter';
import {
  PermanentVectorStoreError,
  TransientVectorStoreError,
} from '../vector-store.errors';
import { VectorPoint } from '../vector-store.types';

function buildPoint(): VectorPoint {
  return {
    id: '11111111-1111-5111-8111-111111111111',
    vector: [0.1, 0.2, 0.3],
    payload: {
      chunkId: 'chunk1',
      documentId: 'doc1',
      parentChunkId: null,
      chunkType: 'child',
      contentHash: 'hash1',
      headingPath: 'Install',
      documentTitle: 'Install Docker',
      sourcePath: 'install.md',
      domain: 'docker',
      text: 'text',
      parentText: null,
      provider: 'google',
      model: 'gemini-embedding-2',
      modelVersion: '1',
      dimensions: 3,
      embeddingId: 'emb1',
      indexedAt: '2026-08-17T00:00:00.000Z',
    },
  };
}

function mockFetchOnce(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  jest.spyOn(global, 'fetch').mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response);
}

describe('QdrantVectorStoreAdapter', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('ensureCollection PUTs the collection with the correct vector size, using the api-key header', async () => {
    mockFetchOnce(200, { result: true });
    const adapter = new QdrantVectorStoreAdapter(
      'http://localhost:6333',
      'secret',
    );

    await adapter.ensureCollection('docker__google_v1', 768);

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://localhost:6333/collections/docker__google_v1');
    expect(init.method).toBe('PUT');
    expect(init.headers['api-key']).toBe('secret');
    expect(JSON.parse(init.body)).toEqual({
      vectors: { size: 768, distance: 'Cosine' },
    });
  });

  it('ensureCollection is a no-op (does not throw) when Qdrant reports the collection already exists (409)', async () => {
    mockFetchOnce(409, { status: { error: 'already exists' } });
    const adapter = new QdrantVectorStoreAdapter('http://localhost:6333', '');

    await expect(
      adapter.ensureCollection('docker__google_v1', 768),
    ).resolves.toBeUndefined();
  });

  it('collectionInfo maps a 200 response to CollectionInfo', async () => {
    mockFetchOnce(200, {
      result: {
        points_count: 42,
        config: { params: { vectors: { size: 768 } } },
      },
    });
    const adapter = new QdrantVectorStoreAdapter('http://localhost:6333', '');

    const info = await adapter.collectionInfo('docker__google_v1');

    expect(info).toEqual({ dimensions: 768, pointCount: 42 });
  });

  it('collectionInfo returns null on a 404', async () => {
    mockFetchOnce(404, { status: { error: 'not found' } });
    const adapter = new QdrantVectorStoreAdapter('http://localhost:6333', '');

    expect(await adapter.collectionInfo('missing')).toBeNull();
  });

  it('upsert PUTs points in the shape Qdrant expects', async () => {
    mockFetchOnce(200, { result: true });
    const adapter = new QdrantVectorStoreAdapter('http://localhost:6333', '');
    const point = buildPoint();

    await adapter.upsert('c', [point]);

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://localhost:6333/collections/c/points?wait=true');
    const body = JSON.parse(init.body);
    expect(body.points[0]).toEqual({
      id: point.id,
      vector: point.vector,
      payload: point.payload,
    });
  });

  it('search POSTs a query and maps results to VectorSearchMatch[]', async () => {
    mockFetchOnce(200, {
      result: [{ id: '1', score: 0.9, payload: buildPoint().payload }],
    });
    const adapter = new QdrantVectorStoreAdapter('http://localhost:6333', '');

    const matches = await adapter.search({
      collection: 'c',
      vector: [0.1, 0.2, 0.3],
      topK: 5,
      filter: { documentId: 'doc1' },
    });

    expect(matches).toEqual([
      { id: '1', score: 0.9, payload: buildPoint().payload },
    ]);
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.limit).toBe(5);
    expect(body.filter.must).toContainEqual({
      key: 'documentId',
      match: { value: 'doc1' },
    });
  });

  it('deleteByFilter POSTs a filter and returns the reported deleted count', async () => {
    mockFetchOnce(200, { result: { status: 'completed' } });
    mockFetchOnce(200, { result: { points_count: 3 } });
    const adapter = new QdrantVectorStoreAdapter('http://localhost:6333', '');

    const deleted = await adapter.deleteByFilter('c', { documentId: 'doc1' });

    expect(deleted).toBe(3);
  });

  it('maps a 429 response to RateLimit-classified TransientVectorStoreError with retryAfterMs', async () => {
    mockFetchOnce(
      429,
      { status: { error: 'rate limited' } },
      { 'retry-after': '2' },
    );
    const adapter = new QdrantVectorStoreAdapter('http://localhost:6333', '');

    await expect(adapter.collectionInfo('c')).rejects.toThrow(
      TransientVectorStoreError,
    );
  });

  it('maps a 5xx response to TransientVectorStoreError', async () => {
    mockFetchOnce(500, { status: { error: 'boom' } });
    const adapter = new QdrantVectorStoreAdapter('http://localhost:6333', '');

    await expect(adapter.upsert('c', [buildPoint()])).rejects.toThrow(
      TransientVectorStoreError,
    );
  });

  it('maps a 4xx (non-404/429) response to PermanentVectorStoreError', async () => {
    mockFetchOnce(400, { status: { error: 'bad request' } });
    const adapter = new QdrantVectorStoreAdapter('http://localhost:6333', '');

    await expect(adapter.upsert('c', [buildPoint()])).rejects.toThrow(
      PermanentVectorStoreError,
    );
  });

  it('maps a network-level rejection to TransientVectorStoreError with a cause', async () => {
    const networkErr = new Error('ECONNREFUSED');
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(networkErr);
    const adapter = new QdrantVectorStoreAdapter('http://localhost:6333', '');

    await expect(adapter.collectionInfo('c')).rejects.toThrow(
      TransientVectorStoreError,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/vector-store/providers/qdrant-vector-store.adapter.spec.ts`
Expected: FAIL — `Cannot find module './qdrant-vector-store.adapter'`

- [ ] **Step 3: Implement `QdrantVectorStoreAdapter`**

```typescript
// src/vector-store/providers/qdrant-vector-store.adapter.ts
import { VectorStorePort } from '../vector-store.port';
import {
  PermanentVectorStoreError,
  TransientVectorStoreError,
} from '../vector-store.errors';
import {
  CollectionInfo,
  VectorPayload,
  VectorPoint,
  VectorSearchFilter,
  VectorSearchMatch,
  VectorSearchQuery,
} from '../vector-store.types';

interface QdrantFilterCondition {
  key: string;
  match: { value: string };
}

function buildQdrantFilter(
  filter?: VectorSearchFilter,
): { must: QdrantFilterCondition[] } | undefined {
  if (!filter) return undefined;
  const must: QdrantFilterCondition[] = [];
  if (filter.domain !== undefined)
    must.push({ key: 'domain', match: { value: filter.domain } });
  if (filter.documentId !== undefined)
    must.push({ key: 'documentId', match: { value: filter.documentId } });
  if (filter.chunkType !== undefined)
    must.push({ key: 'chunkType', match: { value: filter.chunkType } });
  if (filter.sourcePath !== undefined)
    must.push({ key: 'sourcePath', match: { value: filter.sourcePath } });
  if (must.length === 0) return undefined;
  return { must };
}

export class QdrantVectorStoreAdapter implements VectorStorePort {
  constructor(
    private readonly url: string,
    private readonly apiKey: string,
  ) {}

  async ensureCollection(
    collection: string,
    dimensions: number,
  ): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.url}/collections/${collection}`, {
        method: 'PUT',
        headers: this.headers(),
        body: JSON.stringify({
          vectors: { size: dimensions, distance: 'Cosine' },
        }),
      });
    } catch (err) {
      throw new TransientVectorStoreError(
        'Qdrant ensureCollection request failed',
        {
          cause: err,
        },
      );
    }
    if (!response.ok && response.status !== 409) {
      throw await this.toError(response);
    }
  }

  async collectionInfo(collection: string): Promise<CollectionInfo | null> {
    let response: Response;
    try {
      response = await fetch(`${this.url}/collections/${collection}`, {
        method: 'GET',
        headers: this.headers(),
      });
    } catch (err) {
      throw new TransientVectorStoreError(
        'Qdrant collectionInfo request failed',
        {
          cause: err,
        },
      );
    }
    if (response.status === 404) return null;
    if (!response.ok) throw await this.toError(response);

    const body = (await response.json()) as {
      result: {
        points_count: number;
        config: { params: { vectors: { size: number } } };
      };
    };
    return {
      dimensions: body.result.config.params.vectors.size,
      pointCount: body.result.points_count,
    };
  }

  async upsert(collection: string, points: VectorPoint[]): Promise<void> {
    let response: Response;
    try {
      response = await fetch(
        `${this.url}/collections/${collection}/points?wait=true`,
        {
          method: 'PUT',
          headers: this.headers(),
          body: JSON.stringify({
            points: points.map((p) => ({
              id: p.id,
              vector: p.vector,
              payload: p.payload,
            })),
          }),
        },
      );
    } catch (err) {
      throw new TransientVectorStoreError('Qdrant upsert request failed', {
        cause: err,
      });
    }
    if (!response.ok) throw await this.toError(response);
  }

  async search(query: VectorSearchQuery): Promise<VectorSearchMatch[]> {
    let response: Response;
    try {
      const body: Record<string, unknown> = {
        vector: query.vector,
        limit: query.topK,
        with_payload: true,
      };
      const filter = buildQdrantFilter(query.filter);
      if (filter) body.filter = filter;
      if (query.scoreThreshold !== undefined)
        body.score_threshold = query.scoreThreshold;

      response = await fetch(
        `${this.url}/collections/${query.collection}/points/search`,
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
        },
      );
    } catch (err) {
      throw new TransientVectorStoreError('Qdrant search request failed', {
        cause: err,
      });
    }
    if (!response.ok) throw await this.toError(response);

    const parsed = (await response.json()) as {
      result: Array<{ id: string; score: number; payload: VectorPayload }>;
    };
    return parsed.result.map((r) => ({
      id: r.id,
      score: r.score,
      payload: r.payload,
    }));
  }

  async deleteByFilter(
    collection: string,
    filter: VectorSearchFilter,
  ): Promise<number> {
    const qdrantFilter = buildQdrantFilter(filter) ?? { must: [] };
    let response: Response;
    try {
      response = await fetch(
        `${this.url}/collections/${collection}/points/delete?wait=true`,
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ filter: qdrantFilter }),
        },
      );
    } catch (err) {
      throw new TransientVectorStoreError('Qdrant delete request failed', {
        cause: err,
      });
    }
    if (!response.ok) throw await this.toError(response);

    const countResponse = await fetch(
      `${this.url}/collections/${collection}/points/count`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ filter: qdrantFilter }),
      },
    );
    if (!countResponse.ok) return 0;
    const counted = (await countResponse.json()) as {
      result: { points_count: number };
    };
    return counted.result.points_count;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) headers['api-key'] = this.apiKey;
    return headers;
  }

  private async toError(response: Response): Promise<Error> {
    if (response.status === 429) {
      return new TransientVectorStoreError(
        `Qdrant rate limit exceeded (status ${response.status})`,
      );
    }
    if (response.status >= 500) {
      return new TransientVectorStoreError(
        `Qdrant request failed with status ${response.status}`,
      );
    }
    return new PermanentVectorStoreError(
      `Qdrant request failed with status ${response.status}`,
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/vector-store/providers/qdrant-vector-store.adapter.spec.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Run build and lint**

Run: `pnpm build && pnpm lint`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/vector-store/providers/qdrant-vector-store.adapter.ts src/vector-store/providers/qdrant-vector-store.adapter.spec.ts
git commit -m "feat(vector-store): add QdrantVectorStoreAdapter"
```

---

### Task 9: `VectorStoreModule` DI wiring

**Files:**

- Create: `src/vector-store/vector-store.module.ts`
- Create: `src/vector-store/vector-store.module.spec.ts`

**Interfaces:**

- Consumes: everything produced by Tasks 2–8.
- Produces: `VectorStoreModule` exporting `IndexingPipelineService`, `VECTOR_STORE_PORT`, `VectorStoreConfigService` — consumed by Tasks 10, 13 (retrieval reuses the same port token).

- [ ] **Step 1: Write the failing test (mirrors `embedding.module.spec.ts`'s own style: resolve via Nest's `Test.createTestingModule`, assert the right adapter is bound per config)**

```typescript
// src/vector-store/vector-store.module.spec.ts
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from '../config/env.validation';
import { VectorStoreModule } from './vector-store.module';
import { VECTOR_STORE_PORT } from './vector-store.port';
import { FakeVectorStoreAdapter } from './providers/fake-vector-store.adapter';
import { QdrantVectorStoreAdapter } from './providers/qdrant-vector-store.adapter';

async function buildModule(env: Record<string, string>) {
  const original = { ...process.env };
  Object.assign(process.env, env);
  try {
    return await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
        LoggerModule.forRoot(),
        VectorStoreModule,
      ],
    }).compile();
  } finally {
    process.env = original;
  }
}

describe('VectorStoreModule', () => {
  it('binds FakeVectorStoreAdapter when VECTOR_STORE_PROVIDER=fake', async () => {
    const moduleRef = await buildModule({ VECTOR_STORE_PROVIDER: 'fake' });
    expect(moduleRef.get(VECTOR_STORE_PORT)).toBeInstanceOf(
      FakeVectorStoreAdapter,
    );
  });

  it('binds QdrantVectorStoreAdapter when VECTOR_STORE_PROVIDER=qdrant', async () => {
    const moduleRef = await buildModule({ VECTOR_STORE_PROVIDER: 'qdrant' });
    expect(moduleRef.get(VECTOR_STORE_PORT)).toBeInstanceOf(
      QdrantVectorStoreAdapter,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/vector-store/vector-store.module.spec.ts`
Expected: FAIL — `Cannot find module './vector-store.module'`

- [ ] **Step 3: Implement `VectorStoreModule`**

```typescript
// src/vector-store/vector-store.module.ts
import { Module } from '@nestjs/common';
import { IndexingBatchProcessorService } from './indexing-batch-processor.service';
import { IndexingPipelineService } from './indexing-pipeline.service';
import { VectorStoreConfigService } from './vector-store-config.service';
import { VECTOR_STORE_PORT, VectorStorePort } from './vector-store.port';
import { FakeVectorStoreAdapter } from './providers/fake-vector-store.adapter';
import { QdrantVectorStoreAdapter } from './providers/qdrant-vector-store.adapter';

function createVectorStore(config: VectorStoreConfigService): VectorStorePort {
  if (config.provider === 'fake') {
    return new FakeVectorStoreAdapter();
  }
  return new QdrantVectorStoreAdapter(config.url, config.apiKey);
}

@Module({
  providers: [
    VectorStoreConfigService,
    {
      provide: VECTOR_STORE_PORT,
      useFactory: createVectorStore,
      inject: [VectorStoreConfigService],
    },
    IndexingBatchProcessorService,
    IndexingPipelineService,
  ],
  exports: [
    IndexingPipelineService,
    VECTOR_STORE_PORT,
    VectorStoreConfigService,
  ],
})
export class VectorStoreModule {}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/vector-store/vector-store.module.spec.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Run build and lint**

Run: `pnpm build && pnpm lint`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/vector-store/vector-store.module.ts src/vector-store/vector-store.module.spec.ts
git commit -m "feat(vector-store): add VectorStoreModule DI wiring"
```

---

### Task 10: `pnpm index` CLI

**Files:**

- Create: `src/cli/index.ts`
- Modify: `package.json` (add `"index": "node dist/cli/index.js"` script)

**Interfaces:**

- Consumes: `IndexingPipelineService.run(embeddingsFile, chunksDir, collection)` (Task 7/9); `VectorStoreConfigService` (Task 3); `EmbeddingConfigService` (existing, from `../embedding/embedding-config.service`) — used to derive the collection name.

Collection-name derivation is a small, pure function needed by both this CLI and Task 14's query CLI — defined once here and imported by Task 14, not duplicated.

- [ ] **Step 1: Create the collection-naming helper (no isolated unit test — covered end-to-end by this task's manual verification and by Task 14's own tests, matching the CLI module's existing `!cli/**` coverage exclusion)**

```typescript
// src/vector-store/vector-store-collection-name.util.ts
function sanitize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

export function deriveCollectionName(config: {
  domain: string;
  provider: string;
  model: string;
  dimensions: number;
  modelVersion: string;
}): string {
  return sanitize(
    `${config.domain}__${config.provider}_${config.model}_${config.dimensions}d_v${config.modelVersion}`,
  );
}
```

- [ ] **Step 2: Write a focused unit test for the naming helper**

```typescript
// src/vector-store/vector-store-collection-name.util.spec.ts
import { deriveCollectionName } from './vector-store-collection-name.util';

describe('deriveCollectionName', () => {
  it('joins domain/provider/model/dimensions/version into a sanitized name', () => {
    expect(
      deriveCollectionName({
        domain: 'docker',
        provider: 'google',
        model: 'gemini-embedding-2',
        dimensions: 768,
        modelVersion: '1',
      }),
    ).toBe('docker__google_gemini-embedding-2_768d_v1'.replace(/-/g, '-'));
  });

  it('sanitizes uppercase and non-alphanumeric characters', () => {
    expect(
      deriveCollectionName({
        domain: 'Docker',
        provider: 'Fake',
        model: 'Fake Model!',
        dimensions: 4,
        modelVersion: '1',
      }),
    ).toBe('docker__fake_fake_model__4d_v1');
  });
});
```

- [ ] **Step 3: Run test to verify it fails, then implement, then verify it passes**

Run: `pnpm test src/vector-store/vector-store-collection-name.util.spec.ts` → FAIL (module missing) → add Step 1's file → re-run → PASS (2 tests).

Note: hyphens in `model` (e.g. `gemini-embedding-2`) are preserved as-is by the sanitizer's regex (`[^a-z0-9_]` does not match `-`... correction: a literal `-` **is not** in the allowed set `a-z0-9_`, so it **is** replaced). Confirm this by running the test — if the first assertion fails because hyphens get replaced with `_`, that is the correct, intended behavior (collection names must stay in `[a-z0-9_]` only per design §9); fix the test's expected string to `docker__google_gemini_embedding_2_768d_v1` rather than changing the sanitizer.

- [ ] **Step 4: Create the CLI module**

```typescript
// src/cli/index.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger, LoggerModule } from 'nestjs-pino';
import { AppConfigService } from '../config/app-config.service';
import { validateEnv } from '../config/env.validation';
import { buildPinoHttpOptions } from '../config/pino-http-options.factory';
import { EmbeddingConfigService } from '../embedding/embedding-config.service';
import { EmbeddingModule } from '../embedding/embedding.module';
import { VectorStoreModule } from '../vector-store/vector-store.module';
import { IndexingPipelineService } from '../vector-store/indexing-pipeline.service';
import { VectorStoreConfigService } from '../vector-store/vector-store-config.service';
import { deriveCollectionName } from '../vector-store/vector-store-collection-name.util';

const DEFAULT_EMBEDDINGS_FILE = './data/embedding-output/embeddings.jsonl';
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
    VectorStoreModule,
  ],
  providers: [AppConfigService],
})
class IndexCliModule {}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const embeddingsFile = args[0] ?? DEFAULT_EMBEDDINGS_FILE;
  const chunksDir = args[1] ?? DEFAULT_CHUNKS_DIR;

  const app = await NestFactory.createApplicationContext(IndexCliModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  const pipeline = app.get(IndexingPipelineService);
  const vectorStoreConfig = app.get(VectorStoreConfigService);
  const embeddingConfig = app.get(EmbeddingConfigService);

  const collection = deriveCollectionName({
    domain: vectorStoreConfig.domain,
    provider: embeddingConfig.provider,
    model: embeddingConfig.model,
    dimensions: embeddingConfig.dimensions,
    modelVersion: embeddingConfig.modelVersion,
  });

  try {
    const result = await pipeline.run(embeddingsFile, chunksDir, collection);

    console.log('\n=== Indexing Result ===');
    console.log(JSON.stringify(result, null, 2));
    console.log(`\nCollection: ${result.collection}`);

    if (result.failed > 0) {
      console.error(
        `\n${result.failed} point(s) failed to index — see "failures" above.`,
      );
      process.exitCode = 1;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nIndexing run failed: ${message}`);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main();
```

- [ ] **Step 5: Add the `pnpm index` script**

In `package.json`'s `"scripts"` block, add immediately after `"embed": "node dist/cli/embed.js",`:

```json
    "index": "node dist/cli/index.js",
```

- [ ] **Step 6: Manual verification against the fake provider (bounded, no real DB required)**

Run:

```bash
pnpm build
EMBEDDING_PROVIDER=fake VECTOR_STORE_PROVIDER=fake node dist/cli/index.js ./data/embedding-output/embeddings.jsonl ./data/chunks-output
```

Expected: prints an `=== Indexing Result ===` JSON block with `attempted === succeeded` and `failed: 0`, using whatever fake `embeddings.jsonl`/chunk fixtures exist locally from prior M2/M3 runs (regenerate via `pnpm ingest && pnpm chunk && EMBEDDING_PROVIDER=fake pnpm embed` first if `./data/embedding-output` is empty).

- [ ] **Step 7: Run build and lint**

Run: `pnpm build && pnpm lint`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add src/cli/index.ts src/vector-store/vector-store-collection-name.util.ts src/vector-store/vector-store-collection-name.util.spec.ts package.json
git commit -m "feat(cli): add pnpm index CLI for indexing embeddings into the vector store"
```

---

### Task 11: Retrieval domain types and `RetrievalConfigService`

**Files:**

- Modify: `src/config/env.validation.ts`
- Create: `src/retrieval/retrieval.types.ts`
- Create: `src/retrieval/retrieval.errors.ts`
- Create: `src/retrieval/retrieval.errors.spec.ts`
- Create: `src/retrieval/retrieval-config.service.ts`
- Create: `src/retrieval/retrieval-config.service.spec.ts`

**Interfaces:**

- Consumes: `EnvConfig`, `ChunkType`.
- Produces: `RetrievalFilter, RetrievalQuery, RetrievalResult` types; `RetrievalValidationError`, `RetrievalConfigMismatchError`; `RetrievalConfigService` with getters `defaultTopK, maxTopK, scoreThreshold, expandToParent, requestTimeoutMs, maxRetries` — consumed by Task 12.

- [ ] **Step 1: Add retrieval env vars to the schema**

In `src/config/env.validation.ts`, add these keys immediately after the `VECTOR_STORE_ALLOW_FAKE_PROVIDER` key added in Task 3:

```typescript
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
```

Add this `.refine(...)` chained after the `VECTOR_STORE_RETRY_BASE_DELAY_MS`/`VECTOR_STORE_RETRY_MAX_DELAY_MS` refine added in Task 3:

```typescript
  .refine(
    (config) => config.RETRIEVAL_DEFAULT_TOP_K <= config.RETRIEVAL_MAX_TOP_K,
    {
      message:
        'RETRIEVAL_DEFAULT_TOP_K must be less than or equal to RETRIEVAL_MAX_TOP_K',
      path: ['RETRIEVAL_DEFAULT_TOP_K'],
    },
  );
```

- [ ] **Step 2: Write the failing test for the retrieval error taxonomy**

```typescript
// src/retrieval/retrieval.errors.spec.ts
import {
  RetrievalConfigMismatchError,
  RetrievalValidationError,
} from './retrieval.errors';

describe('retrieval error taxonomy', () => {
  it('RetrievalValidationError names itself', () => {
    expect(new RetrievalValidationError('bad query').name).toBe(
      'RetrievalValidationError',
    );
  });

  it('RetrievalConfigMismatchError composes a message naming both configurations', () => {
    const err = new RetrievalConfigMismatchError(
      { provider: 'google', model: 'gemini-embedding-2', dimensions: 768 },
      { provider: 'google', model: 'gemini-embedding-2', dimensions: 3 },
    );
    expect(err.name).toBe('RetrievalConfigMismatchError');
    expect(err.message).toContain('768');
    expect(err.message).toContain('3');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test src/retrieval/retrieval.errors.spec.ts`
Expected: FAIL — `Cannot find module './retrieval.errors'`

- [ ] **Step 4: Implement the retrieval error taxonomy and types**

```typescript
// src/retrieval/retrieval.errors.ts
interface EmbeddingConfigSummary {
  provider: string;
  model: string;
  dimensions: number;
}

export class RetrievalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetrievalValidationError';
  }
}

export class RetrievalConfigMismatchError extends Error {
  constructor(
    public readonly expected: EmbeddingConfigSummary,
    public readonly actual: EmbeddingConfigSummary,
  ) {
    super(
      `Retrieval is configured for provider=${actual.provider}/model=${actual.model}/dimensions=${actual.dimensions}, but the target collection was built with provider=${expected.provider}/model=${expected.model}/dimensions=${expected.dimensions}. Point RETRIEVAL_* at a matching collection, or re-index with the current embedding configuration.`,
    );
    this.name = 'RetrievalConfigMismatchError';
  }
}
```

```typescript
// src/retrieval/retrieval.types.ts
import { ChunkType } from '../chunking/chunking.types';

export interface RetrievalFilter {
  domain?: string;
  documentId?: string;
  sourcePath?: string;
}

export interface RetrievalQuery {
  text: string;
  domain: string;
  topK?: number;
  scoreThreshold?: number;
  filter?: RetrievalFilter;
  expandToParent?: boolean;
}

export interface RetrievalResult {
  chunkId: string;
  documentId: string;
  parentChunkId: string | null;
  chunkType: ChunkType;
  score: number;
  text: string;
  parentText: string | null;
  headingPath: string;
  documentTitle: string;
  sourcePath: string;
  domain: string;
}

export type { ChunkType };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test src/retrieval/retrieval.errors.spec.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Write the failing test for `RetrievalConfigService`**

```typescript
// src/retrieval/retrieval-config.service.spec.ts
import { ConfigService } from '@nestjs/config';
import { EnvConfig, validateEnv } from '../config/env.validation';
import { RetrievalConfigService } from './retrieval-config.service';

function buildService(
  overrides: Partial<Record<string, string>> = {},
): RetrievalConfigService {
  const env = validateEnv({ ...overrides });
  const configService = new ConfigService<EnvConfig, true>(env);
  return new RetrievalConfigService(configService);
}

describe('RetrievalConfigService', () => {
  it('exposes defaults matching the schema', () => {
    const service = buildService();
    expect(service.defaultTopK).toBe(10);
    expect(service.maxTopK).toBe(100);
    expect(service.scoreThreshold).toBe(0);
    expect(service.expandToParent).toBe(true);
    expect(service.requestTimeoutMs).toBe(10000);
    expect(service.maxRetries).toBe(2);
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `pnpm test src/retrieval/retrieval-config.service.spec.ts`
Expected: FAIL — `Cannot find module './retrieval-config.service'`

- [ ] **Step 8: Implement `RetrievalConfigService`**

```typescript
// src/retrieval/retrieval-config.service.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from '../config/env.validation';

@Injectable()
export class RetrievalConfigService {
  constructor(private readonly configService: ConfigService<EnvConfig, true>) {}

  get defaultTopK(): number {
    return this.configService.get('RETRIEVAL_DEFAULT_TOP_K', { infer: true });
  }

  get maxTopK(): number {
    return this.configService.get('RETRIEVAL_MAX_TOP_K', { infer: true });
  }

  get scoreThreshold(): number {
    return this.configService.get('RETRIEVAL_SCORE_THRESHOLD', {
      infer: true,
    });
  }

  get expandToParent(): boolean {
    return this.configService.get('RETRIEVAL_EXPAND_TO_PARENT', {
      infer: true,
    });
  }

  get requestTimeoutMs(): number {
    return this.configService.get('RETRIEVAL_REQUEST_TIMEOUT_MS', {
      infer: true,
    });
  }

  get maxRetries(): number {
    return this.configService.get('RETRIEVAL_MAX_RETRIES', { infer: true });
  }
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `pnpm test src/retrieval/retrieval-config.service.spec.ts`
Expected: PASS (1 test)

- [ ] **Step 10: Print the exact `.env.example` lines for manual addition**

```
RETRIEVAL_DEFAULT_TOP_K=10
RETRIEVAL_MAX_TOP_K=100
RETRIEVAL_SCORE_THRESHOLD=0
RETRIEVAL_EXPAND_TO_PARENT=true
RETRIEVAL_REQUEST_TIMEOUT_MS=10000
RETRIEVAL_MAX_RETRIES=2
```

- [ ] **Step 11: Run build and lint**

Run: `pnpm build && pnpm lint`
Expected: no errors

- [ ] **Step 12: Commit**

```bash
git add src/config/env.validation.ts src/retrieval/
git commit -m "feat(retrieval): add retrieval domain types, error taxonomy, and RetrievalConfigService"
```

---

### Task 12: `RetrievalService`

**Files:**

- Create: `src/retrieval/retrieval.service.ts`
- Create: `src/retrieval/retrieval.service.spec.ts`

**Interfaces:**

- Consumes: `EMBEDDING_PROVIDER_PORT`/`EmbeddingProviderPort` from `../embedding/embedding-provider.port`; `VECTOR_STORE_PORT`/`VectorStorePort` from `../vector-store/vector-store.port`; `RetrievalConfigService` (Task 11); `withRetry` from `../common/retry.util`; `TransientEmbeddingProviderError` from `../embedding/embedding.errors`; `deriveCollectionName` from `../vector-store/vector-store-collection-name.util`; `EmbeddingModelMetadata`.
- Produces: `RetrievalService.retrieve(query: RetrievalQuery, collection: string): Promise<RetrievalResult[]>` — consumed by Task 14 (CLI).

- [ ] **Step 1: Write the failing test**

```typescript
// src/retrieval/retrieval.service.spec.ts
import { PinoLogger } from 'nestjs-pino';
import { RetrievalService } from './retrieval.service';
import { RetrievalConfigService } from './retrieval-config.service';
import {
  RetrievalConfigMismatchError,
  RetrievalValidationError,
} from './retrieval.errors';
import { FakeEmbeddingProvider } from '../embedding/providers/fake-embedding-provider';
import { FakeVectorStoreAdapter } from '../vector-store/providers/fake-vector-store.adapter';
import { VectorPoint } from '../vector-store/vector-store.types';

function buildConfig(
  overrides: Partial<RetrievalConfigService> = {},
): RetrievalConfigService {
  return {
    defaultTopK: 5,
    maxTopK: 10,
    scoreThreshold: 0,
    expandToParent: true,
    requestTimeoutMs: 50,
    maxRetries: 2,
    ...overrides,
  } as RetrievalConfigService;
}

function buildLogger(): PinoLogger {
  return {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as PinoLogger;
}

function buildPoint(overrides: Partial<VectorPoint> = {}): VectorPoint {
  return {
    id: '11111111-1111-5111-8111-111111111111',
    vector: [1, 0, 0, 0],
    payload: {
      chunkId: 'child1',
      documentId: 'doc1',
      parentChunkId: 'parent1',
      chunkType: 'child',
      contentHash: 'hash1',
      headingPath: 'Install',
      documentTitle: 'Install Docker',
      sourcePath: 'install.md',
      domain: 'docker',
      text: 'Run docker --version.',
      parentText: 'Full section about installing Docker.',
      provider: 'fake',
      model: 'fake-model',
      modelVersion: '1',
      dimensions: 4,
      embeddingId: 'emb1',
      indexedAt: '2026-08-17T00:00:00.000Z',
    },
    ...overrides,
  };
}

const metadata = {
  provider: 'fake',
  model: 'fake-model',
  modelVersion: '1',
  dimensions: 4,
};

async function setUp() {
  const store = new FakeVectorStoreAdapter();
  await store.ensureCollection('docker__fake_fake-model_4d_v1', 4);
  await store.upsert('docker__fake_fake-model_4d_v1', [buildPoint()]);
  const provider = new FakeEmbeddingProvider(metadata);
  const service = new RetrievalService(
    provider,
    store,
    buildConfig(),
    buildLogger(),
  );
  return { store, provider, service };
}

describe('RetrievalService', () => {
  it('embeds the query, searches, and returns normalized results with parent context', async () => {
    const { service } = await setUp();

    const results = await service.retrieve(
      { text: 'How do I check my docker version?', domain: 'docker' },
      'docker__fake_fake-model_4d_v1',
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      chunkId: 'child1',
      documentId: 'doc1',
      parentChunkId: 'parent1',
      chunkType: 'child',
      text: 'Run docker --version.',
      parentText: 'Full section about installing Docker.',
      headingPath: 'Install',
      documentTitle: 'Install Docker',
      sourcePath: 'install.md',
      domain: 'docker',
    });
    expect(typeof results[0]!.score).toBe('number');
  });

  it('omits parentText when expandToParent is false', async () => {
    const { service } = await setUp();

    const results = await service.retrieve(
      { text: 'question', domain: 'docker', expandToParent: false },
      'docker__fake_fake-model_4d_v1',
    );

    expect(results[0]!.parentText).toBeNull();
  });

  it('rejects an empty query', async () => {
    const { service } = await setUp();

    await expect(
      service.retrieve({ text: '   ', domain: 'docker' }, 'c'),
    ).rejects.toThrow(RetrievalValidationError);
  });

  it('rejects a topK above RETRIEVAL_MAX_TOP_K', async () => {
    const { service } = await setUp();

    await expect(
      service.retrieve(
        { text: 'q', domain: 'docker', topK: 999 },
        'docker__fake_fake-model_4d_v1',
      ),
    ).rejects.toThrow(RetrievalValidationError);
  });

  it('throws RetrievalConfigMismatchError when the target collection dimensions do not match the embedding provider', async () => {
    const store = new FakeVectorStoreAdapter();
    await store.ensureCollection('mismatched', 999);
    const provider = new FakeEmbeddingProvider(metadata);
    const service = new RetrievalService(
      provider,
      store,
      buildConfig(),
      buildLogger(),
    );

    await expect(
      service.retrieve({ text: 'q', domain: 'docker' }, 'mismatched'),
    ).rejects.toThrow(RetrievalConfigMismatchError);
  });

  it('maps RetrievalFilter to a VectorSearchFilter passed to the store', async () => {
    const { store, service } = await setUp();
    const searchSpy = jest.spyOn(store, 'search');

    await service.retrieve(
      {
        text: 'q',
        domain: 'docker',
        filter: { documentId: 'doc1', sourcePath: 'install.md' },
      },
      'docker__fake_fake-model_4d_v1',
    );

    expect(searchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: {
          domain: 'docker',
          documentId: 'doc1',
          sourcePath: 'install.md',
        },
      }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/retrieval/retrieval.service.spec.ts`
Expected: FAIL — `Cannot find module './retrieval.service'`

- [ ] **Step 3: Implement `RetrievalService`**

```typescript
// src/retrieval/retrieval.service.ts
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { withRetry } from '../common/retry.util';
import {
  EMBEDDING_PROVIDER_PORT,
  EmbeddingProviderPort,
} from '../embedding/embedding-provider.port';
import { TransientEmbeddingProviderError } from '../embedding/embedding.errors';
import {
  VECTOR_STORE_PORT,
  VectorStorePort,
} from '../vector-store/vector-store.port';
import { RetrievalConfigService } from './retrieval-config.service';
import {
  RetrievalConfigMismatchError,
  RetrievalValidationError,
} from './retrieval.errors';
import { RetrievalQuery, RetrievalResult } from './retrieval.types';

@Injectable()
export class RetrievalService {
  constructor(
    @Inject(EMBEDDING_PROVIDER_PORT)
    private readonly embeddingProvider: EmbeddingProviderPort,
    @Inject(VECTOR_STORE_PORT) private readonly store: VectorStorePort,
    private readonly config: RetrievalConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RetrievalService.name);
  }

  async retrieve(
    query: RetrievalQuery,
    collection: string,
  ): Promise<RetrievalResult[]> {
    const startedAt = Date.now();
    const text = query.text.trim();
    if (text.length === 0) {
      throw new RetrievalValidationError('Query text must not be empty');
    }

    const topK = query.topK ?? this.config.defaultTopK;
    if (topK > this.config.maxTopK) {
      throw new RetrievalValidationError(
        `Requested topK=${topK} exceeds RETRIEVAL_MAX_TOP_K=${this.config.maxTopK}`,
      );
    }

    const collectionInfo = await this.store.collectionInfo(collection);
    if (
      collectionInfo &&
      collectionInfo.dimensions !== this.embeddingProvider.metadata.dimensions
    ) {
      throw new RetrievalConfigMismatchError(
        {
          provider: this.embeddingProvider.metadata.provider,
          model: this.embeddingProvider.metadata.model,
          dimensions: collectionInfo.dimensions,
        },
        {
          provider: this.embeddingProvider.metadata.provider,
          model: this.embeddingProvider.metadata.model,
          dimensions: this.embeddingProvider.metadata.dimensions,
        },
      );
    }

    const [{ vector }] = await withRetry(
      () => this.embedQueryWithTimeout(text),
      {
        maxAttempts: this.config.maxRetries,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        isRetryable: (err) => err instanceof TransientEmbeddingProviderError,
      },
    );

    const expandToParent = query.expandToParent ?? this.config.expandToParent;

    const matches = await this.store.search({
      collection,
      vector,
      topK,
      scoreThreshold: query.scoreThreshold ?? this.config.scoreThreshold,
      filter: {
        domain: query.domain,
        ...(query.filter?.documentId !== undefined
          ? { documentId: query.filter.documentId }
          : {}),
        ...(query.filter?.sourcePath !== undefined
          ? { sourcePath: query.filter.sourcePath }
          : {}),
      },
    });

    const results: RetrievalResult[] = matches.map((match) => ({
      chunkId: match.payload.chunkId,
      documentId: match.payload.documentId,
      parentChunkId: match.payload.parentChunkId,
      chunkType: match.payload.chunkType,
      score: match.score,
      text: match.payload.text,
      parentText: expandToParent ? match.payload.parentText : null,
      headingPath: match.payload.headingPath,
      documentTitle: match.payload.documentTitle,
      sourcePath: match.payload.sourcePath,
      domain: match.payload.domain,
    }));

    this.logger.info(
      {
        domain: query.domain,
        collection,
        topK,
        resultCount: results.length,
        highestScore: results[0]?.score ?? null,
        provider: this.embeddingProvider.metadata.provider,
        model: this.embeddingProvider.metadata.model,
        durationMs: Date.now() - startedAt,
      },
      'Retrieval query executed',
    );

    return results;
  }

  private embedQueryWithTimeout(
    text: string,
  ): Promise<Array<{ id: string; vector: number[] }>> {
    let timeoutHandle!: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(
          new TransientEmbeddingProviderError(
            `Query embedding timed out after ${this.config.requestTimeoutMs}ms`,
          ),
        );
      }, this.config.requestTimeoutMs);
    });

    return Promise.race([
      this.embeddingProvider.embed([{ id: 'query', text }]),
      timeoutPromise,
    ]).finally(() => clearTimeout(timeoutHandle));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/retrieval/retrieval.service.spec.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Run build and lint**

Run: `pnpm build && pnpm lint`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/retrieval/retrieval.service.ts src/retrieval/retrieval.service.spec.ts
git commit -m "feat(retrieval): add RetrievalService with query embedding, search, and parent expansion"
```

---

### Task 13: `RetrievalModule` DI wiring

**Files:**

- Create: `src/retrieval/retrieval.module.ts`
- Create: `src/retrieval/retrieval.module.spec.ts`

**Interfaces:**

- Consumes: `EmbeddingModule` (exports `EMBEDDING_PROVIDER_PORT` — confirm this export exists; if `EmbeddingModule` does not currently export the port token, add `EMBEDDING_PROVIDER_PORT` to its `exports` array as part of this task, since only `EmbeddingPipelineService` is exported today), `VectorStoreModule` (Task 9, already exports `VECTOR_STORE_PORT`).
- Produces: `RetrievalModule` exporting `RetrievalService` — consumed by Task 14.

- [ ] **Step 1: Confirm and, if needed, fix `EmbeddingModule`'s exports**

Read `src/embedding/embedding.module.ts` (shown in Task 1/context above: `exports: [EmbeddingPipelineService]`). `EMBEDDING_PROVIDER_PORT` is **not** currently exported. Modify `src/embedding/embedding.module.ts`'s `exports` array:

```typescript
  exports: [EmbeddingPipelineService, EMBEDDING_PROVIDER_PORT],
```

- [ ] **Step 2: Write the failing test**

```typescript
// src/retrieval/retrieval.module.spec.ts
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from '../config/env.validation';
import { EmbeddingModule } from '../embedding/embedding.module';
import { VectorStoreModule } from '../vector-store/vector-store.module';
import { RetrievalModule } from './retrieval.module';
import { RetrievalService } from './retrieval.service';

describe('RetrievalModule', () => {
  it('resolves RetrievalService with its EmbeddingModule and VectorStoreModule dependencies', async () => {
    const original = { ...process.env };
    Object.assign(process.env, {
      EMBEDDING_PROVIDER: 'fake',
      VECTOR_STORE_PROVIDER: 'fake',
    });
    try {
      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
          LoggerModule.forRoot(),
          EmbeddingModule,
          VectorStoreModule,
          RetrievalModule,
        ],
      }).compile();

      expect(moduleRef.get(RetrievalService)).toBeInstanceOf(RetrievalService);
    } finally {
      process.env = original;
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test src/retrieval/retrieval.module.spec.ts`
Expected: FAIL — `Cannot find module './retrieval.module'`

- [ ] **Step 4: Implement `RetrievalModule`**

```typescript
// src/retrieval/retrieval.module.ts
import { Module } from '@nestjs/common';
import { RetrievalConfigService } from './retrieval-config.service';
import { RetrievalService } from './retrieval.service';

@Module({
  providers: [RetrievalConfigService, RetrievalService],
  exports: [RetrievalService],
})
export class RetrievalModule {}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test src/retrieval/retrieval.module.spec.ts`
Expected: PASS (1 test)

- [ ] **Step 6: Run the full embedding suite to confirm the export change is safe**

Run: `pnpm test src/embedding`
Expected: PASS, unchanged count (adding an export never breaks an existing consumer)

- [ ] **Step 7: Run build and lint**

Run: `pnpm build && pnpm lint`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add src/embedding/embedding.module.ts src/retrieval/retrieval.module.ts src/retrieval/retrieval.module.spec.ts
git commit -m "feat(retrieval): add RetrievalModule and export EMBEDDING_PROVIDER_PORT from EmbeddingModule"
```

---

### Task 14: `pnpm query` CLI

**Files:**

- Create: `src/cli/query.ts`
- Modify: `package.json` (add `"query": "node dist/cli/query.js"` script)

**Interfaces:**

- Consumes: `RetrievalService.retrieve` (Task 12/13); `VectorStoreConfigService`, `deriveCollectionName` (Task 3, Task 10); `EmbeddingConfigService` (existing).

- [ ] **Step 1: Create the CLI module**

```typescript
// src/cli/query.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger, LoggerModule } from 'nestjs-pino';
import { AppConfigService } from '../config/app-config.service';
import { validateEnv } from '../config/env.validation';
import { buildPinoHttpOptions } from '../config/pino-http-options.factory';
import { EmbeddingConfigService } from '../embedding/embedding-config.service';
import { EmbeddingModule } from '../embedding/embedding.module';
import { VectorStoreModule } from '../vector-store/vector-store.module';
import { VectorStoreConfigService } from '../vector-store/vector-store-config.service';
import { deriveCollectionName } from '../vector-store/vector-store-collection-name.util';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { RetrievalService } from '../retrieval/retrieval.service';

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
    VectorStoreModule,
    RetrievalModule,
  ],
  providers: [AppConfigService],
})
class QueryCliModule {}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const text = args.join(' ').trim();

  if (!text) {
    console.error('Usage: pnpm query "<question>"');
    process.exitCode = 1;
    return;
  }

  const app = await NestFactory.createApplicationContext(QueryCliModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  const retrieval = app.get(RetrievalService);
  const vectorStoreConfig = app.get(VectorStoreConfigService);
  const embeddingConfig = app.get(EmbeddingConfigService);

  const collection = deriveCollectionName({
    domain: vectorStoreConfig.domain,
    provider: embeddingConfig.provider,
    model: embeddingConfig.model,
    dimensions: embeddingConfig.dimensions,
    modelVersion: embeddingConfig.modelVersion,
  });

  try {
    const results = await retrieval.retrieve(
      { text, domain: vectorStoreConfig.domain },
      collection,
    );

    console.log(`\n=== Retrieval Results (collection: ${collection}) ===`);
    console.log(JSON.stringify(results, null, 2));
    console.log(`\n${results.length} result(s) returned.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nQuery failed: ${message}`);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main();
```

- [ ] **Step 2: Add the `pnpm query` script**

In `package.json`'s `"scripts"` block, add immediately after the `"index"` line added in Task 10:

```json
    "query": "node dist/cli/query.js",
```

- [ ] **Step 3: Manual verification against the fake provider**

Run:

```bash
pnpm build
EMBEDDING_PROVIDER=fake VECTOR_STORE_PROVIDER=fake node dist/cli/index.js && \
EMBEDDING_PROVIDER=fake VECTOR_STORE_PROVIDER=fake node dist/cli/query.js "How do I install Docker?"
```

Note: since `VECTOR_STORE_PROVIDER=fake` creates a fresh in-memory `FakeVectorStoreAdapter` per process, indexing and querying must happen against the **same running process** for this to return anything — for a real manual check, use `VECTOR_STORE_PROVIDER=qdrant` against a local Qdrant instance (available starting Task 15), or accept that this fake+fake combination alone will legitimately return zero results across two separate CLI invocations. This is expected, not a bug — record it as-is.

- [ ] **Step 4: Run build and lint**

Run: `pnpm build && pnpm lint`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/cli/query.ts package.json
git commit -m "feat(cli): add pnpm query CLI for retrieval"
```

---

### Task 15: `docker-compose.yml` and local-development documentation

**Files:**

- Create: `docker-compose.yml`
- Create: `docs/architecture/vector-store-local-dev.md`

**Interfaces:** None (infrastructure + docs only).

- [ ] **Step 1: Create the Compose file**

```yaml
# docker-compose.yml
services:
  qdrant:
    image: qdrant/qdrant:v1.19.0
    ports:
      - '6333:6333'
      - '6334:6334'
    volumes:
      - qdrant_storage:/qdrant/storage
volumes:
  qdrant_storage:
```

- [ ] **Step 2: Write the local-dev runbook**

```markdown
# Vector Store Local Development

Reproducible steps to run Qdrant locally, index the current corpus, and run a retrieval query. See `docs/architecture/vector-storage-retrieval-design.md` §20 for the full design rationale.

## 1. Start the vector database

    docker compose up -d qdrant

Verify it's up: `curl http://localhost:6333/collections` should return `{"result":{"collections":[]},"status":"ok",...}`.

## 2. Index embeddings

    pnpm build
    pnpm index ./data/embedding-output/embeddings.jsonl ./data/chunks-output

This creates the collection (if absent, named per `docs/architecture/vector-storage-retrieval-design.md` §9) and upserts every eligible record. Re-running is safe — upserts are idempotent by `embeddingId`-derived point ID.

## 3. Execute a retrieval query

    pnpm query "How do I install Docker on Ubuntu?"

Prints ranked `RetrievalResult[]` as JSON, including each match's own text and its resolved parent section's text.

## 4. Inspect results directly

- Qdrant's bundled dashboard: http://localhost:6333/dashboard
- Raw REST: `curl http://localhost:6333/collections/<collection-name>`

## 5. Reset the local store

    docker compose down -v

Drops the named volume entirely — the next `docker compose up -d qdrant` starts from empty. Re-run step 2 to repopulate.

## Notes

- `VECTOR_STORE_PROVIDER=fake` runs entirely in-memory, per-process — useful for automated tests, not for the workflow above (each CLI invocation gets its own empty store).
- No authentication or TLS is configured — correct for local development only. See the design doc §24 for the production posture this must not be mistaken for.
```

- [ ] **Step 3: Manual verification**

Run `docker compose up -d qdrant`, then `curl http://localhost:6333/collections`, confirm a 200 response with an empty collection list. Run `docker compose down -v` to clean up.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml docs/architecture/vector-store-local-dev.md
git commit -m "docs(vector-store): add local Qdrant Docker Compose setup and dev runbook"
```

---

### Task 16: Integration test suite against a real Qdrant instance

**Files:**

- Create: `test/jest-integration.json`
- Create: `test/vector-store.integration-spec.ts`
- Modify: `package.json` (add `"test:integration": "jest --config ./test/jest-integration.json"` script)

**Interfaces:**

- Consumes: `QdrantVectorStoreAdapter` (Task 8) directly, against a real, locally-running Qdrant instance (Task 15's `docker-compose.yml`).

- [ ] **Step 1: Create the integration Jest config, mirroring `test/jest-e2e.json`'s shape**

```json
{
  "moduleFileExtensions": ["js", "json", "ts"],
  "rootDir": "..",
  "testEnvironment": "node",
  "testRegex": "test/.*\\.integration-spec\\.ts$",
  "transform": {
    "^.+\\.(t|j)s$": "ts-jest"
  }
}
```

- [ ] **Step 2: Add the `test:integration` script**

In `package.json`'s `"scripts"` block, add immediately after `"test:e2e": "jest --config ./test/jest-e2e.json"`:

```json
    "test:integration": "jest --config ./test/jest-integration.json"
```

- [ ] **Step 3: Write the integration test suite**

```typescript
// test/vector-store.integration-spec.ts
//
// Requires a real, running Qdrant instance: `docker compose up -d qdrant`
// (see docker-compose.yml and docs/architecture/vector-store-local-dev.md).
// This suite is intentionally excluded from `pnpm test`/`pnpm test:e2e` —
// run it explicitly via `pnpm test:integration`.
import { randomUUID } from 'node:crypto';
import { QdrantVectorStoreAdapter } from '../src/vector-store/providers/qdrant-vector-store.adapter';
import { VectorPoint } from '../src/vector-store/vector-store.types';

const QDRANT_URL = process.env.VECTOR_STORE_URL ?? 'http://localhost:6333';

function buildPoint(overrides: Partial<VectorPoint> = {}): VectorPoint {
  return {
    id: randomUUID(),
    vector: [1, 0, 0, 0],
    payload: {
      chunkId: 'chunk1',
      documentId: 'doc1',
      parentChunkId: null,
      chunkType: 'child',
      contentHash: 'hash1',
      headingPath: 'Install',
      documentTitle: 'Install Docker',
      sourcePath: 'install.md',
      domain: 'docker',
      text: 'text',
      parentText: null,
      provider: 'fake',
      model: 'fake-model',
      modelVersion: '1',
      dimensions: 4,
      embeddingId: 'emb1',
      indexedAt: new Date(0).toISOString(),
    },
    ...overrides,
  };
}

describe('QdrantVectorStoreAdapter (integration)', () => {
  const adapter = new QdrantVectorStoreAdapter(QDRANT_URL, '');
  const collection = `it_test_${randomUUID().replace(/-/g, '_')}`;

  beforeAll(async () => {
    await adapter.ensureCollection(collection, 4);
  }, 15000);

  afterAll(async () => {
    await fetch(`${QDRANT_URL}/collections/${collection}`, {
      method: 'DELETE',
    });
  });

  it('ensureCollection is idempotent', async () => {
    await expect(
      adapter.ensureCollection(collection, 4),
    ).resolves.toBeUndefined();
  });

  it('reports collection info after creation', async () => {
    const info = await adapter.collectionInfo(collection);
    expect(info).toEqual({ dimensions: 4, pointCount: 0 });
  });

  it('upserts a point and reflects it in collectionInfo', async () => {
    await adapter.upsert(collection, [buildPoint({ id: randomUUID() })]);
    const info = await adapter.collectionInfo(collection);
    expect(info!.pointCount).toBeGreaterThanOrEqual(1);
  });

  it('upserting the same point id twice results in exactly one point', async () => {
    const id = randomUUID();
    await adapter.upsert(collection, [
      buildPoint({ id, vector: [1, 0, 0, 0] }),
    ]);
    const before = (await adapter.collectionInfo(collection))!.pointCount;
    await adapter.upsert(collection, [
      buildPoint({ id, vector: [0, 1, 0, 0] }),
    ]);
    const after = (await adapter.collectionInfo(collection))!.pointCount;
    expect(after).toBe(before);
  });

  it('search ranks a near-identical vector above a far-apart one', async () => {
    const near = randomUUID();
    const far = randomUUID();
    await adapter.upsert(collection, [
      buildPoint({
        id: near,
        vector: [1, 0, 0, 0],
        payload: { ...buildPoint().payload, documentId: 'search-doc' },
      }),
      buildPoint({
        id: far,
        vector: [0, 0, 0, 1],
        payload: { ...buildPoint().payload, documentId: 'search-doc' },
      }),
    ]);

    const matches = await adapter.search({
      collection,
      vector: [1, 0, 0, 0],
      topK: 2,
      filter: { documentId: 'search-doc' },
    });

    expect(matches[0]!.id).toBe(near);
  });

  it('deleteByFilter removes matching points and reports the count', async () => {
    const id = randomUUID();
    await adapter.upsert(collection, [
      buildPoint({
        id,
        payload: { ...buildPoint().payload, documentId: 'delete-doc' },
      }),
    ]);

    const deleted = await adapter.deleteByFilter(collection, {
      documentId: 'delete-doc',
    });

    expect(deleted).toBeGreaterThanOrEqual(1);
  });

  it('fails fast with a clear error when pointed at a non-existent host', async () => {
    const badAdapter = new QdrantVectorStoreAdapter('http://localhost:1', '');
    await expect(badAdapter.collectionInfo('anything')).rejects.toThrow();
  });
});
```

- [ ] **Step 4: Start Qdrant and run the suite**

Run:

```bash
docker compose up -d qdrant
pnpm test:integration
```

Expected: PASS (7 tests). If Qdrant is not running, expect a clear connection-refused-style failure rather than a long timeout — confirm this is the case before considering the task done.

- [ ] **Step 5: Stop Qdrant**

Run: `docker compose down -v`

- [ ] **Step 6: Run the full non-integration suite once more to confirm no cross-contamination**

Run: `pnpm test`
Expected: PASS, same as before this task (the new integration spec file's `.integration-spec.ts` extension is not matched by the main `testRegex: ".*\\.spec\\.ts$"`, so it does not run as part of `pnpm test`)

- [ ] **Step 7: Commit**

```bash
git add test/jest-integration.json test/vector-store.integration-spec.ts package.json
git commit -m "test(vector-store): add integration suite against a real Qdrant instance"
```

---

### Task 17: Real-Docker retrieval smoke-test runbook and human-supervised execution

**Files:**

- Create: `docs/architecture/vector-retrieval-smoke-test-runbook.md`

**Interfaces:** None — this is a documentation-and-manual-execution task, mirroring the two-part structure of `docs/architecture/google-embedding-smoke-test-runbook.md` (build everything against fakes/mocks first — already done in Tasks 1–16 — then one final human-supervised run against real data).

- [ ] **Step 1: Write the runbook**

```markdown
# Vector Retrieval Smoke Test Runbook (M4)

Human-supervised, not autonomous — this executes real commands against a real local Qdrant instance and the project's 90 real Google-embedded chunks (`data/embedding-output-google-smoke-test/embeddings.jsonl`, gitignored, produced by the M3.1 smoke test). No new API calls are made — this step is entirely local (Qdrant + already-computed real vectors).

## Prerequisites

- `docker compose up -d qdrant` (see `docs/architecture/vector-store-local-dev.md`)
- `pnpm build`
- The real Google embeddings and their source chunks must both be present locally:
  - `data/embedding-output-google-smoke-test/embeddings.jsonl` (90 real records, from M3.1)
  - `data/chunks-output/` (regenerate via `pnpm ingest && pnpm chunk` if not already present — chunk output is gitignored scratch data, per the M4 spec)

## Step 1: Index the real embeddings

    EMBEDDING_PROVIDER=google EMBEDDING_MODEL=gemini-embedding-2 EMBEDDING_DIMENSIONS=768 \
      pnpm index ./data/embedding-output-google-smoke-test/embeddings.jsonl ./data/chunks-output

Expected: `attempted` equals the number of the 90 records whose `chunkId` has a matching chunk file locally (some may be `skippedByProvenanceMismatch` if `data/chunks-output` was regenerated and produced different `contentHash`/`chunkId` values than the original M3.1 run — record the actual attempted/succeeded counts, don't assume exactly 90).

## Step 2: Run each benchmark query and record the outcome

For each question below, run:

    EMBEDDING_PROVIDER=google EMBEDDING_MODEL=gemini-embedding-2 EMBEDDING_DIMENSIONS=768 \
      pnpm query "<question>"

and record, in the table below: the top result's `documentId`/`sourcePath`/`headingPath`, its score, and a human judgment of whether it actually addresses the question.

| #   | Question                                           | Top result source | Score | Addresses the question? | Notes |
| --- | -------------------------------------------------- | ----------------- | ----- | ----------------------- | ----- |
| 1   | What is the difference between CMD and ENTRYPOINT? |                   |       |                         |       |
| 2   | How do Docker volumes differ from bind mounts?     |                   |       |                         |       |
| 3   | How does bridge networking work?                   |                   |       |                         |       |
| 4   | What does `COPY --from` do?                        |                   |       |                         |       |
| 5   | How does Docker Compose healthcheck work?          |                   |       |                         |       |
| 6   | What is the difference between ARG and ENV?        |                   |       |                         |       |

## Step 3: Record findings

Fill in the table above with real output — this is the actual deliverable of this task, not merely "the commands ran without error." A successful vector search with plausible-looking scores is not evidence of retrieval quality; only checking whether the right content actually surfaces is. This is the documented "before" baseline M5's hybrid-retrieval and reranking work will be measured against.

## Step 4: Tear down

    docker compose down -v
```

- [ ] **Step 2: Execute the runbook, human-supervised**

Run through Steps 1–3 of the runbook above against the real local Qdrant instance and the real 90-chunk Google embedding set. This step requires a human to actually judge each query's relevance — it cannot be automated or skipped. Fill in the table in the runbook file itself with the real results.

- [ ] **Step 3: Commit the completed runbook**

```bash
git add docs/architecture/vector-retrieval-smoke-test-runbook.md
git commit -m "docs(vector-store): record real-Docker retrieval smoke-test results"
```

---

## Definition of Done

See `docs/architecture/vector-storage-retrieval-design.md` §29 for the full checklist. In short: all 17 tasks committed and independently reviewed; `pnpm build`/`pnpm lint`/`pnpm test` clean; `pnpm test:integration` passes against real Qdrant; `pnpm index`/`pnpm query` both work end-to-end against the real corpus; the retrieval smoke-test runbook has been executed and its findings recorded; no Postgres/second database/out-of-scope retrieval feature was introduced.

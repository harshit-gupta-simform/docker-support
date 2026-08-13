# Google Embedding Provider — Real-Vector Smoke Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Task 6 is a HUMAN-SUPERVISED MANUAL PROCEDURE, not an autonomous coding task.** It spends the user's real, quota-limited Google API credits. No subagent, workflow, or automated loop may execute Task 6's commands on its own initiative — a human runs them, watches the output, and can interrupt. Tasks 1–5 are ordinary TDD coding tasks against mocks/fakes only and involve zero real API calls, with one narrow exception called out explicitly in Task 3 Step 1 (a single, tiny, human-run verification request).

**Goal:** Add a `google` embedding provider (Gemini API's `gemini-embedding-001`) behind the existing `EmbeddingProviderPort` abstraction, plus a reusable, tested, hard chunk-count cap on the embedding pipeline — then use both together to run a real, quota-safe, human-supervised smoke test against **exactly 100** real chunks, proving M3's existing infrastructure produces correct, genuine semantic embeddings end-to-end with a real provider before M4 begins. No M4 work (vector storage, retrieval, generation) is in scope.

**Architecture:** `GoogleEmbeddingProviderAdapter` is a fourth `EmbeddingProviderPort` implementation, structurally identical to the existing `VoyageEmbeddingProviderAdapter`/`OpenAiEmbeddingProviderAdapter` (native `fetch`, no new HTTP client dependency, same error taxonomy, same retry/timeout/validation path) — only its request/response wire shape and auth header differ, and that difference stays entirely inside the one new adapter file. A new, provider-agnostic `EMBEDDING_MAX_CHUNKS_PER_RUN` config value adds a hard ceiling to `EmbeddingPipelineService.run()`, enforced by slicing the eligible-input list before batching — this is the single, reusable, always-on mechanism that makes "never send more than 100 chunks" a property of the code rather than an operator's discipline.

**Tech Stack:** Node 22 native `fetch`/`AbortController` (matches the existing Voyage/OpenAI adapters — no `@google/genai` SDK dependency added, for the reasons in Global Constraints). Gemini API `v1beta` REST surface, model `gemini-embedding-001`, endpoint `batchEmbedContents`, current (non-deprecated) request schema confirmed against `https://ai.google.dev/api/rest/v1beta/models/embedContent` on 2026-08-13.

**Spec:** This plan's user-provided spec required inspecting the following before any change (all read, none modified, during plan authoring): `src/embedding/embedding-provider.port.ts`, `src/embedding/providers/voyage-embedding-provider.adapter.ts`, `src/embedding/providers/openai-embedding-provider.adapter.ts`, `src/embedding/providers/fake-embedding-provider.ts`, `src/embedding/embedding-pipeline.service.ts`, `src/embedding/embedding-batch-processor.service.ts`, `src/embedding/embedding-config.service.ts`, `src/config/env.validation.ts`, `src/cli/embed.ts`, `src/embedding/embedding.types.ts`, `src/embedding/embedding-output-store.service.ts`, existing adapter tests, and `docs/architecture/embedding-infrastructure-design.md`. No project-level `CLAUDE.md` exists (confirmed absent on disk, same as noted in the M3 design doc).

## Global Constraints

- TypeScript strict mode project-wide (`strict`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`) — all new code must compile under it. `pnpm build` (real `tsc` via `nest build`) must be run and confirmed clean for every task — `pnpm test`'s `ts-jest` does **not** fully type-check (this bit the M3 plan once already: a `noUncheckedIndexedAccess` violation shipped past every test run and was only caught by `pnpm build` days later).
- ESLint (`eslint.config.mjs`): `@typescript-eslint/no-explicit-any: error`, `@typescript-eslint/no-floating-promises: error`, `@typescript-eslint/no-unsafe-argument: error`, `tseslint.configs.recommendedTypeChecked`.
- Jest coverage threshold is 80% branches/functions/lines/statements globally (`package.json`'s `jest.coverageThreshold`).
- **No new runtime HTTP-client dependency.** `VoyageEmbeddingProviderAdapter`/`OpenAiEmbeddingProviderAdapter` both use Node 22's native `fetch` directly against the provider's REST endpoint — no SDK. This plan follows the same pattern for Google **deliberately, not by default**: the official `@google/genai` SDK (npm, v2.16.0 as of 2026-08-13) exists and is what Google itself recommends, but (a) its request/response objects aren't `global.fetch`-mockable the way this codebase's entire adapter test suite already assumes (every existing adapter spec does `jest.spyOn(global, 'fetch')`), and (b) confirmed AbortSignal-forwarding support for `embedContent` isn't documented. Native `fetch` keeps this adapter's tests identical in shape to the two that already exist, guarantees the shared `EmbeddingBatchProcessorService`'s cancel-on-timeout path actually works, and costs zero new dependencies. If this decision needs revisiting later, it's contained to one file.
- **Reuse, never duplicate, the existing provider contract.** `EMBEDDING_PROVIDER_PORT`, `EmbeddingProviderRequestItem`/`EmbeddingProviderResponseItem`, `withRetry`, `validateProviderResponse`, `EmbeddingBatchProcessorService`, `EmbeddingPipelineService`, `EmbeddingOutputStoreService`, the `pnpm embed` CLI, and the `EmbeddingRecord` JSONL format are **not modified in shape** by this plan (one additive field, `skippedByMaxChunksCap`, is added to `EmbeddingRunResult` — see Task 1 — everything else is untouched). `Voyage`/`OpenAI`/`Fake` providers are not removed or altered.
- **Secrets:** the Google API key must never appear in a log call, a thrown error's `.message`, or any generated/output file — identical rule to the existing `EMBEDDING_API_KEY` convention, enforced the same way (a dedicated "never leaks the key" test per adapter, matching the existing Voyage/OpenAI tests).
- **Config:** one shared `EMBEDDING_API_KEY` field is reused for Google — **not** a new `GOOGLE_AI_API_KEY` variable. This is a deliberate reading of "the exact naming must follow the existing configuration architecture": the existing architecture already made `EMBEDDING_API_KEY` provider-agnostic on purpose (Voyage and OpenAI already share it), and `EmbeddingConfigService`/`createEmbeddingProvider`'s factory pattern has no per-provider key branching today. Introducing a second, differently-named key field would be the actual architectural inconsistency. All env vars are added to the single zod schema in `src/config/env.validation.ts`, wrapped by `EmbeddingConfigService`'s typed getters — never read `process.env` directly, no second config system.
- **`.env.example` cannot be edited by the assistant** — the user's global `~/.claude/settings.json` denies `Read`/`Write`/`Edit` on any `.env*` path. This plan adds exactly one new line beyond what M3 already left pending (`EMBEDDING_MAX_CHUNKS_PER_RUN=0` — no new key is needed for the Google API key itself, since it reuses `EMBEDDING_API_KEY`, and no new key is needed to select the provider, since it reuses `EMBEDDING_PROVIDER`). Task 2 prints this line for the user to add by hand; until then, `src/config/env-example.spec.ts` fails — already true today for unrelated pre-existing reasons, not a regression this plan introduces or must fix.
- **The 100-chunk hard limit is enforced in code, not by operator discipline.** `EMBEDDING_MAX_CHUNKS_PER_RUN` (Task 1) is checked and applied unconditionally inside `EmbeddingPipelineService.run()` itself — setting it to `100` makes it structurally impossible for a single `pipeline.run()` call to attempt more than 100 embeddings, regardless of how large the chunks directory is, regardless of retries (each retry is _within_ an already-capped batch, never adds new chunks), and regardless of resumability (a second identical run costs **zero** additional API calls, because the same 100 `embeddingId`s are already in the output file — this is an existing, already-tested property of `EmbeddingOutputStoreService`, not new code). The `pnpm embed` CLI runs once and exits; nothing in this plan introduces a loop, a watch mode, or an automatic retry-the-whole-run wrapper.
- **`gemini-embedding-001`'s real model limits, confirmed against official docs on 2026-08-13:** default output dimensionality 3072, with 3072/1536/768 as Google's explicitly-recommended Matryoshka checkpoints (arbitrary intermediate values are accepted by the API but not "recommended"); **maximum input of 2048 tokens per text** — notably _below_ this project's existing `EMBEDDING_INPUT_MAX_TOKENS` default of `8000` (safe today only because M2's `CHUNKING_MAX_CHUNK_SIZE` already bounds individual `'child'`-type chunks well under 2048 approx-tokens in practice; Task 5's runbook sets `EMBEDDING_INPUT_MAX_TOKENS=2000` explicitly for the smoke-test run as a documented, deliberate safety margin under Google's real ceiling, not a magic number). Free-tier RPM/TPM/RPD figures for the embedding model specifically are not published in static docs as of 2026-08-13 (Google's rate-limits page directs to a per-account dashboard at `https://aistudio.google.com/rate-limit`); Task 5's chosen batch size/concurrency are conservative enough to stay safe under any plausible current tier without needing that exact number. A separate, unrelated Google feature — the asynchronous **Batch API** (job-based bulk submission, with its own much larger token quotas by paid tier) — is explicitly **not** used here; this plan only uses the synchronous `batchEmbedContents` REST call (multiple texts in one ordinary HTTP request), and the two must not be confused when reading Google's docs.
- **Structured logging:** neither `VoyageEmbeddingProviderAdapter` nor `OpenAiEmbeddingProviderAdapter` injects `PinoLogger` — both are plain classes (not NestJS injectables), and all structured logging around a provider call happens one layer up, in the already-built, unmodified `EmbeddingBatchProcessorService`/`EmbeddingPipelineService`. `GoogleEmbeddingProviderAdapter` follows this exact precedent (Task 3) — it has no logger of its own, which is consistent with existing convention, not a gap.
- Commit after each task, following this repo's Conventional Commits history (`feat:`, `test:`, `docs:`, etc.).
- Model/API reference: `docs.google.dev` pages fetched and cross-checked on 2026-08-13 — see Task 3 Step 1 for the one point that documentation alone could not fully resolve and that requires a live check.

---

### Task 1: `EMBEDDING_MAX_CHUNKS_PER_RUN` hard cap in the pipeline

**Files:**

- Modify: `src/config/env.validation.ts`
- Modify: `src/embedding/embedding-config.service.ts`
- Modify: `src/embedding/embedding.types.ts`
- Modify: `src/embedding/embedding-pipeline.service.ts`
- Modify: `src/embedding/embedding-pipeline.service.spec.ts`
- Test: `src/embedding/embedding-config.service.spec.ts` (extend)
- Test: `src/config/env.validation.spec.ts` (extend)

**Interfaces:**

- Consumes: nothing new — this is a pure extension of existing config plumbing and `EmbeddingPipelineService.run()`.
- Produces: `EmbeddingConfigService.maxChunksPerRun: number` (getter); `EmbeddingRunResult.skippedByMaxChunksCap: number` (new field); the accounting invariant becomes `totalChunksScanned === skippedByType + skippedEmpty + alreadyEmbedded + skippedByMaxChunksCap + attempted`.

This task is fully independent of Google — it's a provider-agnostic safety feature any provider can use for a bounded run.

- [ ] **Step 1: Write the failing config test**

Add to `src/embedding/embedding-config.service.spec.ts` (inside the existing `buildModule` defaults object and the existing `it('exposes every embedding config value via typed getters', ...)` test):

```typescript
// Add to the `defaults` object in buildModule():
EMBEDDING_MAX_CHUNKS_PER_RUN: (0,
  // Add to the existing 'exposes every embedding config value' test body:
  expect(config.maxChunksPerRun).toBe(0));
```

Also add a new test in the same file:

```typescript
it('reflects an overridden EMBEDDING_MAX_CHUNKS_PER_RUN', async () => {
  const moduleRef = await buildModule({ EMBEDDING_MAX_CHUNKS_PER_RUN: 100 });
  const config = moduleRef.get(EmbeddingConfigService);

  expect(config.maxChunksPerRun).toBe(100);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- embedding-config.service.spec.ts`
Expected: FAIL — `config.maxChunksPerRun is not a function` (getter doesn't exist yet) and the schema doesn't recognize `EMBEDDING_MAX_CHUNKS_PER_RUN`.

- [ ] **Step 3: Extend the env schema**

Modify `src/config/env.validation.ts` — add this field inside the `z.object({ ... })`, immediately after `EMBEDDING_FAILURE_THRESHOLD` (before the closing `})`):

```typescript
    EMBEDDING_MAX_CHUNKS_PER_RUN: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(0),
```

`0` means "no cap" (the existing, unbounded behavior) — a positive integer means "never attempt more than N chunks in a single `run()` call." No new `.refine()` is needed; this field has no cross-field relationship to validate.

- [ ] **Step 4: Add the `EmbeddingConfigService` getter**

Modify `src/embedding/embedding-config.service.ts` — add after the `failureThreshold` getter:

```typescript

  get maxChunksPerRun(): number {
    return this.configService.get('EMBEDDING_MAX_CHUNKS_PER_RUN', {
      infer: true,
    });
  }
```

- [ ] **Step 5: Run the config test to verify it passes**

Run: `pnpm test -- embedding-config.service.spec.ts`
Expected: PASS, all tests including the two new ones.

- [ ] **Step 6: Extend the env-validation test's "fully specified" fixtures**

`src/config/env.validation.spec.ts` has fixture objects that list every schema key (used by both the "applies defaults" and "accepts a fully specified valid configuration" tests, per the same pattern the M3 plan already used for every prior `EMBEDDING_*` addition). Add `EMBEDDING_MAX_CHUNKS_PER_RUN: 0` to the defaults-expectation object and `EMBEDDING_MAX_CHUNKS_PER_RUN: '50'` (as a string, proving `z.coerce` works) to the fully-specified-input fixture, with `50` as the corresponding expected parsed value.

- [ ] **Step 7: Run the env-validation test to verify it passes**

Run: `pnpm test -- env.validation.spec.ts`
Expected: PASS.

- [ ] **Step 8: Add `skippedByMaxChunksCap` to `EmbeddingRunResult`**

Modify `src/embedding/embedding.types.ts` — add the new field to the `EmbeddingRunResult` interface, immediately after `alreadyEmbedded`:

```typescript
alreadyEmbedded: number;
skippedByMaxChunksCap: number;
```

- [ ] **Step 9: Write the failing pipeline tests**

Add to `src/embedding/embedding-pipeline.service.spec.ts`. First, add an explicit default to the file's existing `buildConfig()` helper (find its `return { batchSize: 10, ... } as EmbeddingConfigService;` object literal) so it matches every other field's pattern of an explicit default rather than relying on `undefined` coercing falsy in the new cap check:

```typescript
    failureThreshold: 0.5,
    maxChunksPerRun: 0,
    ...overrides,
```

Then update the existing accounting-invariant test to include the new field (find the test named `'satisfies the accounting invariant...'` and change its assertion):

```typescript
expect(result.totalChunksScanned).toBe(
  result.skippedByType +
    result.skippedEmpty +
    result.alreadyEmbedded +
    result.skippedByMaxChunksCap +
    result.attempted,
);
```

Then add three new tests (place them after the existing `'scans multiple chunk files across multiple documents'` test):

```typescript
it('does not cap the run when EMBEDDING_MAX_CHUNKS_PER_RUN is 0 (unlimited)', async () => {
  await writeFile(
    join(chunksDir, 'doc1.chunks.json'),
    JSON.stringify([
      buildChunk({ chunkId: 'child1' }),
      buildChunk({ chunkId: 'child2' }),
      buildChunk({ chunkId: 'child3' }),
    ]),
  );
  const provider = new FakeEmbeddingProvider(metadata);
  const pipeline = buildPipeline(provider, { maxChunksPerRun: 0 });

  const result = await pipeline.run(chunksDir);

  expect(result.attempted).toBe(3);
  expect(result.skippedByMaxChunksCap).toBe(0);
});

it('caps attempted chunks at EMBEDDING_MAX_CHUNKS_PER_RUN and reports the remainder as skippedByMaxChunksCap', async () => {
  await writeFile(
    join(chunksDir, 'doc1.chunks.json'),
    JSON.stringify([
      buildChunk({ chunkId: 'child1' }),
      buildChunk({ chunkId: 'child2' }),
      buildChunk({ chunkId: 'child3' }),
    ]),
  );
  const provider = new FakeEmbeddingProvider(metadata);
  const pipeline = buildPipeline(provider, { maxChunksPerRun: 2 });

  const result = await pipeline.run(chunksDir);

  expect(result.attempted).toBe(2);
  expect(result.succeeded).toBe(2);
  expect(result.skippedByMaxChunksCap).toBe(1);
  expect(result.totalChunksScanned).toBe(3);
});

it('never attempts more than the cap even across a resumed run', async () => {
  await writeFile(
    join(chunksDir, 'doc1.chunks.json'),
    JSON.stringify([
      buildChunk({ chunkId: 'child1' }),
      buildChunk({ chunkId: 'child2' }),
      buildChunk({ chunkId: 'child3' }),
    ]),
  );
  const provider = new FakeEmbeddingProvider(metadata);

  const firstResult = await buildPipeline(provider, {
    maxChunksPerRun: 2,
  }).run(chunksDir);
  expect(firstResult.attempted).toBe(2);

  const secondResult = await buildPipeline(provider, {
    maxChunksPerRun: 2,
  }).run(chunksDir);

  expect(secondResult.alreadyEmbedded).toBe(2);
  expect(secondResult.attempted).toBe(1);
  expect(secondResult.skippedByMaxChunksCap).toBe(0);
});
```

- [ ] **Step 10: Run the pipeline tests to verify they fail**

Run: `pnpm test -- embedding-pipeline.service.spec.ts`
Expected: FAIL — `skippedByMaxChunksCap` is `undefined` in the returned result (property doesn't exist on the object built by `run()` yet), so the new assertions and the updated invariant assertion both fail.

- [ ] **Step 11: Implement the cap in `EmbeddingPipelineService.run()`**

Modify `src/embedding/embedding-pipeline.service.ts`. Insert this block immediately after the `for (const file of files) { ... }` loop that builds `eligibleInputs`, and before the `const batches = batchEligibleInputs(...)` line:

```typescript
let skippedByMaxChunksCap = 0;
let cappedInputs = eligibleInputs;
if (
  this.config.maxChunksPerRun > 0 &&
  eligibleInputs.length > this.config.maxChunksPerRun
) {
  cappedInputs = eligibleInputs.slice(0, this.config.maxChunksPerRun);
  skippedByMaxChunksCap = eligibleInputs.length - cappedInputs.length;
  this.logger.warn(
    {
      jobId,
      maxChunksPerRun: this.config.maxChunksPerRun,
      eligibleCount: eligibleInputs.length,
      skippedByMaxChunksCap,
    },
    'Eligible chunk count exceeds EMBEDDING_MAX_CHUNKS_PER_RUN — truncating this run',
  );
}
```

Then change the batching line from `eligibleInputs` to `cappedInputs`:

```typescript
const batches = batchEligibleInputs(
  cappedInputs,
  this.config.batchSize,
  this.config.inputMaxTokens * BATCH_TOKEN_BUDGET_MULTIPLIER,
);
```

And change `const attempted = eligibleInputs.length;` to:

```typescript
const attempted = cappedInputs.length;
```

Finally, add `skippedByMaxChunksCap` to the `result` object literal, immediately after `alreadyEmbedded,`:

```typescript
      alreadyEmbedded,
      skippedByMaxChunksCap,
```

- [ ] **Step 12: Run the pipeline tests to verify they pass**

Run: `pnpm test -- embedding-pipeline.service.spec.ts`
Expected: PASS, all tests including the three new ones and the updated invariant.

- [ ] **Step 13: Run the full build to confirm no type errors**

Run: `pnpm build`
Expected: succeeds with zero errors. (`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` apply to every line touched above — `cappedInputs`/`skippedByMaxChunksCap` are plain locals with no indexing, so this should be clean, but confirm rather than assume.)

- [ ] **Step 14: Commit**

```bash
git add src/config/env.validation.ts src/config/env.validation.spec.ts src/embedding/embedding-config.service.ts src/embedding/embedding-config.service.spec.ts src/embedding/embedding.types.ts src/embedding/embedding-pipeline.service.ts src/embedding/embedding-pipeline.service.spec.ts
git commit -m "feat(embedding): add EMBEDDING_MAX_CHUNKS_PER_RUN hard cap on the pipeline"
```

---

### Task 2: Add `google` to `EMBEDDING_PROVIDER` and document the new config

**Files:**

- Modify: `src/config/env.validation.ts`
- Modify: `src/config/env.validation.spec.ts`
- Modify: `README.md`

**Interfaces:**

- Consumes: nothing new.
- Produces: `EnvConfig['EMBEDDING_PROVIDER']` now includes `'google'` as a valid value. No adapter is wired to it yet — that's Task 4. Until Task 4 lands, setting `EMBEDDING_PROVIDER=google` will pass validation but `EmbeddingModule`'s factory will fall through to the `OpenAiEmbeddingProviderAdapter` branch (the factory's `if (config.provider === 'voyage') {...} return new OpenAi...(...)` — everything not `'fake'`/`'voyage'` currently defaults to OpenAI). This is corrected in Task 4; flagging it here so a reviewer doesn't mistake the gap for an oversight.

- [ ] **Step 1: Write the failing test**

Add to `src/config/env.validation.spec.ts`, a new test near the other `EMBEDDING_PROVIDER`-related assertions:

```typescript
it('accepts google as a valid EMBEDDING_PROVIDER', () => {
  const result = validateEnv({ EMBEDDING_PROVIDER: 'google' });

  expect(result.EMBEDDING_PROVIDER).toBe('google');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- env.validation.spec.ts`
Expected: FAIL — zod rejects `'google'` as not in the enum, `validateEnv` throws.

- [ ] **Step 3: Extend the provider enum**

Modify `src/config/env.validation.ts` — change:

```typescript
    EMBEDDING_PROVIDER: z.enum(['voyage', 'openai', 'fake']).default('voyage'),
```

to:

```typescript
    EMBEDDING_PROVIDER: z
      .enum(['voyage', 'openai', 'google', 'fake'])
      .default('voyage'),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- env.validation.spec.ts`
Expected: PASS.

- [ ] **Step 5: Update the README's embedding config table**

Modify `README.md` — change the `EMBEDDING_PROVIDER` row's description from:

```
Embedding provider to use: `voyage`, `openai`, or `fake` (a deterministic stub for tests/dev).
```

to:

```
Embedding provider to use: `voyage`, `openai`, `google`, or `fake` (a deterministic stub for tests/dev).
```

Add a new row immediately after the `EMBEDDING_FAILURE_THRESHOLD` row (matching the existing table's exact column format: `| variable | default | description |`):

```
| `EMBEDDING_MAX_CHUNKS_PER_RUN`      | `0`                       | Hard cap on chunks attempted in a single run; `0` means unlimited. Use this to safely smoke-test a paid/quota-limited provider against a small, bounded number of real chunks. |
```

- [ ] **Step 6: Print the required `.env.example` addition (manual step, blocked by permissions)**

This assistant cannot edit `.env.example` in this session. Print this exact line for the user to append by hand (in addition to the 29 lines already pending from M1–M3, unrelated to this plan):

```
EMBEDDING_MAX_CHUNKS_PER_RUN=0
```

No new line is needed for the Google API key or for selecting the `google` provider — both reuse the existing `EMBEDDING_API_KEY` and `EMBEDDING_PROVIDER` lines already documented.

- [ ] **Step 7: Commit**

```bash
git add src/config/env.validation.ts src/config/env.validation.spec.ts README.md
git commit -m "feat(embedding): accept google as a valid EMBEDDING_PROVIDER value"
```

---

### Task 3: `GoogleEmbeddingProviderAdapter`

**Files:**

- Create: `src/embedding/providers/google-embedding-provider.adapter.ts`
- Test: `src/embedding/providers/google-embedding-provider.adapter.spec.ts`

**Interfaces:**

- Consumes: `EmbeddingProviderPort`, `EmbeddingProviderRequestItem`, `EmbeddingProviderResponseItem` (`../embedding-provider.port`); `PermanentEmbeddingProviderError`, `RateLimitEmbeddingProviderError`, `TransientEmbeddingProviderError` (`../embedding.errors`); `EmbeddingModelMetadata` (`../embedding.types`); `parseRetryAfterMs` (`./retry-after.util`, already built and tested in M3 — reused verbatim, not duplicated).
- Produces: `GoogleEmbeddingProviderAdapter` class implementing `EmbeddingProviderPort`, constructed as `(apiKey: string, metadata: EmbeddingModelMetadata, baseUrl?: string)` — identical constructor shape to `VoyageEmbeddingProviderAdapter`/`OpenAiEmbeddingProviderAdapter`.

- [ ] **Step 1: One live, human-run verification call — required before writing production code**

Documentation on Google's exact current wire format is more ambiguous than usual for this integration: the official REST reference (`https://ai.google.dev/api/rest/v1beta/models/embedContent`, fetched 2026-08-13) confirms `taskType`/`outputDimensionality` are **current** only when nested under an `embedContentConfig` object — the same fields as _top-level_ siblings of `content` are explicitly marked **deprecated** on that same page. A commonly-linked Google Cookbook REST notebook shows the deprecated top-level shape and additionally includes a `"model": "models/gemini-embedding-001"` field inside each individual item of a `batchEmbedContents` request's `requests` array — it is not certain from documentation alone whether that per-item `model` field is still required, optional, or ignored when the model is already specified in the URL path. Given the account this plan runs against has a hard, non-negotiable free-tier daily quota, do not guess: before writing `embed()`'s production body, the human operator (not an autonomous subagent) runs ONE real request — a single short text, e.g. `"test"` — directly with `curl` or `fetch` in a scratch script, using their real `GOOGLE`/Gemini API key, against:

```
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents
Header: x-goog-api-key: <the real key>
Header: Content-Type: application/json
Body:
{
  "requests": [
    {
      "content": { "parts": [{ "text": "test" }] },
      "embedContentConfig": { "taskType": "RETRIEVAL_DOCUMENT", "outputDimensionality": 768 }
    }
  ]
}
```

This single call costs a negligible fraction of any plausible free-tier quota (one short text, well under the 100-chunk budget this plan protects). Record the **exact** real response JSON (field names, whether `embeddings[0].values` has length 768, whether a per-item `model` field was required — retry once _without_ the per-item `model` field inside each `requests[]` entry only if the first call errors specifically about a missing/invalid model, not otherwise). Paste the confirmed real response shape into this task's implementation notes/commit message. If the request fails with an auth or model-name error, stop and resolve that before proceeding — do not iterate blindly against the live API to "figure out" the shape by trial and error; re-read the fetched documentation once more first.

**Do not skip this step and do not delegate it to an autonomous subagent** — it is the one place in Tasks 1–5 that touches the real network, and it is bounded to 1–2 total requests.

- [ ] **Step 2: Write the failing test**

```typescript
// src/embedding/providers/google-embedding-provider.adapter.spec.ts
import {
  PermanentEmbeddingProviderError,
  RateLimitEmbeddingProviderError,
  TransientEmbeddingProviderError,
} from '../embedding.errors';
import { GoogleEmbeddingProviderAdapter } from './google-embedding-provider.adapter';

const metadata = {
  provider: 'google',
  model: 'gemini-embedding-001',
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

describe('GoogleEmbeddingProviderAdapter', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends the expected request shape to the batchEmbedContents endpoint, authenticated via x-goog-api-key', async () => {
    const fetchSpy = mockFetchOnce({
      status: 200,
      body: { embeddings: [{ values: [0.1, 0.2, 0.3, 0.4] }] },
    });
    const adapter = new GoogleEmbeddingProviderAdapter('secret-key', metadata);

    const result = await adapter.embed([{ id: 'chunk1', text: 'hello' }]);

    expect(result).toEqual([{ id: 'chunk1', vector: [0.1, 0.2, 0.3, 0.4] }]);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents',
    );
    expect((init!.headers as Record<string, string>)['x-goog-api-key']).toBe(
      'secret-key',
    );
    expect(
      (init!.headers as Record<string, string>)['Authorization'],
    ).toBeUndefined();
    const body = JSON.parse(init!.body as string) as {
      requests: {
        content: { parts: { text: string }[] };
        embedContentConfig: { taskType: string; outputDimensionality: number };
      }[];
    };
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]!.content.parts[0]!.text).toBe('hello');
    expect(body.requests[0]!.embedContentConfig).toEqual({
      taskType: 'RETRIEVAL_DOCUMENT',
      outputDimensionality: 4,
    });
  });

  it('sends multiple items as multiple requests in one batchEmbedContents call, preserving order positionally', async () => {
    mockFetchOnce({
      status: 200,
      body: {
        embeddings: [{ values: [1, 1, 1, 1] }, { values: [2, 2, 2, 2] }],
      },
    });
    const adapter = new GoogleEmbeddingProviderAdapter('secret-key', metadata);

    const result = await adapter.embed([
      { id: 'a', text: 'first' },
      { id: 'b', text: 'second' },
    ]);

    expect(result).toEqual([
      { id: 'a', vector: [1, 1, 1, 1] },
      { id: 'b', vector: [2, 2, 2, 2] },
    ]);
  });

  it('honors a custom baseUrl, constructing the model path against it', async () => {
    const fetchSpy = mockFetchOnce({
      status: 200,
      body: { embeddings: [{ values: [0.1, 0.2, 0.3, 0.4] }] },
    });
    const adapter = new GoogleEmbeddingProviderAdapter(
      'secret-key',
      metadata,
      'http://localhost:8080/v1beta',
    );

    await adapter.embed([{ id: 'chunk1', text: 'hello' }]);

    expect(fetchSpy.mock.calls[0]![0]).toBe(
      'http://localhost:8080/v1beta/models/gemini-embedding-001:batchEmbedContents',
    );
  });

  it('maps a 401 response to PermanentEmbeddingProviderError', async () => {
    mockFetchOnce({
      status: 401,
      body: { error: { message: 'invalid api key' } },
    });
    const adapter = new GoogleEmbeddingProviderAdapter('bad-key', metadata);

    await expect(adapter.embed([{ id: 'a', text: 'x' }])).rejects.toThrow(
      PermanentEmbeddingProviderError,
    );
  });

  it('maps a 400 response to PermanentEmbeddingProviderError', async () => {
    mockFetchOnce({
      status: 400,
      body: { error: { message: 'invalid input' } },
    });
    const adapter = new GoogleEmbeddingProviderAdapter('secret-key', metadata);

    await expect(adapter.embed([{ id: 'a', text: 'x' }])).rejects.toThrow(
      PermanentEmbeddingProviderError,
    );
  });

  it('maps a 429 response to RateLimitEmbeddingProviderError, parsing Retry-After when present', async () => {
    mockFetchOnce({
      status: 429,
      body: { error: { message: 'rate limited' } },
      headers: { 'retry-after': '3' },
    });
    const adapter = new GoogleEmbeddingProviderAdapter('secret-key', metadata);

    try {
      await adapter.embed([{ id: 'a', text: 'x' }]);
      fail('expected embed() to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitEmbeddingProviderError);
      expect((err as RateLimitEmbeddingProviderError).retryAfterMs).toBe(3000);
    }
  });

  it('falls back to a null retryAfterMs when Retry-After is absent', async () => {
    mockFetchOnce({
      status: 429,
      body: { error: { message: 'rate limited' } },
    });
    const adapter = new GoogleEmbeddingProviderAdapter('secret-key', metadata);

    try {
      await adapter.embed([{ id: 'a', text: 'x' }]);
      fail('expected embed() to throw');
    } catch (err) {
      expect((err as RateLimitEmbeddingProviderError).retryAfterMs).toBeNull();
    }
  });

  it('maps a 500 response to TransientEmbeddingProviderError', async () => {
    mockFetchOnce({
      status: 500,
      body: { error: { message: 'internal error' } },
    });
    const adapter = new GoogleEmbeddingProviderAdapter('secret-key', metadata);

    await expect(adapter.embed([{ id: 'a', text: 'x' }])).rejects.toThrow(
      TransientEmbeddingProviderError,
    );
  });

  it('maps a network-level fetch rejection to TransientEmbeddingProviderError', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ECONNRESET'));
    const adapter = new GoogleEmbeddingProviderAdapter('secret-key', metadata);

    await expect(adapter.embed([{ id: 'a', text: 'x' }])).rejects.toThrow(
      TransientEmbeddingProviderError,
    );
  });

  it('never includes the API key in any thrown error message', async () => {
    mockFetchOnce({
      status: 401,
      body: { error: { message: 'invalid api key' } },
    });
    const adapter = new GoogleEmbeddingProviderAdapter(
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

If Step 1's live check revealed that a per-item `"model": "models/<model>"` field inside each `requests[]` entry is actually required, adjust this test's request-shape assertions (and the implementation in Step 4) to include it — the test above assumes it is not required, per the current, non-deprecated REST reference.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test -- google-embedding-provider.adapter.spec.ts`
Expected: FAIL — `Cannot find module './google-embedding-provider.adapter'`.

- [ ] **Step 4: Implement `GoogleEmbeddingProviderAdapter`**

```typescript
// src/embedding/providers/google-embedding-provider.adapter.ts
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
import { parseRetryAfterMs } from './retry-after.util';

interface GoogleEmbedContentResponseItem {
  values: number[];
}

interface GoogleBatchEmbedContentsResponseBody {
  embeddings: GoogleEmbedContentResponseItem[];
}

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

// Google's Gemini API authenticates via the `x-goog-api-key` header — not
// the `Authorization: Bearer` scheme Voyage/OpenAI use — and its
// batchEmbedContents response is a bare, positionally-ordered array with no
// per-item index/id field the way Voyage/OpenAI's `data[].index` provides.
// Unlike those two adapters, this one cannot defensively re-sort a reordered
// response: it trusts Google's own documented "response order matches
// request order" contract. The shared `validateProviderResponse` still
// catches a missing/extra item (a count mismatch); only a same-count
// silent reorder — which Google's docs give no indication the API ever
// does — would slip through undetected. This is a known, accepted, and
// documented limitation of this adapter specifically, not of the shared
// port design.
export class GoogleEmbeddingProviderAdapter implements EmbeddingProviderPort {
  constructor(
    private readonly apiKey: string,
    public readonly metadata: EmbeddingModelMetadata,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
  ) {}

  async embed(
    items: EmbeddingProviderRequestItem[],
    signal?: AbortSignal,
  ): Promise<EmbeddingProviderResponseItem[]> {
    const url = `${this.baseUrl}/models/${this.metadata.model}:batchEmbedContents`;
    let response: Response;
    try {
      const init: RequestInit = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify({
          requests: items.map((item) => ({
            content: { parts: [{ text: item.text }] },
            embedContentConfig: {
              taskType: 'RETRIEVAL_DOCUMENT',
              outputDimensionality: this.metadata.dimensions,
            },
          })),
        }),
      };
      if (signal !== undefined) {
        init.signal = signal;
      }
      response = await fetch(url, init);
    } catch (err) {
      throw new TransientEmbeddingProviderError(
        'Google embeddings request failed',
        { cause: err },
      );
    }

    if (!response.ok) {
      throw this.toError(response);
    }

    const body =
      (await response.json()) as GoogleBatchEmbedContentsResponseBody;
    return items.map((item, index) => ({
      id: item.id,
      vector: body.embeddings[index]?.values ?? [],
    }));
  }

  private toError(response: Response): Error {
    if (response.status === 429) {
      return new RateLimitEmbeddingProviderError(
        'Google rate limit exceeded',
        parseRetryAfterMs(response.headers.get('retry-after')),
      );
    }
    if (response.status >= 500) {
      return new TransientEmbeddingProviderError(
        `Google embeddings request failed with status ${response.status}`,
      );
    }
    return new PermanentEmbeddingProviderError(
      `Google embeddings request failed with status ${response.status}`,
    );
  }
}
```

Note: like Voyage/OpenAI, an empty/missing vector at a given index (`?.values ?? []`) is deliberately **not** silently accepted — `validateProviderResponse` (already built, unmodified) throws `EmbeddingResponseValidationError` on any empty vector one layer up in `EmbeddingBatchProcessorService`, converting it into a loud, non-retried, whole-batch failure. This adapter does not need its own duplicate guard for that case — see the M3 final-review finding this exact reasoning was already verified against.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test -- google-embedding-provider.adapter.spec.ts`
Expected: PASS, 10/10.

- [ ] **Step 6: Run the full build to confirm no type errors**

Run: `pnpm build`
Expected: succeeds with zero errors.

- [ ] **Step 7: Commit**

```bash
git add src/embedding/providers/google-embedding-provider.adapter.ts src/embedding/providers/google-embedding-provider.adapter.spec.ts
git commit -m "feat(embedding): add GoogleEmbeddingProviderAdapter, proving the provider-swap guarantee a third time"
```

---

### Task 4: Wire Google into `EmbeddingModule`'s provider factory

**Files:**

- Modify: `src/embedding/embedding.module.ts`
- Modify: `src/embedding/embedding.module.spec.ts`

**Interfaces:**

- Consumes: `GoogleEmbeddingProviderAdapter` (Task 3).
- Produces: `EMBEDDING_PROVIDER_PORT` resolves to a `GoogleEmbeddingProviderAdapter` instance when `EMBEDDING_PROVIDER=google`.

- [ ] **Step 1: Write the failing test**

Add to `src/embedding/embedding.module.spec.ts`, alongside the existing per-provider binding tests:

```typescript
it('binds EMBEDDING_PROVIDER_PORT to GoogleEmbeddingProviderAdapter when EMBEDDING_PROVIDER=google', async () => {
  const moduleRef = await buildModule({
    EMBEDDING_PROVIDER: 'google',
    EMBEDDING_API_KEY: 'key',
  });

  expect(moduleRef.get(EMBEDDING_PROVIDER_PORT)).toBeInstanceOf(
    GoogleEmbeddingProviderAdapter,
  );
});
```

Add the corresponding import at the top of the file:

```typescript
import { GoogleEmbeddingProviderAdapter } from './providers/google-embedding-provider.adapter';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- embedding.module.spec.ts`
Expected: FAIL — `EMBEDDING_PROVIDER=google` currently falls through to `OpenAiEmbeddingProviderAdapter` in the factory (see Task 2's note), so `toBeInstanceOf(GoogleEmbeddingProviderAdapter)` fails.

- [ ] **Step 3: Update the factory**

Modify `src/embedding/embedding.module.ts` — add the import:

```typescript
import { GoogleEmbeddingProviderAdapter } from './providers/google-embedding-provider.adapter';
```

Change `createEmbeddingProvider` from:

```typescript
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
  ? new OpenAiEmbeddingProviderAdapter(config.apiKey, metadata, config.baseUrl)
  : new OpenAiEmbeddingProviderAdapter(config.apiKey, metadata);
```

to:

```typescript
if (config.provider === 'voyage') {
  return config.baseUrl
    ? new VoyageEmbeddingProviderAdapter(
        config.apiKey,
        metadata,
        config.baseUrl,
      )
    : new VoyageEmbeddingProviderAdapter(config.apiKey, metadata);
}

if (config.provider === 'google') {
  return config.baseUrl
    ? new GoogleEmbeddingProviderAdapter(
        config.apiKey,
        metadata,
        config.baseUrl,
      )
    : new GoogleEmbeddingProviderAdapter(config.apiKey, metadata);
}

return config.baseUrl
  ? new OpenAiEmbeddingProviderAdapter(config.apiKey, metadata, config.baseUrl)
  : new OpenAiEmbeddingProviderAdapter(config.apiKey, metadata);
```

(The final `return` remains the OpenAI fallback, now reached only for `'openai'` — the exhaustiveness here mirrors the factory's existing style exactly; it is not changed to a `switch` since the existing code already isn't one.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- embedding.module.spec.ts`
Expected: PASS, all tests including the new one.

- [ ] **Step 5: Run the full build to confirm no type errors**

Run: `pnpm build`
Expected: succeeds with zero errors.

- [ ] **Step 6: Run the full test suite**

Run: `pnpm test`
Expected: PASS except the one pre-existing, documented `config/env-example.spec.ts` failure (now needs the 30 lines from M1–M3 plus Task 2's `EMBEDDING_MAX_CHUNKS_PER_RUN=0` — not a new regression).

- [ ] **Step 7: Commit**

```bash
git add src/embedding/embedding.module.ts src/embedding/embedding.module.spec.ts
git commit -m "feat(embedding): wire GoogleEmbeddingProviderAdapter into the provider factory"
```

---

### Task 5: Smoke-test runbook documentation

**Files:**

- Create: `docs/architecture/google-embedding-smoke-test-runbook.md`
- Modify: `README.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Write the runbook**

```markdown
# Google Embedding Provider — Real-Vector Smoke Test Runbook

**Purpose:** prove the existing M3 embedding pipeline produces correct, genuine
semantic vectors with a real provider (Google's `gemini-embedding-001`),
using **exactly 100** real chunks from the real Docker docs corpus, without
risking the free-tier daily quota on the Google API key used to run it.

**This is a manual, human-run procedure.** Do not script this into a loop,
a CI job, or an unattended background task. Run each command yourself,
read its output, and stop if anything looks wrong.

## Prerequisites

- `pnpm build` has been run and is clean (`pnpm build` — confirm zero errors).
- `./data/chunks-output` contains real chunked output (regenerate via the
  chunking pipeline against `./data/ingestion-output` if it does not — see
  the M2/M3 session notes for how this was done previously; this plan does
  not recreate that step).
- You have a real Google AI Studio API key with access to `gemini-embedding-001`.
- The following lines are present in your local `.env` (never commit this
  file with a real key in it):
```

EMBEDDING_API_KEY=<your real Google API key>
EMBEDDING_MAX_CHUNKS_PER_RUN=0

````

(`EMBEDDING_MAX_CHUNKS_PER_RUN` is set to `0` in `.env` itself —
intentionally, so the *default* environment configuration is
"unbounded," matching every other provider — and the actual `100` cap for
this specific run is passed as an inline environment override on the
command line below, not baked into `.env`, so this exact ceiling is
visible in the command you type every time, not hidden in a file.)

## The command

Run this exactly as written, once. All of the following are inline
environment overrides on top of whatever `.env` already has — nothing here
is a permanent config change:

```bash
EMBEDDING_PROVIDER=google \
EMBEDDING_MODEL=gemini-embedding-001 \
EMBEDDING_MODEL_VERSION=1 \
EMBEDDING_DIMENSIONS=768 \
EMBEDDING_INPUT_MAX_TOKENS=2000 \
EMBEDDING_MAX_CHUNKS_PER_RUN=100 \
EMBEDDING_BATCH_SIZE=10 \
EMBEDDING_MAX_CONCURRENT_BATCHES=1 \
EMBEDDING_MAX_RETRIES=3 \
EMBEDDING_OUTPUT_DIR=./data/embedding-output-google-smoke-test \
pnpm embed ./data/chunks-output
````

**Why these specific values, beyond the 100-chunk cap:**

- `EMBEDDING_DIMENSIONS=768` — one of Google's three explicitly-recommended
  Matryoshka checkpoints for `gemini-embedding-001` (768/1536/3072), and the
  smallest of the three — appropriate for a validation run, not a
  storage-cost decision that needs revisiting later.
- `EMBEDDING_INPUT_MAX_TOKENS=2000` — Google's real per-text limit for
  `gemini-embedding-001` is **2048 tokens**, below this project's existing
  default of `8000` (safe for the other providers, not for Google). `2000`
  leaves a small margin under the real ceiling. In practice almost nothing
  should actually hit this limit — `'child'`-type chunks are already
  size-bounded well below it by the chunking module — but setting it
  explicitly means a rare oversized chunk gets truncated (with
  `truncated: true` recorded on its `EmbeddingRecord`, exactly as designed)
  instead of wasting one of your 100 chunk-attempts on a `400` error.
- `EMBEDDING_BATCH_SIZE=10` — 100 chunks ÷ 10 = exactly 10 HTTP requests to
  Google for the whole run, regardless of what the account's exact current
  RPM/RPD figures are (Google does not publish embedding-specific free-tier
  numbers in static docs as of 2026-08-13 — they're visible per-account at
  https://aistudio.google.com/rate-limit — 10 total requests is
  comfortably safe under any plausible tier).
- `EMBEDDING_MAX_CONCURRENT_BATCHES=1` — sequential, not parallel: one
  request in flight at a time, so nothing can burst past a per-minute
  ceiling.
- `EMBEDDING_MAX_RETRIES=3` — a failed request retries at most 3 times
  (existing exponential-backoff-with-jitter logic, unchanged) before that
  batch is recorded as failed and the run moves on — never an unbounded
  retry loop.
- `EMBEDDING_OUTPUT_DIR=./data/embedding-output-google-smoke-test` — a
  dedicated directory, separate from the existing fake-provider
  `./data/embedding-output/embeddings.jsonl`. This also means the existing,
  already-tested provider/model mismatch guard in
  `EmbeddingOutputStoreService` cannot fire (it would refuse to run if this
  pointed at output written by a different provider) and, if you ever
  re-run this exact command a second time, the existing resumability logic
  makes it a **zero-cost no-op** — all 100 `embeddingId`s are already
  present, so `alreadyEmbedded` will read `100` and `attempted` will read
  `0`. Re-running this command by accident does not spend additional quota.

## What to check afterward

1. The printed `EmbeddingRunResult` JSON shows `"attempted": 100`,
   `"succeeded": 100` (or close to it — some real-world failures are
   expected and fine; the point is proving the pipeline handles them, not
   demanding perfection), `"failed"` plus `"succeeded"` summing to `100`,
   and `"totalBatches": 10`.
2. `wc -l ./data/embedding-output-google-smoke-test/embeddings.jsonl`
   reports at most `100` lines (exactly `succeeded`, since failed chunks
   are never written).
3. Spot-check one line with `head -1 ... | node -e "console.log(JSON.parse(require('fs').readFileSync(0)).vector.length)"`
   (or open it in an editor) — the vector should have exactly `768`
   elements, all real (non-integer, varied) floating-point numbers — not
   the fake provider's SHA-256-derived pattern.
4. Optional, stronger semantic-quality check: pick two chunks you know are
   topically related (e.g. two chunks from the same `install-docker`-style
   document) and two you know are unrelated (e.g. one networking chunk, one
   licensing chunk), compute cosine similarity between their real vectors
   (a five-line Node script is enough), and confirm the related pair scores
   higher than the unrelated pair. This is the actual proof that these are
   _real_ semantic embeddings, not just successfully-shaped API responses.

## If something goes wrong

- **401/403 error:** your API key is invalid or lacks access to
  `gemini-embedding-001` — fix the key before re-running, don't retry
  blindly.
- **429 rate limited on the very first batch:** your account's actual
  current free-tier limits are stricter than assumed — stop, check
  https://aistudio.google.com/rate-limit, and lower
  `EMBEDDING_BATCH_SIZE`/add a manual delay between runs rather than
  re-running immediately.
- **Any other failure:** the run's own `failures` array in the printed
  result names the failing `chunkId`s and error messages — read it before
  deciding whether to re-run (remember: re-running is safe/free for chunks
  already embedded, per the resumability note above).

```

- [ ] **Step 2: Add a pointer from the README**

Modify `README.md`'s scripts table — add a note immediately after the existing `pnpm run embed [chunks-dir]` row's description:

```

| `pnpm run embed [chunks-dir]` | Run the real embedding pipeline against a directory of `*.chunks.json` files (defaults to `./data/chunks-output`), for manual inspection. Requires `pnpm run build` first and a configured `EMBEDDING_API_KEY` unless `EMBEDDING_PROVIDER=fake`. For a quota-safe real-provider smoke test capped at a small number of chunks, see `docs/architecture/google-embedding-smoke-test-runbook.md`. |

````

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/google-embedding-smoke-test-runbook.md README.md
git commit -m "docs(embedding): add Google embedding provider smoke-test runbook"
````

---

### Task 6: Execute the smoke test (human-supervised, not autonomous)

**Files:** none — this is execution and verification only, no code changes.

**This task must not be run by an autonomous subagent, workflow, or unattended loop.** It is the one place in this plan that spends the user's real, quota-limited Google API credits. A human runs the command from Task 5's runbook, watches the output, and decides whether to proceed at each step.

- [ ] **Step 1: Confirm prerequisites**

Confirm `pnpm build` is clean, `./data/chunks-output` exists and has real content, and `.env` (or the shell environment) has a real `EMBEDDING_API_KEY` for a Google AI Studio key with access to `gemini-embedding-001`. Do not proceed until all three are true.

- [ ] **Step 2: Run the runbook command exactly once**

Run the exact command from `docs/architecture/google-embedding-smoke-test-runbook.md`'s "The command" section. Do not add a shell loop, `watch`, or retry wrapper around it — the command's own printed exit and `EmbeddingRunResult` JSON is the complete output.

- [ ] **Step 3: Validate against the runbook's checklist**

Work through all four checks in the runbook's "What to check afterward" section. Record the actual numbers observed (attempted/succeeded/failed/totalBatches/duration, vector dimension count, and — if performed — the cosine-similarity sanity check's two scores) in the commit message or a message to the user (not a new file — this project's established convention, per the M3 plan, is not to create standalone report documents unless asked).

- [ ] **Step 4: If anything failed validation, stop — do not proceed to M4**

If `succeeded` is `0`, if the vector dimension count is wrong, if `failed`/`succeeded` don't sum to what was attempted, or if the semantic sanity check comes back inverted (unrelated chunks score higher than related ones), this is a real finding about the M3 pipeline or the Google integration — investigate and fix before treating M3 as validated with a real provider. Do not claim the smoke test passed if any of these checks failed.

- [ ] **Step 5: Report results**

Summarize to the user: exact `EmbeddingRunResult` numbers, output file location and line count, vector dimension confirmation, and the semantic sanity-check result if performed. This closes out the plan — M4 design work begins in a separate conversation/plan, not appended here.

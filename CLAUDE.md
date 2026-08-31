# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

A Retrieval-Augmented Generation (RAG) platform, built with NestJS + TypeScript + pnpm, that answers questions grounded in real documentation. The first knowledge domain is Docker Official Documentation. The platform was built as a sequence of milestones, each a self-contained bounded context added under `src/`:

- **M0 — Foundation**: config, structured logging, health checks, global error handling.
- **M1 — Ingestion** (`src/ingestion/`): extract a ZIP of Markdown docs → parse front matter/Markdown → clean → emit one `StructuredDocument` JSON per file.
- **M2 — Chunking** (`src/chunking/`): turn a `StructuredDocument` into structure-aware, size-bounded `Chunk[]` (parent + child chunks) with deterministic IDs.
- **M3 — Embedding** (`src/embedding/`): turn `Chunk[]` into `EmbeddingRecord`s via a pluggable embedding provider, written as JSONL.
- **M4 — Vector Storage & Retrieval** (`src/vector-store/`, `src/retrieval/`): index embedded chunks into Qdrant, then embed a query and search for the most relevant chunks.
- **M5 — LLM Generation** (`src/generation/`): build a citation-tagged prompt from retrieved chunks via LangChain, call Google Gemini, validate citations against the actually-retrieved chunks, and track real token usage/cost per request.

All five milestones are implemented, tested, and live behind **`POST /query`** — the only HTTP endpoint for RAG itself. `AppModule` wires every module (`HealthModule`, `IngestionModule`, `ChunkingModule`, `EmbeddingModule`, `VectorStoreModule`, `RetrievalModule` — which itself imports `GenerationModule`). A request flows: validate → retrieve (embed the query, search Qdrant) → generate (build prompt, call Gemini, extract+validate citations) → return `{answer, sources, metadata}`. See the "Query endpoint" section of `README.md` for the exact request/response shape.

## Commands

```bash
cp .env.example .env && pnpm install   # setup
docker compose up -d                   # start local Qdrant (required for retrieval/generation)
pnpm run start:dev                     # run with hot reload

pnpm run build                         # compile to dist/ (required before pnpm run ingest / chunk / embed / index / query)
pnpm run lint                          # eslint --fix over src/test/apps/libs
pnpm run format                        # prettier over src/ and test/

pnpm run test                          # unit tests (jest, rootDir: src)
pnpm run test -- <pattern>             # single file/substring, e.g. pnpm run test -- chunk-id.util.spec.ts
pnpm run test:watch
pnpm run test:cov                      # unit tests + coverage (80% floor; main.ts, *.module.ts, cli/** excluded)
pnpm run test:e2e                      # e2e tests (separate jest config: test/jest-e2e.json)
pnpm run test:e2e -- <pattern>         # single e2e file, e.g. pnpm run test:e2e -- retrieval.e2e-spec.ts
pnpm run test:integration              # integration tests against a real local Qdrant (separate jest config: test/jest-integration.json)

pnpm run ingest <path-to-zip>          # run the real ingestion pipeline; writes StructuredDocument JSON to INGESTION_OUTPUT_DIR
pnpm run chunk [ingestion-output-dir]  # run the real chunking pipeline against StructuredDocument JSON (default ./data/ingestion-output)
pnpm run embed [chunks-dir]            # run the real embedding pipeline against *.chunks.json (default ./data/chunks-output); requires EMBEDDING_API_KEY unless EMBEDDING_PROVIDER=fake
pnpm run index                         # index embedded chunks from EMBEDDING_OUTPUT_DIR into the Qdrant collection; requires a reachable Qdrant
pnpm run query "<question>"            # run a one-off retrieval query from the CLI (retrieval only, no generation) — for inspecting raw retrieved chunks
```

`pnpm run ingest`/`chunk`/`embed`/`index`/`query` all run compiled `dist/cli/*.js` — rebuild (`pnpm run build`) after any source change before using them. Once the pipeline has indexed data into Qdrant, `POST /query` (the real HTTP endpoint, generation included) is available on the running app — see the "Query endpoint" section of `README.md`.

Git hooks (Husky, installed via `prepare` on `pnpm install`): pre-commit runs `lint-staged` (ESLint+Prettier on staged files); commit-msg enforces Conventional Commits via commitlint — non-conforming commit messages are rejected.

Requires Node `>=22 <23` (see `.nvmrc`) and pnpm (pinned in `package.json`'s `packageManager`).

## Architecture

### Pipeline shape

Ingestion → chunking → embedding are offline batch stages, each a flat feature module under `src/<name>/` that reads its predecessor's on-disk JSON output and writes its own — no queue, cache, or relational database, `data/` (gitignored) holds all intermediate artifacts as local files. Indexing loads that output into Qdrant. Retrieval and generation are the one online, synchronous stage, invoked live via `POST /query`:

```
ZIP of Markdown docs
  → IngestionPipelineService     → data/ingestion-output/{documentId}.json      (StructuredDocument)
  → ChunkingPipelineService      → data/chunks-output/{documentId}.chunks.json  (Chunk[])
  → EmbeddingPipelineService     → data/embedding-output/embeddings.jsonl       (EmbeddingRecord, append-only)
  → IndexingPipelineService      → Qdrant collection {domain}__{provider}_{model}_{dim}d_v{version}

POST /query {text}
  → RetrievalService    → embed the query, search Qdrant           → RetrievalResult[]
  → GenerationService   → build prompt, call Gemini, extract/validate citations → {answer, sources, metadata}
```

Every stage is invoked either as a NestJS-wired service (all six modules are wired into `AppModule`) or via a small standalone CLI in `src/cli/` (`ingest.ts`, `chunk.ts`, `embed.ts`, `index.ts`, `query.ts`) that boots its own tiny `@Module` (not `AppModule`) via `NestFactory.createApplicationContext`. All five CLIs mirror each other exactly (see the CLI convention below). `query.ts`'s CLI only exercises retrieval (no generation) — the real generation-included answer only comes from the live `POST /query` HTTP endpoint.

### Conventions repeated across every module (follow them, don't reinvent)

- **Config**: exactly one zod schema, `src/config/env.validation.ts` (`envSchema`), validated at boot (`ConfigModule.forRoot({ validate: validateEnv })`). Every module wraps it in its own `*ConfigService` (e.g. `IngestionConfigService`, `ChunkingConfigService`, `EmbeddingConfigService`) exposing typed getters — **never read `process.env` directly**. `src/config/env-example.spec.ts` is a drift-guard test asserting `.env.example`'s keys exactly match `envSchema`'s keys; it can go stale after adding env vars (a known, tracked, non-blocking condition across several past milestones) — check it and update `.env.example` when you add config.
- **Boolean env vars**: never use bare `z.coerce.boolean()` — `Boolean('false')` is `true` in JS. Use the established pattern: `z.union([z.boolean(), z.enum(['true', 'false'])]).default(...).transform((v) => typeof v === 'boolean' ? v : v === 'true')`.
- **Logging**: constructor-inject `PinoLogger` from `nestjs-pino`, call `this.logger.setContext(ClassName.name)` in the constructor, log structured objects first (`this.logger.info({...}, 'message')`), never a raw secret (API keys are never logged anywhere in this codebase).
- **Ports for genuinely-swappable dependencies only**: a `Symbol`-based DI token + interface is used where a second implementation is a near-certain future need (`LENGTH_MEASURER_PORT` in `src/chunking/length-measurer.ts`, `EMBEDDING_PROVIDER_PORT` in `src/embedding/embedding-provider.port.ts`, `VECTOR_STORE_PORT` in `src/vector-store/vector-store.port.ts`, `LLM_PROVIDER_PORT` in `src/generation/llm-provider.port.ts`) — bound via a `useFactory` provider keyed off config. Everything else is a concrete class; don't add a port speculatively.
- **Error handling — per-unit isolation + threshold abort**: a batch operation isolates failures per item/batch (never crashes the whole run on one bad item) and only aborts entirely once a configurable failure ratio is exceeded (`IngestionThresholdExceededError`, `EmbeddingThresholdExceededError`, `VectorStoreThresholdExceededError`). Retryable errors follow a `Transient*Error` (retry with backoff+jitter) vs. `Permanent*Error` (never retry) taxonomy — this pattern is duplicated per module (`src/embedding/embedding.errors.ts`, `src/generation/llm.errors.ts`), not shared, since each module's error semantics diverge slightly; the shared piece is only `withRetry` (`src/common/retry.util.ts`).
- **Deterministic, content-addressed IDs everywhere**: `documentId` = SHA-256 of `sourcePath`; `chunkId` = SHA-256 of `documentId::chunkType::headingPath::occurrenceIndex::localSequenceIndex` (see `src/chunking/chunk-id.util.ts`); `embeddingId` = SHA-256 of `chunkId::contentHash::provider::model::modelVersion::dimensions` (see `src/embedding/embedding-id.util.ts`). This is what makes every offline pipeline stage idempotent/resumable: re-running against unchanged input reproduces the same IDs and is skipped or overwrites identically rather than duplicating. No wall-clock timestamp ever feeds an ID. A live `/query` request instead gets a fresh `randomUUID()` `queryId` purely for correlating its own log lines — never persisted, never content-addressed.
- **CLIs mirror each other exactly**: own minimal `@Module`, `NestFactory.createApplicationContext`, read a positional arg, call one pipeline method, print the JSON result, set `process.exitCode = 1` on failure.

### Domain model highlights

- **Chunking** (`src/chunking/chunking.types.ts`) produces both `'parent'`-type chunks (a whole section's text, uncapped, for context expansion) and `'child'`-type chunks (size-bounded leaf units, meant for embedding/search) per document, linked via `ChunkRelationships` (`parentChunkId`, `childChunkIds`, `previousChunkId`/`nextChunkId`). By default only `'child'` chunks are embedded (`EMBEDDING_CHUNK_TYPES=child`).
- **Embedding** (`src/embedding/`) is provider-agnostic: `EmbeddingProviderPort` has four implementations under `src/embedding/providers/` — `voyage` (default), `openai`, `google`, and `fake` (a deterministic, no-network test double used throughout the test suite and available in real runs via `EMBEDDING_PROVIDER=fake`). Swapping providers is a config change, not a code change. `EmbeddingPipelineService` is resumable: it loads already-written `embeddingId`s from the existing `embeddings.jsonl` and skips them, so re-running only processes new/changed chunks. `EMBEDDING_BATCH_SIZE` is capped at `100` in the zod schema — Google's real `batchEmbedContents` API hard-rejects anything larger.
- **Vector Storage & Retrieval** (`src/vector-store/`, `src/retrieval/`): `IndexingPipelineService` upserts `EmbeddingRecord`s into a Qdrant collection named `deriveCollectionName({domain, provider, model, dimensions, modelVersion})` (`src/vector-store/vector-store-collection-name.util.ts`) — one collection per domain+embedding-config combination, so an embedding-model change never silently mixes incompatible vectors. `RetrievalService.retrieve()` embeds the query text, searches that collection, and throws `RetrievalConfigMismatchError` if the collection's vector dimensions don't match the currently-configured embedding provider (a real safety check, not just a comment) — surfaced as HTTP 503.
- **Generation** (`src/generation/`) mirrors the embedding module's port pattern: `LlmProviderPort` (`google` via `LangChainGoogleGenerativeAiProvider`, wrapping `@langchain/google-genai`'s `ChatGoogleGenerativeAI`, or `fake`). `GenerationService.generate()` never calls the LLM at all when context is insufficient (returns a fixed "not enough information" answer) or when the estimated prompt exceeds `LLM_MAX_PROMPT_TOKENS` (throws `PromptTokenLimitExceededError`, mapped to 400) — both are demo-critical, tested paths, not incidental. Citations are extracted from the LLM's plain-text answer via regex against `[S<n>]`-style markers (handling both single and comma-combined brackets like `[S1, S3]`) and validated against the real chunks sent as context — an unrecognized marker is silently dropped, never fabricated, and `sources` is empty (not "every chunk sent") when the model cites nothing. Real per-request token usage (`usage_metadata` from Gemini's response, not an estimate) and computed USD cost (`LLM_INPUT_PRICE_PER_1M_TOKENS`/`LLM_OUTPUT_PRICE_PER_1M_TOKENS`) are attached to `GenerationResult.metadata` — both fields are optional and omitted (never defaulted to `0`) when the provider doesn't report usage.

### Testing layout

- Unit tests are co-located `*.spec.ts` files next to the code they test; Jest's `rootDir` is `src`, so run them with `pnpm run test -- <substring-of-filename>`.
- E2E tests live in `test/*.e2e-spec.ts` under a separate Jest config (`test/jest-e2e.json`, `rootDir: "."`) and typically boot a real (or `fake`-provider) module end-to-end against a fixture, not mocks throughout.
- Test fixtures that represent pipeline output (e.g. `test/fixtures/chunking/*.json`, `test/fixtures/embedding/*.chunks.json`) are generated by actually running the real upstream pipeline once, never hand-authored — preserve this when adding new fixtures.
- Coverage floor is 80% (branches/functions/lines/statements), enforced via `test:cov`; `main.ts`, `*.module.ts`, and `cli/**` are excluded (validated by e2e tests and successful builds instead).

## Working efficiently (token budget)

This repo's own artifacts get large fast — treat context as a limited resource on every prompt:

- **Never dump `data/` contents into context.** `data/ingestion-output/`, `data/chunks-output/`, `data/embedding-output/` are gitignored and can hold thousands of files / tens of thousands of chunks (e.g. the full real corpus is 1,508 documents → 30,016 chunks). Inspect them with `jq`/`grep`/`wc -l`/`head` for counts and small samples, never `cat`/`Read` a full file or directory listing.
- **Never read `coverage/`, `dist/`, `node_modules/`, or `pnpm-lock.yaml`.** These are generated/vendored; read source and `package.json` instead.
- **Run the narrowest test command that answers the question.** Use `pnpm run test -- <file-substring>` for one file instead of the full `pnpm run test`; only run the full suite (or `test:cov`) before committing or when a change could plausibly have cross-module effects.
- **Prefer `Grep`/`Glob` over reading whole files** when only checking for a symbol, pattern, or convention — read the full file only once you actually need to edit it or reason about its complete logic.
- **Reuse the design docs instead of re-deriving design context from source.** `docs/architecture/*.md` and `docs/superpowers/plans/*.md` already contain the investigated rationale for M1–M4 — check there before re-reading multiple source files to reconstruct "why" something is shaped the way it is.
- **For large or exploratory investigations** (auditing the whole corpus, cross-file consistency checks, broad refactors), delegate to a subagent/fork rather than pulling raw output into the main conversation — summarize findings back, not full logs.
- **Don't re-read a file you just wrote or edited** in the same turn — the tool result already confirms the change; only re-read if a later, independent step needs to verify content you didn't just produce.

## Where to look for deeper context

- `docs/architecture/*.md` — one design doc per milestone (`rag-platform-architecture.md` for the overall platform sketch, then `document-ingestion-subsystem-design.md`, `semantic-chunking-design.md`, `embedding-infrastructure-design.md`, `vector-storage-retrieval-design.md` for M1–M4 respectively), each written _after_ investigating the actual current codebase state and explaining design rationale, provider/strategy comparisons, and known limitations in detail. `vector-store-local-dev.md` and `vector-retrieval-smoke-test-runbook.md` cover M4's local Qdrant setup and its real-corpus smoke test; `llm-generation-smoke-test-results.md` covers M5's real Gemini smoke test (deprecated-model, timeout, and citation-fallback bugs found and fixed live).
- `docs/superpowers/plans/*.md` — the bite-sized, TDD-oriented implementation plans each milestone was built from.
- `README.md` — full environment variable reference table, script descriptions, and the `POST /query` request/response shape.
- `PROJECT_OVERVIEW.md` — a short, plain-language (no jargon) summary of what this project does and why, meant for a non-technical audience.

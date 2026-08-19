# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Backend foundation for a Retrieval-Augmented Generation (RAG) platform, built with NestJS + TypeScript + pnpm. The first knowledge domain is Docker Official Documentation. The platform is being built as a sequence of milestones, each a self-contained bounded context added under `src/`:

- **M0 — Foundation**: config, structured logging, health checks, global error handling.
- **M1 — Ingestion** (`src/ingestion/`): extract a ZIP of Markdown docs → parse front matter/Markdown → clean → emit one `StructuredDocument` JSON per file.
- **M2 — Chunking** (`src/chunking/`): turn a `StructuredDocument` into structure-aware, size-bounded `Chunk[]` (parent + child chunks) with deterministic IDs.
- **M3 — Embedding** (`src/embedding/`): turn `Chunk[]` into `EmbeddingRecord`s via a pluggable embedding provider, written as JSONL.
- **M4 — Vector Storage & Retrieval**: designed only (`docs/architecture/vector-storage-retrieval-design.md`), not yet implemented — no vector-store code exists in `src/` yet.

There is currently **no HTTP API for RAG itself** — ingestion/chunking/embedding all run as synchronous CLIs against local files. `AppModule` only wires `HealthModule`, `IngestionModule`, and `ChunkingModule`; `EmbeddingModule` is deliberately _not_ wired into `AppModule` (it's only exercised via its CLI and tests, since it requires a real provider API key to do anything beyond the `fake` provider).

## Commands

```bash
cp .env.example .env && pnpm install   # setup
pnpm run start:dev                     # run with hot reload

pnpm run build                         # compile to dist/ (required before pnpm run ingest / embed)
pnpm run lint                          # eslint --fix over src/test/apps/libs
pnpm run format                        # prettier over src/ and test/

pnpm run test                          # unit tests (jest, rootDir: src)
pnpm run test -- <pattern>             # single file/substring, e.g. pnpm run test -- chunk-id.util.spec.ts
pnpm run test:watch
pnpm run test:cov                      # unit tests + coverage (80% floor; main.ts, *.module.ts, cli/** excluded)
pnpm run test:e2e                      # e2e tests (separate jest config: test/jest-e2e.json)
pnpm run test:e2e -- <pattern>         # single e2e file, e.g. pnpm run test:e2e -- embedding.e2e-spec.ts

pnpm run ingest <path-to-zip>          # run the real ingestion pipeline; writes StructuredDocument JSON to INGESTION_OUTPUT_DIR
pnpm run embed [chunks-dir]            # run the real embedding pipeline against *.chunks.json (default ./data/chunks-output); requires EMBEDDING_API_KEY unless EMBEDDING_PROVIDER=fake
```

`pnpm run ingest`/`pnpm run embed` run compiled `dist/cli/*.js` — rebuild (`pnpm run build`) after any source change before using them.

Git hooks (Husky, installed via `prepare` on `pnpm install`): pre-commit runs `lint-staged` (ESLint+Prettier on staged files); commit-msg enforces Conventional Commits via commitlint — non-conforming commit messages are rejected.

Requires Node `>=22 <23` (see `.nvmrc`) and pnpm (pinned in `package.json`'s `packageManager`).

## Architecture

### Pipeline shape

Each milestone is a flat feature module under `src/<name>/` that reads its predecessor's on-disk JSON output and writes its own. There is no queue, cache, or relational database anywhere — `data/` (gitignored) holds all intermediate artifacts as local files:

```
ZIP of Markdown docs
  → IngestionPipelineService     → data/ingestion-output/{documentId}.json      (StructuredDocument)
  → ChunkingPipelineService      → data/chunks-output/{documentId}.chunks.json  (Chunk[])
  → EmbeddingPipelineService     → data/embedding-output/embeddings.jsonl       (EmbeddingRecord, append-only)
```

Each module is invoked either as a NestJS-wired service (`ChunkingModule`, `IngestionModule` in `AppModule`) or via a small standalone CLI in `src/cli/` (`ingest.ts`, `embed.ts`) that boots its own tiny `@Module` (not `AppModule`) via `NestFactory.createApplicationContext`. Chunking has no CLI of its own — it's invoked in-process or via tests only.

### Conventions repeated across every module (follow them, don't reinvent)

- **Config**: exactly one zod schema, `src/config/env.validation.ts` (`envSchema`), validated at boot (`ConfigModule.forRoot({ validate: validateEnv })`). Every module wraps it in its own `*ConfigService` (e.g. `IngestionConfigService`, `ChunkingConfigService`, `EmbeddingConfigService`) exposing typed getters — **never read `process.env` directly**. `src/config/env-example.spec.ts` is a drift-guard test asserting `.env.example`'s keys exactly match `envSchema`'s keys; it can go stale after adding env vars (a known, tracked, non-blocking condition across several past milestones) — check it and update `.env.example` when you add config.
- **Boolean env vars**: never use bare `z.coerce.boolean()` — `Boolean('false')` is `true` in JS. Use the established pattern: `z.union([z.boolean(), z.enum(['true', 'false'])]).default(...).transform((v) => typeof v === 'boolean' ? v : v === 'true')`.
- **Logging**: constructor-inject `PinoLogger` from `nestjs-pino`, call `this.logger.setContext(ClassName.name)` in the constructor, log structured objects first (`this.logger.info({...}, 'message')`), never a raw secret (API keys are never logged anywhere in this codebase).
- **Ports for genuinely-swappable dependencies only**: a `Symbol`-based DI token + interface is used where a second implementation is a near-certain future need (`LENGTH_MEASURER_PORT` in `src/chunking/length-measurer.ts`, `EMBEDDING_PROVIDER_PORT` in `src/embedding/embedding-provider.port.ts`) — bound via a `useFactory` provider keyed off config. Everything else is a concrete class; don't add a port speculatively.
- **Error handling — per-unit isolation + threshold abort**: a batch operation isolates failures per item/batch (never crashes the whole run on one bad item) and only aborts entirely once a configurable failure ratio is exceeded (`IngestionThresholdExceededError`, `EmbeddingThresholdExceededError`). Retryable errors follow a `Transient*Error` (retry with backoff+jitter) vs. `Permanent*Error` (never retry) taxonomy (see `src/embedding/retry.util.ts`, `src/embedding/embedding.errors.ts`).
- **Deterministic, content-addressed IDs everywhere**: `documentId` = SHA-256 of `sourcePath`; `chunkId` = SHA-256 of `documentId::chunkType::headingPath::occurrenceIndex::localSequenceIndex` (see `src/chunking/chunk-id.util.ts`); `embeddingId` = SHA-256 of `chunkId::contentHash::provider::model::modelVersion::dimensions` (see `src/embedding/embedding-id.util.ts`). This is what makes every pipeline stage idempotent/resumable: re-running against unchanged input reproduces the same IDs and is skipped or overwrites identically rather than duplicating. No wall-clock timestamp ever feeds an ID.
- **CLIs mirror each other exactly**: own minimal `@Module`, `NestFactory.createApplicationContext`, read a positional arg, call one pipeline method, print the JSON result, set `process.exitCode = 1` on failure.

### Domain model highlights

- **Chunking** (`src/chunking/chunking.types.ts`) produces both `'parent'`-type chunks (a whole section's text, uncapped, for context expansion) and `'child'`-type chunks (size-bounded leaf units, meant for embedding/search) per document, linked via `ChunkRelationships` (`parentChunkId`, `childChunkIds`, `previousChunkId`/`nextChunkId`). By default only `'child'` chunks are embedded (`EMBEDDING_CHUNK_TYPES=child`).
- **Embedding** (`src/embedding/`) is provider-agnostic: `EmbeddingProviderPort` has four implementations under `src/embedding/providers/` — `voyage` (default), `openai`, `google`, and `fake` (a deterministic, no-network test double used throughout the test suite and available in real runs via `EMBEDDING_PROVIDER=fake`). Swapping providers is a config change, not a code change. `EmbeddingPipelineService` is resumable: it loads already-written `embeddingId`s from the existing `embeddings.jsonl` and skips them, so re-running only processes new/changed chunks.

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

- `docs/architecture/*.md` — one design doc per milestone (`rag-platform-architecture.md` for the overall platform sketch, then `document-ingestion-subsystem-design.md`, `semantic-chunking-design.md`, `embedding-infrastructure-design.md`, `vector-storage-retrieval-design.md` for M1–M4 respectively), each written _after_ investigating the actual current codebase state and explaining design rationale, provider/strategy comparisons, and known limitations in detail.
- `docs/superpowers/plans/*.md` — the bite-sized, TDD-oriented implementation plans each milestone was built from.
- `README.md` — full environment variable reference table and script descriptions.

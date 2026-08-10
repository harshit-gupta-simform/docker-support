# Docker Support — RAG Platform API

Backend API foundation for a Retrieval-Augmented Generation platform, built with NestJS, TypeScript, and pnpm. The first knowledge domain is Docker Official Documentation; see [`docs/architecture/rag-platform-architecture.md`](./docs/architecture/rag-platform-architecture.md) for the full platform architecture.

This repository currently contains the production-grade application foundation only — configuration, logging, health checks, error handling, and tooling. No domain logic (ingestion, retrieval, generation) has been built yet.

## Setup

```bash
cp .env.example .env
pnpm install
pnpm run start:dev
```

The app starts on the port configured in `.env` (default `3000`).

## Environment variables

| Variable                           | Default                   | Description                                                                                                                           |
| ---------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                         | `development`             | `development`, `production`, or `test`. Controls log formatting (pretty outside production) and other environment-dependent behavior. |
| `PORT`                             | `3000`                    | HTTP port the app listens on.                                                                                                         |
| `LOG_LEVEL`                        | `info`                    | Pino log level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent`.                                                      |
| `INGESTION_OUTPUT_DIR`             | `./data/ingestion-output` | Directory where ingested `StructuredDocument` JSON files are written.                                                                 |
| `INGESTION_MAX_ENTRY_COUNT`        | `10000`                   | Zip-bomb guard: max number of entries an archive may declare before extraction is refused.                                            |
| `INGESTION_MAX_UNCOMPRESSED_BYTES` | `524288000`               | Zip-bomb guard: max total uncompressed bytes an archive may contain (default 500 MB).                                                 |
| `INGESTION_INCLUDE_GLOB`           | `**/*.md`                 | Glob pattern selecting which archive entries are treated as documents.                                                                |
| `INGESTION_DEFAULT_LANGUAGE`       | `en`                      | Fallback `language` metadata value when a document's front matter doesn't specify one.                                                |
| `CHUNKING_MAX_CHUNK_SIZE`          | `500`                     | Upper size bound (in `CHUNKING_LENGTH_STRATEGY` units) before a section is split into multiple chunks.                                |
| `CHUNKING_MIN_CHUNK_SIZE`          | `100`                     | Lower size bound before a section is merged with an adjacent, equally undersized sibling section.                                     |
| `CHUNKING_LENGTH_STRATEGY`         | `approx-token`            | How chunk size is measured: `char`, `word`, or `approx-token` (~4 characters per token).                                              |
| `CHUNKING_OVERLAP_STRATEGY`        | `heading-context`         | How split pieces of an oversized section stay contextualized: `none`, `heading-context` (a breadcrumb), or `sentence-overlap`.        |
| `CHUNKING_OVERLAP_SENTENCES`       | `1`                       | Sentences duplicated between split pieces when `CHUNKING_OVERLAP_STRATEGY=sentence-overlap`.                                          |
| `CHUNKING_INCLUDE_PARENT_CHUNKS`   | `true`                    | Whether to also emit one full-section `'parent'`-type chunk per section, for parent-document retrieval.                               |
| `CHUNKING_OUTPUT_DIR`              | `./data/chunks-output`    | Directory where chunked `Chunk[]` JSON files are written.                                                                             |

All environment variables are validated at boot via a zod schema (`src/config/env.validation.ts`) — the app fails fast with a descriptive error if configuration is missing or invalid, rather than failing later at first use.

## Scripts

| Script                          | Purpose                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run build`                | Compile TypeScript to `dist/`.                                                                                                                                                                                                                                                                                                                           |
| `pnpm run start`                | Run the compiled app once.                                                                                                                                                                                                                                                                                                                               |
| `pnpm run start:dev`            | Run with file-watching and hot reload.                                                                                                                                                                                                                                                                                                                   |
| `pnpm run start:prod`           | Run the compiled production build (`dist/main.js`).                                                                                                                                                                                                                                                                                                      |
| `pnpm run lint`                 | Lint and auto-fix `src/`, `test/`, `apps/`, `libs/`.                                                                                                                                                                                                                                                                                                     |
| `pnpm run format`               | Format `src/` and `test/` with Prettier.                                                                                                                                                                                                                                                                                                                 |
| `pnpm run test`                 | Run unit tests.                                                                                                                                                                                                                                                                                                                                          |
| `pnpm run test:e2e`             | Run end-to-end tests.                                                                                                                                                                                                                                                                                                                                    |
| `pnpm run test:cov`             | Run unit tests with coverage (enforces an 80% floor on branches/functions/lines/statements). `main.ts`, `*.module.ts`, and `cli/**` files are excluded from this calculation — they're composition-root/bootstrap files validated via e2e tests and successful builds rather than direct unit tests.                                                     |
| `pnpm run ingest <path-to-zip>` | Run the real ingestion pipeline against a ZIP archive from the command line, for manual inspection. Requires `pnpm run build` first (rebuild after any code change). Prints the `IngestionResult` summary and writes one `StructuredDocument` JSON file per ingested document to `INGESTION_OUTPUT_DIR` (default `./data/ingestion-output`, gitignored). |

## Health endpoints

- `GET /health/live` — process-level liveness (memory heap/RSS checks). Use for a Kubernetes liveness probe.
- `GET /health/ready` — readiness (same checks today; the attachment point for future database/cache/vector-store readiness indicators). Use for a Kubernetes readiness probe.

Both return `200` with `{"status": "ok", ...}` when healthy, or `503` when any underlying check fails.

## Git hooks

This repo uses [Husky](https://typicode.github.io/husky/) for git hooks, installed automatically via the `prepare` script on `pnpm install`:

- **pre-commit** — runs `lint-staged` (ESLint + Prettier) on staged files.
- **commit-msg** — runs [commitlint](https://commitlint.js.org/) against [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, `docs:`, etc.). Non-conforming commit messages are rejected.

## Requirements

- Node.js `>=22 <23` (see `.nvmrc`) — an LTS release line.
- pnpm (see `packageManager` in `package.json` for the exact pinned version).

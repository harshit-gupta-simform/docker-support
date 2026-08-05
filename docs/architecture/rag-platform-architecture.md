# RAG Platform Architecture — Docker Docs (Domain-Extensible)

**Backend:** NestJS (latest), TypeScript, pnpm
**First knowledge domain:** Docker Official Documentation
**Design goal:** additional domains (Kubernetes, Linux, Terraform, …) can be added later with zero architectural changes

---

## 1. Architecture Philosophy

**Hexagonal (Ports & Adapters) within Clean Architecture, organized as DDD bounded contexts.** Every external dependency (vector store, embedding provider, LLM provider, cache, document source) sits behind a port interface owned by the domain lib that consumes it. Adapters implement ports and are the _only_ place a specific technology (Chroma, OpenAI, a GitHub repo crawler) is named. Domain/application code never imports an adapter — only its port, resolved via NestJS DI tokens in each app's composition root.

**The mechanism that keeps Docker from leaking into the architecture is a single aggregate: `KnowledgeDomain`.** It is a configuration object (loader adapter + config, chunking strategy, embedding model, vector collection name, retrieval defaults). Docker is not a concept in code anywhere — it is one row of `KnowledgeDomain` config. Adding Kubernetes later is a new config row (and, only if its source type is genuinely new, one new loader adapter) — never a change to Retrieval, Generation, Conversation, or the API layer, all of which are parameterized by `domainId` and know nothing about what a domain "is."

**CQRS: not adopted.** `@nestjs/cqrs` would add a CommandBus/QueryBus layer with no payoff here — ingestion's write side is already isolated by BullMQ (jobs _are_ the command transport), and the read side (retrieval → generation) is a single linear pipeline with no competing read models. Where event-style decoupling helps (e.g., reacting to "document ingested" to invalidate a cache), plain `@nestjs/event-emitter` is sufficient. Revisit only if audit/replay or multiple heterogeneous read projections become real requirements.

---

## 2. Bounded Contexts & Module Responsibilities

| Context                                                        | Responsibility                                                                                                                                                     | Must NOT do                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| **Knowledge Domain Registry**                                  | Owns which domains exist and how each is configured (loader, chunking, embedding, vector collection, retrieval defaults). Single source of truth for pluggability. | Ingest, retrieve, or embed anything itself.                                             |
| **Document Ingestion**                                         | Orchestrates load → chunk → embed → persist (vector store + Postgres metadata) for a domain.                                                                       | Rank/retrieve results; build prompts; contain source-specific parsing outside adapters. |
| **Retrieval**                                                  | Embeds a query, searches the domain's vector collection with a mandatory domain filter, optionally reranks, returns ranked chunks.                                 | Call the LLM; persist conversation state.                                               |
| **Generation**                                                 | Builds a prompt from query + retrieved context + history, calls the LLM (streamed), returns an answer with citations.                                              | Perform retrieval; touch the vector store or embedding provider directly.               |
| **Conversation**                                               | Owns session/turn state; delegates to Retrieval + Generation.                                                                                                      | Generate answers or embed anything itself.                                              |
| **Query Orchestration** (application facade, not a domain lib) | Composes Conversation → Retrieval → Generation for the HTTP/SSE boundary.                                                                                          | Contain business rules of its own.                                                      |

### Core entities / aggregates / value objects

- **`KnowledgeDomain`** (aggregate root, Registry): `id`, `displayName`, `description`, `source: {loaderAdapterKey, loaderConfig}`, `chunking: {strategy, chunkSize, chunkOverlap}`, `embedding: {providerKey, model, dimensions}`, `vectorStore: {collectionName, distanceMetric}`, `retrievalDefaults: {topK, scoreThreshold, filters}`, `status`, `version`.
- **`Document`** (Ingestion): `id`, `domainId`, `sourceUri`, `contentHash`, `title`, `sourceMetadata`, `ingestedAt`, `version`.
- **`Chunk`**: `id`, `documentId`, `domainId`, `text`, `tokenCount`, `position`, `embeddingVectorId`, `metadata` (heading/section path).
- **`IngestionJob`**: tracking entity (status, attempt count) mirrored alongside the BullMQ job for observability/reconciliation.
- **`Query`** (VO): `text`, `domainId`, `filters`, `topK`. **`RankedChunk`**: chunk ref + score.
- **`Answer`**: text/stream + `citations: [{documentId, chunkId, sourceUri}]` + token-usage metadata.
- **`Conversation`** (aggregate): `id`, `domainId`, `messages: Message[]`, `createdAt`, `lastActiveAt`, `ttl`.

### Ports and their adapters

- **`DocumentLoaderPort`** — `load(config): AsyncIterable<RawDocument>`. Two genuinely domain-agnostic adapters cover Docker _and_ future domains without new code: `WebCrawlerLoaderAdapter` (seed URLs/sitemap/selectors/depth) and `MarkdownGitRepoLoaderAdapter` (clone/pull a repo + glob pattern). **Docker is configured as a `MarkdownGitRepoLoaderAdapter` instance pointed at `docker/docs` on GitHub** (cleaner and more stable than scraping rendered HTML). Kubernetes docs later reuse the same adapter with a different repo URL. Only a genuinely new source shape (e.g., an OpenAPI-spec loader) needs bespoke adapter code.
- **`ChunkingPort`** — wraps `@langchain/textsplitters`' `RecursiveCharacterTextSplitter` / `TokenTextSplitter`. This is the one place LangChain earns its keep: a narrow, well-scoped utility, not the surrounding agent/chain framework. Strategy is selected per-domain (`KnowledgeDomain.chunking.strategy`), so Terraform HCL or K8s YAML can later register a different splitter without touching the pipeline.
- **`EmbeddingProviderPort`** — `embed(texts: string[]): Promise<number[][]>`. Adapter: `OpenAIEmbeddingAdapter` (extendable to others).
- **`VectorStorePort`** — `ensureCollection(name, dim, metric)`, `upsert(collection, records[])`, `search(collection, queryVector, topK, filter)`, `deleteByFilter(collection, filter)`. Deliberately **excludes** hybrid search, native rerank, and index-tuning knobs — those diverge too much across Chroma/Qdrant/pgvector to force into one contract; expose them later as optional capability interfaces (e.g., `HybridSearchCapability`) an adapter may implement, checked at runtime. Adapters: `ChromaVectorStoreAdapter` (priority #1), `PgVectorStoreAdapter`, `QdrantVectorStoreAdapter`. Embeddings are computed via `EmbeddingProviderPort` and passed to the store as raw vectors — **not** via Chroma's built-in embedding functions — so the embedding-provider swap stays independent of the vector-store swap.
- **`LLMProviderPort`** — `generate(...)` / `generateStream(...)`. Adapters: `OpenAIProviderAdapter`, `AnthropicProviderAdapter`.
- **`CachePort`** — `get/set/del/wrap`. Adapter: `RedisCacheAdapter`, used by Retrieval (query/result caching) and Conversation (session state); Redis also separately backs BullMQ under a different logical namespace — an infra-sharing decision, not a coupling of the abstractions.
- **`ConversationRepositoryPort`**, **`DocumentMetadataRepositoryPort`**, **`KnowledgeDomainRepositoryPort`** — Postgres adapters (via Prisma, see §5) for session state, Document/Chunk/IngestionJob records, and domain config respectively.

Ports are declared inside the domain lib that consumes them (dependency inversion); adapter libs depend on the port, never the reverse. Concrete wiring (which adapter implements which port) happens only in each app's composition root, e.g. `VectorStoreModule.forRoot(config)` binding a `VECTOR_STORE_PORT` DI token to `ChromaVectorStoreAdapter` — domain libs stay adapter-ignorant even at compile time.

### Vector store decision: one collection per domain

Not a shared collection with a domain metadata filter. Reasoning:

- **Isolation** — a bad re-index or corruption in one domain can't touch another.
- **Blast radius** — migrating Kubernetes off Chroma to Qdrant later is a per-collection adapter swap; Docker's data is untouched.
- **Speed** — smaller per-domain HNSW graphs search faster; compacting/rebuilding one domain's index doesn't stall others.

Name collections `{domain-slug}__{embedding-model-version}` (e.g., `docker__text-embedding-3-large-v1`) so an embedding-model upgrade creates a parallel collection for blue/green cutover instead of mutating vectors in place.

---

## 3. Data Flow

### Ingestion (async, offline, queue-driven)

1. A domain is registered as a `KnowledgeDomain` row in Postgres (loader/chunking/embedding/collection config).
2. A scheduled or manual trigger creates an `ingestion_jobs` row (`status=pending`) and enqueues a `crawl-domain` BullMQ job on a per-domain queue.
3. The crawl worker enumerates source documents via the domain's `DocumentLoaderPort` adapter. For each document it computes a `contentHash` (SHA-256 of normalized text) and compares it to the stored hash — **unchanged documents are skipped** (only `lastSeenAt` is bumped); changed/new documents enqueue a `process-document` job. This incremental-hash check is the single biggest cost lever: re-crawling Docker docs doesn't re-embed pages that haven't changed.
4. The process-document worker normalizes content (HTML→Markdown via a loader-specific step, or Markdown passthrough for the git-repo loader), persists the normalized content + hash in Postgres, and chunks it via `ChunkingPort` using the domain's configured strategy.
5. Chunks are batched (e.g., 100/batch) into `embed-chunk-batch` jobs, concurrency-capped to the embedding provider's rate limits via BullMQ's rate limiter, with exponential backoff on 429s.
6. The embed worker calls `EmbeddingProviderPort`, then `VectorStorePort.upsert(...)` with `{id, vector, metadata: {domainId, sourceUrl, chunkIndex, contentHash, docVersion}}`, and writes a `chunks` ledger row in Postgres (`chunkId → vectorId`, `embeddingModelVersion`, `status=indexed`).
7. **Postgres is system-of-record for job state, document hashes, and the chunk ledger. The vector store is system-of-record only for embeddings + filterable metadata.** A periodic reconciliation job diffs the Postgres chunk ledger against vector-store IDs to catch orphans left by failed jobs.
8. Document/job completion rolls up to `document.indexed=true` and `ingestionJob.status=completed`.

### Query (sync, online, streamed)

1. Request: `{question, domainSlug, conversationId?}`.
2. Domain config is read from Redis (cached from Postgres, 5-minute TTL, invalidated on config update).
3. Redis answer cache is checked first: key = `hash(domainSlug + normalizedQuestion + embeddingModelVersion)`, short TTL (~15 min, since docs mutate). A hit skips embedding, retrieval, and the LLM entirely.
4. On miss, the question is embedded, itself cached (~24h TTL, keyed on normalized question) — the second-largest cost lever after ingestion dedup.
5. Similarity search runs via `VectorStorePort.search(...)` against the domain's collection, with the domain filter (and any user-supplied filters) **pushed to the store's native filter — never post-filtered in app code**, to avoid both cross-domain leakage and wasted top-k slots.
6. An optional rerank step fires only when top-k scores are close (gates latency/cost rather than always running).
7. Prompt assembly combines system + domain instructions + retrieved chunks (with citation metadata) + the last N conversation turns pulled from Postgres by `conversationId`.
8. The LLM call streams over SSE; citations ship as a structured sidecar event alongside the text stream.
9. On completion, the turn (question, answer, chunk IDs, token usage, latency) is persisted to Postgres, and the answer is written to the Redis answer cache.

---

## 4. Folder Structure (pnpm workspaces, no Nx)

```
docker-support/
├── apps/
│   ├── api/                      # HTTP+SSE: query, conversation, domain-admin endpoints. Stateless, horizontally scaled.
│   └── ingestion-worker/         # NestFactory.createApplicationContext — no HTTP surface, BullMQ processors only.
├── libs/
│   ├── domain/
│   │   ├── knowledge-domain/     # KnowledgeDomain aggregate, registry service, KnowledgeDomainRepositoryPort
│   │   ├── ingestion/            # Document/Chunk/IngestionJob + use-cases + DocumentLoaderPort, ChunkingPort
│   │   ├── retrieval/            # Query/RankedChunk + use-case + VectorStorePort, EmbeddingProviderPort
│   │   ├── generation/           # Answer/prompt-building use-case + LLMProviderPort
│   │   └── conversation/         # Conversation aggregate + use-case + ConversationRepositoryPort
│   ├── adapters/
│   │   ├── loaders/{web-crawler,markdown-git-repo}/
│   │   ├── chunking/langchain-recursive-splitter/
│   │   ├── embeddings/openai-embedding/
│   │   ├── vector-store/{chroma,pgvector,qdrant}/
│   │   ├── llm/{openai,anthropic}/
│   │   ├── cache/redis-cache/
│   │   └── persistence/postgres/   # Prisma schema + repository implementations
│   └── shared/
│       ├── config/                # Typed, zod-validated config schemas per lib/adapter
│       ├── logging/                # pino-based structured logger, correlation-id propagation
│       ├── kernel/                 # Shared VOs, domain error types, base entity classes
│       └── testing/                 # Fakes/test-doubles for every port
├── docs/
│   └── architecture/rag-platform-architecture.md   # this document
├── docker-compose.yml              # local Postgres, Redis, Chroma for dev
├── pnpm-workspace.yaml
├── tsconfig.base.json               # project references, composite: true
└── package.json
```

**Boundary enforcement without Nx**: pnpm workspaces + package `exports` maps (blocking deep imports into a lib's internals) + `eslint-plugin-boundaries` rules (`domain/*` libs may depend only on `shared/*` and their own ports; `adapters/*` may depend on the domain ports they implement but never the reverse) + TypeScript project references. This gives equivalent enforcement to Nx's module-boundary tooling at a fraction of the setup/maintenance cost — Nx is not justified at this project's scale.

**App-to-context mapping**: `apps/api` composes Retrieval + Generation + Conversation with adapters wired via DI; its admin endpoints enqueue ingestion jobs but never execute ingestion inline. `apps/ingestion-worker` hosts `@Processor()`/`WorkerHost` classes (from `@nestjs/bullmq`) consuming the ingestion queues end-to-end. The two scale independently — ingestion bursts during re-crawls, the API stays available regardless.

### Current status: flat structure (as of 2026-08-05)

This project currently lives as a single flat NestJS app at the repository root — the `apps/`/`libs/` pnpm-workspace split described above has not been implemented yet. This was a deliberate decision made during the initial production-readiness hardening pass following the first scaffolding pass: restructuring into the monorepo before any real domain code (ingestion, retrieval, generation) exists would mean moving files based on a structure with no content yet to validate it against. The restructure is deferred until ingestion/retrieval code is actually being built — at that point, this app becomes `apps/api` per the structure above.

---

## 5. Required npm Packages

| Package                                                                  | Purpose                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@nestjs/core`, `@nestjs/common`, `@nestjs/platform-express`             | Framework core. Express over Fastify for this project: broader middleware/ecosystem maturity (pino, swagger, throttler all well-trodden on Express); revisit only if raw throughput becomes the bottleneck.                                                                                                                                                                           |
| `@nestjs/config`                                                         | Configuration module; paired with a `zod`-based `validate` function rather than Joi, so config schemas share validation code with the rest of the app.                                                                                                                                                                                                                                |
| `@nestjs/bullmq`, `bullmq`                                               | Async job queue for ingestion (crawl / process-document / embed-chunk-batch). `@nestjs/bullmq`'s `@Processor()` + `WorkerHost` pattern is the current (non-legacy) integration.                                                                                                                                                                                                       |
| `ioredis`                                                                | Redis client — backs `CachePort`'s Redis adapter and the BullMQ connection (separate logical namespaces).                                                                                                                                                                                                                                                                             |
| `@nestjs/terminus`                                                       | Liveness/readiness health checks for both apps.                                                                                                                                                                                                                                                                                                                                       |
| `@nestjs/swagger`                                                        | OpenAPI docs for `apps/api`.                                                                                                                                                                                                                                                                                                                                                          |
| `@nestjs/event-emitter`                                                  | Lightweight in-process events (e.g., `DocumentIngested` → cache invalidation) — the full extent of event-driven decoupling this project needs; see the CQRS decision in §1.                                                                                                                                                                                                           |
| `class-validator`, `class-transformer`                                   | DTO validation at the HTTP boundary.                                                                                                                                                                                                                                                                                                                                                  |
| `nestjs-pino`, `pino`, `pino-http`, `pino-pretty` (dev)                  | Structured JSON logging in production, human-readable in dev; integrates with `nestjs-cls` for correlation-ID propagation.                                                                                                                                                                                                                                                            |
| `nestjs-cls`                                                             | Request-scoped storage (via `AsyncLocalStorage`) so a correlation/request ID threads through logs across the whole call chain, including inside BullMQ processors.                                                                                                                                                                                                                    |
| `zod`                                                                    | Runtime schema validation — config validation, and validating/parsing structured LLM output (citations, tool-call-shaped responses).                                                                                                                                                                                                                                                  |
| `prisma`, `@prisma/client`                                               | Postgres ORM for `Document`, `Chunk`, `IngestionJob`, `KnowledgeDomain`, `Conversation` records — chosen over TypeORM for stronger generated types and a cleaner migration workflow; wrapped in `libs/adapters/persistence/postgres` repository classes implementing the domain's repository ports, so domain libs never import Prisma types directly.                                |
| `chromadb`                                                               | Official Chroma JS/TS client (priority-#1 vector store adapter).                                                                                                                                                                                                                                                                                                                      |
| `@qdrant/js-client-rest`                                                 | Official Qdrant client for the future `QdrantVectorStoreAdapter` — the scale-out migration target (see §8).                                                                                                                                                                                                                                                                           |
| `pg`                                                                     | Raw Postgres driver, used directly (alongside Prisma) inside `PgVectorStoreAdapter` for `pgvector`-specific SQL (ANN index queries) that an ORM can't express well.                                                                                                                                                                                                                   |
| `openai`                                                                 | OpenAI SDK — embeddings (`OpenAIEmbeddingAdapter`) and one LLM adapter.                                                                                                                                                                                                                                                                                                               |
| `@anthropic-ai/sdk`                                                      | Anthropic SDK — second `LLMProviderPort` adapter.                                                                                                                                                                                                                                                                                                                                     |
| `@langchain/textsplitters`, `@langchain/core` (peer dep)                 | Standalone chunking utilities (`RecursiveCharacterTextSplitter`, `TokenTextSplitter`) — the one narrowly-scoped piece of LangChain adopted, per the "only if it provides clear value" constraint. The full LangChain agent/chain framework is deliberately **not** adopted, to avoid an unnecessary abstraction layer over what is otherwise a straightforward, fully-owned pipeline. |
| `simple-git`                                                             | Shells out to `git` for `MarkdownGitRepoLoaderAdapter` (clone/pull the `docker/docs` repo and future domain repos).                                                                                                                                                                                                                                                                   |
| `cheerio`                                                                | HTML parsing, for a future `WebCrawlerLoaderAdapter` instance (e.g., a domain only available as rendered HTML, not a git repo).                                                                                                                                                                                                                                                       |
| `gray-matter`                                                            | Frontmatter parsing for Markdown documents.                                                                                                                                                                                                                                                                                                                                           |
| `js-tiktoken`                                                            | Token counting for chunk sizing and LLM cost estimation.                                                                                                                                                                                                                                                                                                                              |
| `p-limit`                                                                | Concurrency limiting for embedding batch calls, layered under BullMQ's own rate limiting.                                                                                                                                                                                                                                                                                             |
| `uuid` (v7)                                                              | Time-sortable IDs for Postgres primary keys (better index locality than v4).                                                                                                                                                                                                                                                                                                          |
| `helmet`, `compression`                                                  | Standard Express security headers and response compression.                                                                                                                                                                                                                                                                                                                           |
| `@nestjs/throttler`                                                      | Rate limiting on public API endpoints.                                                                                                                                                                                                                                                                                                                                                |
| `jest`, `@nestjs/testing`, `supertest`                                   | Unit + e2e testing.                                                                                                                                                                                                                                                                                                                                                                   |
| `testcontainers`                                                         | Integration tests against real Postgres/Redis/Chroma in CI — the ports/adapters split makes these the _only_ tests that need real infra; everything else uses `libs/shared/testing` fakes.                                                                                                                                                                                            |
| `eslint`, `@typescript-eslint/*`, `eslint-plugin-boundaries`, `prettier` | Linting, formatting, and the module-boundary enforcement described in §4.                                                                                                                                                                                                                                                                                                             |
| `husky`, `lint-staged`                                                   | Pre-commit enforcement of lint/format/type-check.                                                                                                                                                                                                                                                                                                                                     |

---

## 6. Architectural Risks

1. **Domain leakage in retrieval** (a query against "docker" returns Kubernetes chunks) — mitigate by making the domain filter mandatory at the `VectorStorePort` level, never optional or applied only in app code.
2. **Embedding-model drift** silently breaking existing vectors when a model is upgraded — mitigate with versioned collection names (`{domain}__{model-version}`) and blue/green re-index before cutover.
3. **Prompt injection via crawled content** (a doc page contains adversarial instructions) — mitigate by framing retrieved text as inert data with explicit instruction-hierarchy in the system prompt, never concatenated as if it were trusted instruction.
4. **Heterogeneous chunking needs across future domains** (Docker Markdown vs. Terraform HCL vs. K8s YAML) — mitigate via the per-domain `ChunkingPort` strategy; never hard-code a single global splitter.
5. **Cost/latency blowup** from unbounded context windows or reflexive reranking on every query — mitigate with a token-budget guard on prompt assembly and conditional reranking only when top-k scores are ambiguous.
6. **Stale docs served with false confidence** — mitigate with an ingestion freshness SLA and a "last verified" timestamp surfaced in citations.
7. **Queue backpressure against provider rate limits** during large re-crawls — mitigate with BullMQ's built-in rate limiter plus a dead-letter queue, not naive retry loops.
8. **LLM/embedding non-determinism breaking testability** — mitigate with deterministic fake adapters (in `libs/shared/testing`) for unit tests, and isolate real-provider calls to a small, separately-run contract/smoke test suite.
9. **Postgres/vector-store ledger divergence** (a failed job leaves orphaned vectors with no Postgres record, or vice versa) — mitigate with a periodic reconciliation job diffing the chunk ledger against vector-store IDs.
10. **One domain's bad crawl starving ingestion capacity for all domains** — mitigate with per-domain BullMQ queues and per-domain vector collections, isolating failure domains from each other.

---

## 7. Coding Standards & Conventions

- **Strict TypeScript**: `strict: true`, `noImplicitAny`, `exactOptionalPropertyTypes`; no `any` — use `unknown` and parse at boundaries with `zod`.
- **Ports named `XPort`**, defined as interfaces inside the consuming domain lib; bound to adapters via `Symbol`-based DI tokens (never string tokens, to get compile-time + IDE traceability).
- **One adapter per external system per file** — no adapter implements more than one port.
- **DTOs are never domain entities.** HTTP-layer DTOs (validated with `class-validator`) are mapped to/from domain VOs at the controller boundary; ORM entities (Prisma models) are mapped to/from domain entities inside repository adapters. Neither leaks past its layer.
- **Domain errors** extend a single `DomainError` base (in `libs/shared/kernel`), caught by one global NestJS exception filter that maps them to `application/problem+json` HTTP responses — no ad hoc `throw new Error(...)` in domain/application code.
- **Structured logging with correlation IDs** on every log line (via `nestjs-cls` + `nestjs-pino`), secrets redacted at the logger config level, never string-interpolated into messages.
- **Module boundary rule**: a lib may only import another lib's `index.ts` barrel export — no deep imports into another lib's internals — enforced by `eslint-plugin-boundaries` and package `exports` maps.
- **Conventional Commits**, enforced via `commitlint` in the `husky` pre-commit/commit-msg hooks alongside lint-staged.
- **Coverage targets**: 80%+ on domain/application layers (pure logic, fast, no I/O); adapters covered by `testcontainers`-backed contract tests against real Postgres/Redis/Chroma in CI, not mocked in their own test suite (mocks belong in the _consumers_ of ports, via `libs/shared/testing` fakes).

---

## 8. Scaling to Millions of Document Chunks

- **Embedding throughput**: batch calls to the embedding provider's max batch size, concurrency-capped via BullMQ's rate limiter tuned to the provider's TPM/RPM, exponential backoff on 429s.
- **Partitioning**: primarily via one vector collection per domain (§2); a single domain that itself grows very large can be further sub-partitioned by doc-version/shard using the same `{domain}__{version}` naming convention — not needed at Docker-docs scale today, but the naming scheme leaves room for it.
- **Incremental re-ingestion via content hashing** (§3) is the largest cost lever: re-crawls only touch changed pages/chunks, not the whole corpus.
- **Caching**: Redis caches query embeddings, full answers, and (optionally) pre-rerank top-k results to absorb repeated-question load.
- **Horizontal scaling**: `apps/api` is fully stateless (session/context lives in Postgres/Redis, never in-process) and scales on CPU/RPS behind a load balancer; `apps/ingestion-worker` scales independently on **queue depth** (e.g., autoscaling on BullMQ/Redis list length), not CPU, since ingestion is bursty (large re-crawls) rather than steady-state.
- **Postgres connection pooling**: PgBouncer in transaction-pooling mode in front of Postgres, since many short-lived worker connections would otherwise exhaust connection limits as ingestion workers scale out.
- **RAG-specific observability**: retrieval latency p50/p95/p99 per domain (isolated from LLM/rerank latency), BullMQ queue depth and job age (a direct backpressure signal), token spend per domain/API key, embedding-cache hit rate, and per-domain ingestion lag (time since last successful crawl).
- **Concrete migration trigger off Chroma**: move a domain's collection to Qdrant (or `pgvector`, if the team prefers staying inside Postgres) when that domain's collection exceeds roughly 2M vectors, or p95 similarity-search latency exceeds 300ms at current query volume, or sharded/read-replica availability becomes an SLA requirement. Because the vector store sits behind `VectorStorePort` with one collection per domain, this migration touches exactly one domain's adapter binding — every other domain, and all of Retrieval/Generation/Conversation, is unaffected.

---

## 9. Proof of Extensibility: Adding Kubernetes Later

To add a Kubernetes documentation domain once this architecture is built:

1. Insert one new `KnowledgeDomain` row: `{slug: 'kubernetes', source: {loaderAdapterKey: 'markdown-git-repo', loaderConfig: {repo: 'kubernetes/website', ...}}, chunking: {...}, embedding: {...}, vectorStore: {collectionName: 'kubernetes__<model-version>'}}`.
2. If Kubernetes docs are also Markdown in a git repo (they are), **zero new adapter code** is needed — `MarkdownGitRepoLoaderAdapter` is reused with different config, exactly as designed in §2.
3. Retrieval, Generation, Conversation, and the API layer require **no changes** — they are already parameterized by `domainId`/`domainSlug` and contain no Docker-specific logic anywhere.
4. If Kubernetes YAML manifests eventually need a different chunking approach than Markdown prose, only `ChunkingPort` gets a new strategy implementation registered against that domain's config — every other domain's chunking is untouched.

This is the concrete test the whole design is built to pass: **the only Docker-specific artifact anywhere in the system is a config row and a git URL.**

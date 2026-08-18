# Vector Storage & Retrieval Foundation — Design (M4)

**Scope:** the next bounded context after Embedding Infrastructure (M3) — persisting `EmbeddingRecord`s (JSONL artifacts produced by `EmbeddingPipelineService`) into a real, queryable vector store, and building the first retrieval path: embed a query, search the store, return normalized, provenance-rich results. This document is design-only, per explicit instruction: no source files are created or modified as part of it. Hybrid/lexical retrieval, BM25, score fusion, reranking, LLM generation, prompt assembly, conversation state, chat/HTTP API, SSE, authentication, and rate limiting are explicitly out of scope — those are M5+.

**Relationship to prior architecture docs:** [`rag-platform-architecture.md`](./rag-platform-architecture.md) (written 2026-08-05, before any real domain code existed) sketched a `VectorStorePort` (`ensureCollection`, `upsert`, `search`, `deleteByFilter`) and named Chroma as "priority #1." This document **supersedes that sketch** with a concrete, richer port; a database decision made from actual research rather than ease-of-installation; and the full identity/collection/indexing/retrieval design the platform doc left unspecified. It also **diverges from the platform doc's assumed infrastructure**: that doc assumed Postgres+Prisma, BullMQ, Redis, and an `apps/`/`libs/` monorepo would exist by the time retrieval was built. None of that exists. M1–M3 were built, deliberately and repeatedly, as a flat NestJS app with zero external services — ingestion, chunking, and embedding all run as synchronous CLIs against local files, with no queue, no cache, no relational database anywhere. This document does not fight that trajectory; it continues it. Where this document's recommendation differs from the platform doc, §2 says so explicitly.

---

## 0. Investigation — the existing system

Read directly from `src/chunking/chunking.types.ts`, `src/embedding/embedding.types.ts`, `src/embedding/embedding-provider.port.ts`, `src/embedding/embedding-pipeline.service.ts`, `src/embedding/embedding-batch-processor.service.ts`, `src/embedding/embedding-output-store.service.ts`, `src/embedding/embedding-config.service.ts`, `src/embedding/retry.util.ts`, `src/embedding/providers/*.ts`, `src/config/env.validation.ts`, `src/cli/embed.ts`, `src/cli/ingest.ts`, `src/common/`, `docs/architecture/*.md`, and every `*.spec.ts` alongside those, before designing anything below. The facts that drive this design:

1. **`EmbeddingRecord` is the correct, stable input contract**, already shaped for exactly this next step. `EmbeddingPipelineService.run()` writes one append-only `embeddings.jsonl` file per output directory (`EMBEDDING_OUTPUT_DIR`, default `./data/embedding-output`). Each `EmbeddingRecord` carries `embeddingId` (deterministic SHA-256 of `chunkId::contentHash::provider::model::modelVersion::dimensions`), `chunkId`, `documentId`, `sourcePath`, `vector`, `dimensions`, `provider`, `model`, `modelVersion`, `contentHash`, `inputHash`, `inputTokenCount`, `truncated`, `createdAt`. The embedding design doc explicitly anticipated this moment: _"`EmbeddingRecord`'s fields are spread flat... so that the thing written to disk and eventually bulk-upserted into a vector store by M4 stays a flat, directly-filterable JSON object... flat fields map to that with zero transformation."_ This document takes that anticipation at face value — the vector-store payload schema (§9) is a near-direct mapping of `EmbeddingRecord`'s own fields, not a redesign.
2. **`EmbeddingRecord` deliberately excludes the chunk's own text**, by explicit M3 design choice: _"M4's vector-store upsert can always re-join on `chunkId` against the `Chunk[]` JSON files if it needs the original text."_ M4 does exactly this join, once, at index time (§12) — not at query time, and not by duplicating text into the JSONL artifact.
3. **`Chunk`/`ChunkMetadata`/`ChunkRelationships`** (`chunking.types.ts`) already carry everything needed for provenance and parent/child assembly: `chunkId`, `text`, `metadata.{documentId, sourcePath, documentTitle, headingPath, chunkType, contentHash, ...}`, `relationships.{parentChunkId, childChunkIds, previousChunkId, nextChunkId}`. `chunkType: 'parent' | 'child'` and `parentChunkId` are the two fields the parent/child retrieval strategy (§13) is built on.
4. **`EmbeddingProviderPort`** (`embed(items, signal): Promise<...>`) is already provider-agnostic and already has four working implementations (`Voyage`, `OpenAi`, `Google`, `Fake`). M4's query-embedding step (§10) reuses this port directly — it does **not** define a new embedding abstraction, and does not add a fifth provider.
5. **Every existing bounded context follows one config convention with no exceptions**: a single zod schema in `src/config/env.validation.ts` (`envSchema`), wrapped by a dedicated `*ConfigService` exposing typed getters — nothing reads `process.env` directly. A drift-guard test (`src/config/env-example.spec.ts`) fails the suite if `.env.example`'s keys don't exactly match the schema's keys (a known, pre-existing, non-blocking gap already tracked from M1–M3.1). This module follows the same convention exactly (§16).
6. **Error-handling convention, three times over**: `IngestionPipelineService` isolates per-file failures and aborts only past a 50% threshold (`IngestionThresholdExceededError`); `EmbeddingBatchProcessorService` mirrors this per-batch (`EmbeddingThresholdExceededError`, configurable via `EMBEDDING_FAILURE_THRESHOLD`); both share one retry taxonomy shape (`TransientXError` → retried with backoff+jitter, `PermanentXError` → not retried, a validation error → not retried). This module's indexing pipeline (§12) is the third application of the identical philosophy, and reuses the retry mechanism itself rather than re-deriving it (§6.1).
7. **Idempotency via deterministic IDs, not a separate ledger, is the established pattern.** `EmbeddingOutputStoreService` has no manifest file — the JSONL output itself, keyed by deterministic `embeddingId`, _is_ the checkpoint. This document's identity strategy (§8) extends the exact same `embeddingId` to become the vector store's own point ID, so the same "no second source of truth" property holds one layer further down the pipeline.
8. **Provider/model provenance mismatches already have a guard, twice.** `EmbeddingOutputStoreService.loadExistingEmbeddingIds()` throws a clear error if an existing `embeddings.jsonl`'s recorded `provider`/`model`/`modelVersion`/`dimensions` don't match the current run's config (added as a final-review fix during M3). `createEmbeddingProvider`'s DI factory throws if a real provider is selected with no API key. This document's indexing pipeline (§11) and retrieval service (§10) each add a **third and fourth** instance of the identical "loud, fail-fast, provenance-guard" pattern — never a silent mismatch.
9. **Real embeddings exist, but only 90 of them, from Google's `gemini-embedding-2`, at 768 dimensions.** `data/embedding-output-google-smoke-test/embeddings.jsonl` (gitignored) has 90 real records; every other embedding ever produced in this project used `EMBEDDING_PROVIDER=fake` (a deterministic SHA-256-derived vector, explicitly documented as non-semantic). This document's validation rules (§11, §16) treat `provider: 'fake'` as a first-class, clearly-identifiable value that must never be silently mixed with real vectors in the same collection — the collection-naming strategy (§9) makes this structurally impossible, not just documented.
10. **No project-level `CLAUDE.md` exists.** No `apps/`/`libs/` monorepo exists — the project is still, deliberately, a single flat NestJS app (confirmed unchanged since the platform doc's 2026-08-05 note). No Postgres, Redis, BullMQ, or any database driver exists in `package.json` today. No Docker Compose file exists yet.
11. **CLI convention, three times over**: `src/cli/ingest.ts` and `src/cli/embed.ts` are both a small, self-contained `NestFactory.createApplicationContext` bootstrap (their own tiny `@Module`, not `AppModule`), wired with `ConfigModule.forRoot({validate: validateEnv})` + `LoggerModule.forRootAsync(...)` + the one feature module needed, reading a positional CLI arg, calling one pipeline-service method, printing the JSON result, and setting `process.exitCode = 1` on failure. `jest`'s `collectCoverageFrom` already excludes `"!cli/**"`. This module's two new CLIs (§13, §14) copy this shape exactly.

---

## 1. Bounded-Context Design

Two new, separate feature folders — mirroring how `chunking`/`embedding` are separate modules even though `embedding` consumes `chunking`'s types:

- **`src/vector-store/`** — owns persistence: the port, the adapters, the indexing pipeline that turns `EmbeddingRecord`s (plus a text join against `Chunk[]` files) into stored, searchable vectors.
- **`src/retrieval/`** — owns the query path: embed a query via the existing `EmbeddingProviderPort`, search via `VectorStorePort`, assemble parent context, return normalized results. Consumes both `EmbeddingProviderPort` (from `embedding`) and `VectorStorePort` (from `vector-store`) — never imports `qdrant`/database SDK types directly.

**Must NOT do** (hard constraints from the milestone brief, enforced by the module boundary below):

- Implement hybrid/lexical retrieval, BM25, score fusion, or reranking — `VectorStorePort` (§7) deliberately excludes these, exactly as `rag-platform-architecture.md` §2 already decided ("expose them later as optional capability interfaces... checked at runtime").
- Call an LLM, build a generation prompt, or return anything conversation-shaped.
- Expose an HTTP endpoint. Both the indexer and the retriever are invoked only via CLI (§13, §14) in M4, exactly as `IngestionPipelineService`/`ChunkingPipelineService`/`EmbeddingPipelineService` are today.
- Duplicate `EmbeddingProviderPort`, `withRetry`, or the error-taxonomy _shape_ — §6.1 relocates and generalizes the one utility that's genuinely identical in both contexts; everything else is a new, module-scoped implementation of an already-proven _pattern_, not new logic invented from scratch.
- Introduce Postgres, Prisma, BullMQ, or Redis. See §2 for why.

---

## 2. Architecture Decision: Vector Database Only (Option A)

The milestone brief poses this explicitly: (A) vector database only, (B) Postgres+pgvector as primary persistence, (C) Postgres for metadata + a dedicated vector DB, (D) another architecture.

**Recommendation: Option A — a vector database only, no Postgres, no second database.**

**Reasoning, from this project's actual state, not from familiarity or convention:**

1. **There is no existing relational need today.** The brief lists documents, chunks, embeddings, metadata, source provenance, document versions, domains, indexing state, re-indexing, deletion, retrieval as the "eventual" needs of the full system — but M4 only needs to serve **retrieval**, and every one of the other needs (conversation history in M6, a `KnowledgeDomain` registry once a second domain exists, ingestion job state if/when ingestion becomes async) is speculative today. This project's own track record is unusually consistent on this exact question: the original platform doc's own monorepo/BullMQ/Postgres/Redis assumptions were explicitly deferred at the start of M1 ("restructuring... before any real domain code exists would mean moving files based on a structure with no content yet to validate it against"), and M2/M3 each independently re-derived the same conclusion for their own scope (chunking's design doc: _"not implemented now because the current, measured corpus size does not warrant it"_; embedding's design doc: _"no database introduced for this milestone... a real database-backed ledger becomes justified once M4/M5 need transactional guarantees across the embedding and vector-store write together"_). Introducing Postgres now, before a second consumer of relational storage exists, repeats the exact premature-infrastructure mistake this project has three times already, explicitly, chosen not to make.
2. **A modern vector database's payload storage already covers M4's entire provenance need.** §9's payload schema is a flat JSON object attached to every point — documentId, chunkId, parentChunkId, chunkType, contentHash, headingPath, sourcePath, documentTitle, domain, provider/model/version/dimensions, plus the joined chunk text. This is not a workaround; it is the same "flat, directly-filterable" design `EmbeddingRecord` itself already committed to in M3 specifically anticipating this step (§0.1).
3. **Two databases add real operational cost with no present payoff.** Option C's stated rationale — "Postgres for metadata + dedicated vector DB" — only pays for itself once the metadata store is doing something the vector DB's payload genuinely cannot: cross-domain relational joins, transactional multi-table writes, or serving structured queries unrelated to a specific chunk's vector. None of that exists yet. Running two stateful services in local dev (and eventually production) for a system that currently needs one is the "introduce two databases without a clear architectural reason" the brief explicitly warns against.
4. **This does not foreclose Option C later — it names the actual trigger.** §17 (re-indexing) and §19 (model migration) both note the concrete point where a relational ledger becomes justified: once ingestion becomes asynchronous/queue-driven (multiple workers racing to update shared job state) or once conversation history (M6) needs transactional guarantees a vector store's payload can't offer. Until then, adding Postgres is optionality nobody has asked for yet, at the cost of a second service every developer must run locally and every deployment must operate.
5. **Not choosing pgvector-as-Postgres avoids sneaking Option B in as Option C's foundation.** Because this project has zero existing Postgres, pgvector cannot claim "you already have Postgres" as an advantage (§3's research explicitly confirms this) — choosing it here means opting into everything Option C would cost, for the vector-search feature alone. If Postgres is genuinely warranted later for relational needs, evaluating pgvector _at that time_, informed by real relational requirements, is a better-timed decision than pre-committing to it now for a reason (relational metadata) that doesn't exist yet.

**What this means concretely:** one vector database service, one payload schema, one point ID scheme, one CLI-driven indexing pipeline, exactly mirroring the "one JSONL file, no manifest" resumability philosophy `EmbeddingOutputStoreService` already established. If a second domain, async ingestion, or conversation state later creates a genuine relational need, that is a new, focused decision made with real requirements in hand — not a speculative one made now.

---

## 3. Vector Database Comparison

Researched against this project's actual state (zero existing databases, 30,016 real chunks today, explicit 1M+ target, self-hosted-first, NestJS+TypeScript) as of 2026-08-17. Four candidates evaluated — the three named in the brief plus **Weaviate**, included because its native hybrid-search maturity is directly relevant to a RAG platform's near-future roadmap even though hybrid search itself is out of scope for M4.

|                                          | **Qdrant**                                                                                                                      | **PostgreSQL + pgvector**                                                                                                                                               | **Chroma**                                                                                                                                             | **Weaviate**                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| **License**                              | Apache 2.0, fully self-hostable free                                                                                            | PostgreSQL license (permissive); pgvector Postgres-license too                                                                                                          | Apache 2.0 (core)                                                                                                                                      | BSD-3-Clause                                                                                                                   |
| **TS/Node client**                       | Official `@qdrant/js-client-rest`, native `fetch`, co-released with server, full typed API                                      | Mature via `pg`/Drizzle/Prisma; Drizzle has first-class typed `vector()` column + distance functions                                                                    | Official `chromadb` npm, recently rewritten (v3), solid                                                                                                | Official `weaviate-client` v3 (GA), gRPC-powered; GraphQL/gRPC dual-surface adds ergonomic wrinkle                             |
| **Metadata filtering**                   | Rich; filters applied _during_ HNSW graph traversal (correct pre-filtering), nested AND/OR/NOT                                  | Full SQL/WHERE power, but "overfiltering" is a known pitfall pre-0.8's iterative-scan mitigation; planner can silently fall back to seq-scan                            | Adequate (`$and`/`$or`, `where_document`); less rich, limited substring matching                                                                       | Rich, nested, comparable to or better than Qdrant for complex combos                                                           |
| **Scale: 30K today**                     | Trivial, no tuning                                                                                                              | Trivial, no tuning                                                                                                                                                      | Trivial, no tuning                                                                                                                                     | Trivial, no tuning                                                                                                             |
| **Scale: 1M+ target**                    | Purpose-built; sub-20ms cited even at billion-scale with INT8/binary quantization                                               | Comfortable to ~10-50M; "loses competitiveness" well past 100M absent DiskANN-style paging (which pgvector lacks)                                                       | **Its own ecosystem's consensus: not recommended past ~1-5M** — explicitly positioned for dev speed, not this project's stated scale target            | Solid, but independent 2026 benchmarks show Qdrant with materially better raw latency/predictability at 1M vectors             |
| **Ops complexity (this project, today)** | Low — single official Docker image, unsecured-by-default local dev in under a minute, clean collection model                    | Postgres itself is boring/mature, but **this project has no existing instance** — standing one up is a net-new service; VACUUM/HNSW-tombstone overhead grows with scale | Real footguns: `IS_PERSISTENT` defaults to false (silent data loss risk), no native HA/clustering in OSS, historically rocky persistence               | Moderate — more schema/module surface than Qdrant; GraphQL default-fusion-algorithm changed silently once (an upgrade footgun) |
| **Hybrid/BM25 future path**              | Native sparse vectors + server-side BM25/IDF (v1.15+), RRF/DBSF fusion in one Query API call                                    | Native `tsvector`, but TF-IDF-like `ts_rank`, not true BM25 without an extra extension                                                                                  | Recently added sparse-vector support (2026) — real but newer/less proven                                                                               | **Best-in-class** — native dense+BM25 fusion is the product's core differentiator                                              |
| **Production maturity**                  | ~34K GitHub stars, active weekly-ish releases (v1.19.0 Aug 2026), documented enterprise case studies, native Prometheus/Grafana | Genuinely production-grade at real scale (Supabase, Neon, Instacart cited); ecosystem consensus: right choice under ~10-50M                                             | Mixed/cautious — "production story has improved... but still trails Qdrant/Weaviate for serious workloads"; little independent 10M+ war-story evidence | Production-proven (~16.7K stars), smaller ecosystem than Qdrant, GA backup/restore                                             |
| **Observability**                        | Native Prometheus/OpenMetrics + official Grafana dashboard, per-search-path latency histograms                                  | Standard Postgres tooling (`pg_stat_statements`, `EXPLAIN ANALYZE`) reused; no native ANN-recall metric, must build app-level                                           | Traces only (OpenTelemetry), no native metrics endpoint                                                                                                | Reasonable but less documented depth than Qdrant's                                                                             |
| **Migration cost / lock-in**             | Snapshot-based Migration Tool; `scroll` API for full manual export                                                              | Lowest lock-in of any option — it's SQL; trivially portable                                                                                                             | Simple `get()` export; low lock-in                                                                                                                     | Less first-party export tooling documented                                                                                     |
| **Cost (self-hosted)**                   | Free (OSS); optional managed tier if ever needed                                                                                | Cheapest infra footprint (one lightweight container)                                                                                                                    | Free; embedded mode needs zero infra for dev                                                                                                           | Free (OSS); managed tiers pricier                                                                                              |
| **Local dev experience**                 | `docker run -p 6333:6333 ... qdrant/qdrant` — under a minute                                                                    | Mature but requires the extension-install step + schema design (no "collections" concept)                                                                               | **Best-in-class** — true embedded/in-process mode, zero infra                                                                                          | Comparable effort to Qdrant                                                                                                    |

### Weighted Decision Matrix

Weights reflect this project's actual priorities, in order: production maturity at the stated 1M+ scale target is the single highest-stakes criterion (a wrong choice here is the most expensive to unwind); TypeScript integration, operational simplicity, and metadata filtering are all directly load-bearing for M4's own deliverables; hybrid-search future-compatibility and cost matter but are secondary since hybrid is explicitly deferred to M5; migration risk, observability, and backup maturity are real but lower-stakes given all four candidates clear a reasonable bar.

| Criterion                             | Weight   | Qdrant   | pgvector | Chroma   | Weaviate |
| ------------------------------------- | -------- | -------- | -------- | -------- | -------- |
| Production maturity & scale to 1M+    | 20%      | 5        | 4        | 2        | 4        |
| TypeScript/Node integration           | 15%      | 5        | 4        | 4        | 3        |
| Operational complexity (this project) | 15%      | 5        | 3        | 2        | 3        |
| Metadata filtering richness           | 15%      | 5        | 4        | 3        | 5        |
| Hybrid/BM25 future compatibility      | 10%      | 4        | 4        | 3        | 5        |
| Cost (self-hosted)                    | 10%      | 4        | 5        | 5        | 4        |
| Migration cost / lock-in              | 5%       | 4        | 5        | 4        | 3        |
| Observability                         | 5%       | 5        | 3        | 2        | 3        |
| Persistence / backup maturity         | 5%       | 4        | 5        | 2        | 4        |
| **Weighted total**                    | **100%** | **4.70** | **4.00** | **2.95** | **3.85** |

(Scores are 1–5, this document's own judgment applied to the research findings above, not an external benchmark score — shown so the reasoning is auditable and contestable, not asserted as authoritative.)

### Recommendation: Qdrant, self-hosted via Docker

**Why Qdrant wins on this project's actual requirements, not on ease of installation:**

1. It is the only candidate purpose-built for, and independently benchmarked at, the project's explicitly stated 1M+ scale target with sub-20ms latency achievable via documented quantization — the single highest-weighted criterion.
2. Its filtering model is architecturally correct for this project's exact near-future need (domain/document/chunk-type filtering combined with vector search in one call, filtered _during_ ANN traversal rather than post-filtered) — directly serves §15.
3. Its official TypeScript client is co-released with the server, uses native `fetch` (matching this project's existing zero-new-HTTP-client-dependency convention from all three embedding adapters), and needs no ORM/schema-migration layer the way pgvector does.
4. Local dev is a single `docker run`, matching this project's demonstrated preference for the lowest-friction path that still meets the real requirement (contrast: Chroma is _lower_-friction but explicitly not recommended at this project's target scale by its own ecosystem).
5. Native Prometheus metrics give M4 a real observability foundation for free, ahead of M10's fuller pass.

**Why the others are rejected for this project, briefly:**

- **pgvector** is the strongest _runner-up_, not a weak option — genuinely production-grade to ~10-50M vectors, cheapest to run, and lowest lock-in. It loses here specifically because this project has **no existing Postgres to amortize the decision against** (§2, §3) — its signature advantage doesn't apply, leaving a purpose-built vector database with better filtering-during-search architecture and a materially better scale/latency profile for the _same_ new-infrastructure cost. If a genuine relational need emerges later (§2 point 4), pgvector is the first thing to re-evaluate — not because it's familiar, but because at that point its "reuse infra you already run" argument would actually hold.
- **Chroma** is rejected on the project's own stated future requirement, not on today's convenience: its own ecosystem's 2026 consensus is that it is not the right tool past roughly 1–5M vectors, and this project explicitly targets 1M+. Its best-in-class local-dev experience is real, but "easiest to install" is precisely the reasoning this document was instructed not to use.
- **Weaviate** is a legitimate, production-grade alternative and the clear leader on hybrid search specifically — but hybrid search is explicitly out of scope for M4 and belongs to M5. On every M4-relevant axis (raw scale/latency predictability, TypeScript client maturity, operational simplicity), independent 2026 comparisons put it a step behind Qdrant. If M5's hybrid-retrieval work later finds Qdrant's sparse-vector/BM25 support (§3, "Hybrid/BM25 future path") insufficient in practice, Weaviate is the named fallback candidate — a concrete, documented migration trigger, not a door closed here.

**Version pinned for this design:** `qdrant/qdrant:v1.19.0` (current stable as of 2026-08-17) — pinned, not `:latest`, matching this project's reproducibility conventions throughout (exact model versions, exact dependency versions named everywhere else in M1–M3).

---

## 4. Module / Folder Structure

```
src/
├── common/
│   ├── retry.util.ts                          # RELOCATED + generalized from src/embedding/ (§6.1)
│   └── retry.util.spec.ts
├── embedding/
│   └── retry.util.ts                            # DELETED — re-exported nowhere; embedding imports from ../common
├── vector-store/
│   ├── vector-store.types.ts                    # VectorPoint, VectorPayload, VectorSearchFilter/Query/Match, IndexRunResult
│   ├── vector-store.errors.ts                   # Transient/Permanent/ValidationError, ThresholdExceededError
│   ├── vector-store-id.util.ts                  # deriveVectorPointId(embeddingId): string
│   ├── vector-store-config.service.ts
│   ├── vector-store.port.ts                     # VECTOR_STORE_PORT symbol + interface
│   ├── vector-store-record-validator.util.ts    # validate EmbeddingRecord provenance before transform
│   ├── vector-store-record-transformer.util.ts  # EmbeddingRecord + Chunk[] (text join) -> VectorPoint
│   ├── indexing-batch-processor.service.ts      # retry/timeout/validation around one upsert batch
│   ├── indexing-pipeline.service.ts             # orchestrator: read, join, batch, upsert, resumability, stats
│   ├── vector-store.module.ts
│   ├── providers/
│   │   ├── fake-vector-store.adapter.ts         # in-memory Map, for unit tests everywhere upstream
│   │   ├── fake-vector-store.adapter.spec.ts
│   │   ├── qdrant-vector-store.adapter.ts
│   │   └── qdrant-vector-store.adapter.spec.ts
│   └── *.spec.ts alongside each file above
├── retrieval/
│   ├── retrieval.types.ts                       # RetrievalQuery, RetrievalFilter, RetrievalResult
│   ├── retrieval-config.service.ts
│   ├── retrieval.service.ts                     # query embed -> vector search -> parent context -> normalize
│   ├── retrieval.module.ts
│   └── *.spec.ts alongside each file above
└── cli/
    ├── index.ts                                  # `pnpm index` CLI
    └── query.ts                                  # `pnpm query` CLI

docker-compose.yml                                 # local Qdrant only — new, project-root
docs/architecture/
├── vector-storage-retrieval-design.md             # this document
└── vector-retrieval-smoke-test-runbook.md         # human-supervised benchmark (§21)

test/
├── vector-store.integration-spec.ts               # requires a running Qdrant — NEW test target (§20)
└── fixtures/vector-store/...
```

**Why two modules, not one:** `vector-store` knows nothing about embedding a query — it only stores and searches vectors it's handed. `retrieval` knows nothing about how vectors get _into_ the store — it only reads. This mirrors the existing `chunking`/`embedding` split exactly (embedding consumes chunking's types but chunking never imports embedding) and keeps `VectorStorePort` reusable by a future generation/reranking module without pulling in query-embedding concerns.

---

## 5. Shared Utility: Relocating `withRetry` (§6.1 referenced above)

`src/embedding/retry.util.ts`'s `withRetry<T>(fn, options)` is retry/backoff/jitter logic with **zero embedding-specific content** except its hardcoded `instanceof TransientEmbeddingProviderError` classification check. The indexing pipeline needs the identical exponential-backoff-with-jitter behavior against a _different_ error taxonomy (`TransientVectorStoreError`, not `TransientEmbeddingProviderError`). Two real options were weighed:

- **(a) Duplicate it** into `vector-store/`, mirroring how `embedding-input-builder.util.ts` deliberately duplicated a 3-line token-count heuristic to preserve embedding's independence from chunking.
- **(b) Generalize and relocate it** to `src/common/`, since no equivalent "must stay independent" constraint exists between `embedding` and `vector-store` the way M3 explicitly required for `embedding` vs. `chunking`.

**Decision: (b).** The token-heuristic duplication was justified by an explicit, milestone-level independence requirement ("embedding must stay completely independent of chunking"); no such requirement exists here, and the retry function is ~40 lines of real branching logic (backoff formula, jitter, `Retry-After` handling) — large enough that a second copy is a real drift risk, not a 3-line convenience. `src/common/` already exists as this project's shared-utility location (currently holding `filters/`), so this is a natural fit, not a new pattern.

**Change:** classification becomes an injected predicate rather than a hardcoded class check:

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
// withRetry's internal logic is otherwise byte-for-byte identical to today's
// embedding/retry.util.ts — same backoff formula, same 0.5x-1.0x jitter,
// same Retry-After-bypasses-jitter rule.
```

`embedding`'s call sites pass `isRetryable: (err) => err instanceof TransientEmbeddingProviderError` and `getRetryAfterMs: (err) => err instanceof RateLimitEmbeddingProviderError ? err.retryAfterMs : null` — behaviorally unchanged, now explicit instead of hardcoded. `vector-store` passes its own equivalent predicates. This is a mechanical, fully-tested refactor task (Task 1 of the implementation plan) with zero behavior change for `embedding`, verified by re-running `embedding`'s existing retry-dependent test suites unmodified.

---

## 6. `VectorStorePort` Design

```typescript
// src/vector-store/vector-store.port.ts
export const VECTOR_STORE_PORT = Symbol('VECTOR_STORE_PORT');

export interface VectorPoint {
  id: string; // derived from embeddingId — see §8
  vector: number[];
  payload: VectorPayload; // see §9
}

export interface VectorSearchFilter {
  domain?: string;
  documentId?: string;
  chunkType?: ChunkType; // 'parent' | 'child' — type-only import from chunking, same discipline as embedding
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

export interface VectorStorePort {
  ensureCollection(collection: string, dimensions: number): Promise<void>;
  collectionInfo(
    collection: string,
  ): Promise<{ dimensions: number; pointCount: number } | null>;
  upsert(collection: string, points: VectorPoint[]): Promise<void>;
  search(query: VectorSearchQuery): Promise<VectorSearchMatch[]>;
  deleteByFilter(
    collection: string,
    filter: VectorSearchFilter,
  ): Promise<number>;
}
```

**Why `VectorSearchFilter` is a small, closed, named-field type — not a passthrough object:** the milestone brief is explicit: _"Do not allow arbitrary unvalidated database filters to reach the adapter."_ This is the same discipline `EmbeddingProviderRequestItem`/`EmbeddingProviderResponseItem` already established in M3 (a purpose-built shape at the port boundary, never a raw provider request/response type leaking through). A future HTTP API (M6+) that accepts user-supplied filter parameters maps them into this exact type — never forwards a user-controlled object toward the database driver.

**Why `collectionInfo` exists:** it is the mechanism both the indexing pipeline (§11) and the retrieval service (§10) use to enforce the model/dimension-compatibility guarantee, mirroring `EmbeddingOutputStoreService`'s existing provenance-mismatch guard (§0.8) a third and fourth time.

**Why this port stays this small:** matching `rag-platform-architecture.md` §2's own explicit reasoning for `VectorStorePort` — hybrid search, native rerank, and index-tuning knobs "diverge too much across [vector databases] to force into one contract." Nothing here needs to change if a future capability interface (e.g. `SparseSearchCapability`) is added later, checked at runtime by a consumer that needs it.

---

## 7. Data Model / Payload Schema

```typescript
// src/vector-store/vector-store.types.ts
export interface VectorPayload {
  chunkId: string;
  documentId: string;
  parentChunkId: string | null;
  chunkType: ChunkType;
  contentHash: string;
  headingPath: string; // joined breadcrumb, e.g. "Install Docker Engine › On Ubuntu" — see rationale below
  documentTitle: string;
  sourcePath: string;
  domain: string; // 'docker' today; carried explicitly for future multi-domain filtering
  text: string; // the chunk's OWN full text — see §7.1
  parentText: string | null; // the resolved parent chunk's full text, pre-joined — see §13
  provider: string;
  model: string;
  modelVersion: string;
  dimensions: number;
  embeddingId: string; // redundant with the point's own id, kept in payload for debugging/filtering
  indexedAt: string; // ISO timestamp, informational only
}
```

**What's included and why, field by field:**

- `chunkId`, `documentId`, `contentHash` — direct from `Chunk`/`EmbeddingRecord`, needed for provenance and future re-indexing/staleness checks (§17).
- `parentChunkId`, `chunkType` — direct from `ChunkRelationships`/`ChunkMetadata`, drive the parent/child retrieval strategy (§13).
- `headingPath` — stored as the **joined breadcrumb string** (`headingPath.map(s => s.text).join(' › ')`), not the structured `HeadingPathSegment[]` array. This is a deliberate simplification: the breadcrumb is exactly what M3's `buildEmbeddingInput` already prepends to embedded text for retrieval-quality reasons (§0, embedding design doc §6), so it's already meaningful, human-readable, and citation-ready as a flat string. The structured array adds filtering/analysis value only if a future milestone needs to query "chunks under heading level 2" — not a stated M4 or near-future need. If that need arises, it is a small, additive field, not a redesign (a named, not implemented, extension point).
- `documentTitle`, `sourcePath` — direct from `ChunkMetadata`, needed for citations even before M5 exists (the retrieval smoke test benchmark, §21, needs these to be inspectable).
- `domain` — hardcoded to `'docker'` for M4 (there is exactly one domain), but present as a real field from day one so the collection-naming and filtering design (§9, §15) never needs to retrofit multi-domain support later — it is designed in from the start, per the milestone's own explicit multi-domain-readiness requirement, without building a `KnowledgeDomain` registry that has no second row to manage yet.
- `text` — **new to this document; not present on `EmbeddingRecord`.** §7.1 explains why this is a deliberate, justified deviation from M3's own "don't duplicate text" stance.
- `parentText` — the resolved parent chunk's full text, joined once at index time. See §13 for the full parent/child rationale; this field is what makes that strategy possible without a second storage system or a query-time filesystem dependency.
- `provider`, `model`, `modelVersion`, `dimensions` — direct from `EmbeddingRecord`, needed for the fake-vs-real guard (§16) and the collection-provenance check (§8, §9).
- `embeddingId` — the point's own `id` (§8) is _derived from_ this value; keeping the original string in the payload too costs nothing and helps debugging/manual inspection (e.g., `curl`-ing a point's payload directly shows the human-legible ID, not just its UUID form).

**What is deliberately _not_ here:** `inputHash`, `inputTokenCount`, `truncated` from `EmbeddingRecord` are **not carried into the payload** — they were specific to the _embedding-input-preparation_ step (did this exact text get truncated before being sent to the provider?) and have no bearing on retrieval or citation. Carrying them forward would be exactly the "duplicate data unnecessarily" the brief warns against, for fields nothing downstream reads.

### 7.1 Why chunk text lives in the vector store payload (a deliberate deviation from M3)

M3's design doc was explicit: `EmbeddingRecord` does not carry chunk text, specifically because "M4's vector-store upsert can always re-join on `chunkId` against the `Chunk[]` JSON files if it needs the original text... duplicating it here would violate 'do not duplicate information unnecessarily' for ~30,000 records' worth of text, most of which never needs to travel with the vector itself." That reasoning was correct **for the JSONL artifact** — an intermediate pipeline file, not the system's serving layer.

The vector store _is_ the serving layer. Every mainstream production RAG pattern stores passage text alongside its vector for exactly this reason: a query-time consumer (M5's generation step, M6's chat API, or this milestone's own retrieval smoke test) needs the actual passage without a second round-trip to a filesystem that may not even be mounted wherever that consumer runs (a future HTTP API, per `rag-platform-architecture.md`'s own stated `apps/api` deployment shape, should not need local chunk-output files present on disk just to answer a query). The join happens **once, at index time**, reading the same local chunk-output files the embedding pipeline already reads from — not duplicated per-query, not a recurring cost, and not a filesystem dependency at retrieval time.

**Named tradeoff, not ignored:** because each `'child'` chunk's payload also carries its resolved parent's full text (§13), and a section can have several child chunks, that parent text is duplicated across each of its children's payloads. At current scale (30,016 chunks, 14,387 eligible children) this is a bounded, small cost — vector-database payload storage is not the dominant cost driver at this scale (the vector index itself is). **Migration trigger, named explicitly:** if payload storage size becomes material at 1M+ scale (§22), the fix is a separate, small parent-text lookup keyed by `parentChunkId` (a second flat file or a lightweight KV store) fetched only on a match — a contained, additive change to the retrieval service, not a redesign of the indexing pipeline or payload schema.

---

## 8. Identity Strategy

**The vector point ID is derived from `embeddingId`, not invented fresh.** `embeddingId` already is exactly the identity this system needs: a deterministic SHA-256 hash of `chunkId::contentHash::provider::model::modelVersion::dimensions`. Re-embedding unchanged content with the same config produces the same `embeddingId`; a content edit, a model swap, or a version bump each correctly produce a _different_ one (§0.7 — this behavior is already built and tested in M3, unmodified here).

**Format conversion, not a new scheme:** Qdrant point IDs must be an unsigned 64-bit integer or a valid UUID string — an arbitrary 64-character hex string is not directly accepted. `embeddingId` is deterministically mapped to a UUID via a hand-rolled RFC 4122 §4.3 version-5 UUID derivation (SHA-1 of a fixed namespace + the `embeddingId` string, then the standard version/variant bit-twiddling) using only Node's built-in `crypto` module — no new `uuid` package dependency, matching this project's established "native Node APIs before a new dependency" convention (native `fetch` for all three embedding adapters, `node:crypto` for every hash in M1–M3):

```typescript
// src/vector-store/vector-store-id.util.ts
import { createHash } from 'node:crypto';

const NAMESPACE = 'f47ee6f2-30c1-4b1e-9e17-embedding-id-v5'; // fixed, arbitrary, never changes

// Deterministic RFC 4122 v5 UUID from embeddingId — same input always
// produces the same UUID, so this is a pure format conversion, not a new
// identity scheme. embeddingId itself remains the single source of truth
// and is kept in the payload (§7) for direct human/debugging lookup.
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

**What this gives, without any new bookkeeping:**

- **Idempotent upsert** — re-indexing the same `EmbeddingRecord` produces the same point ID and the same payload; Qdrant's upsert-by-ID semantics make this a harmless no-op overwrite, not a duplicate (§11, §17).
- **Re-embedding correctness** — a chunk edited and re-embedded gets a new `embeddingId` → a new point ID → a new point. The _old_ point (stale content) is not automatically removed; §17 names this explicitly as the stale-vector detection responsibility, not something silently handled by ID derivation alone.
- **Model migration correctness** — a model/version/dimension change produces entirely new `embeddingId`s → entirely new point IDs, which (per §9's collection-per-embedding-config naming) land in a _different collection_ — a structural, not just an ID-level, separation between incompatible vector spaces.

---

## 9. Collection / Index Strategy

**One collection per `(domain, provider, model, dimensions, modelVersion)` — not per document, not one shared collection with a domain filter.**

This both follows `rag-platform-architecture.md` §2's own already-endorsed reasoning (isolation, blast radius, per-collection index performance) and extends its naming scheme to be fully precise about embedding-model compatibility, since that platform doc predates M3's concrete `modelVersion` semantics:

```
{domain}__{provider}_{model}_{dimensions}d_v{modelVersion}
```

e.g. `docker__google_gemini-embedding-2_768d_v1`, sanitized to `[a-z0-9_]` (lowercased, non-alphanumeric characters replaced with `_`).

**Why `modelVersion` is part of the collection name, not just the point ID:** M3's design doc states a version bump is meant to force a full re-embed _specifically because_ "bumping it changes every chunk's `embeddingId`... which means the resumability check treats every chunk as new and re-embeds the whole corpus — the correct, intended effect of a version bump." If the resulting new-`embeddingId` points landed in the _same_ collection as the pre-bump points, the collection would silently accumulate both old and new vectors for the same content under different IDs — exactly the "uncontrolled duplicate" the milestone brief warns against. A separate collection per `modelVersion` makes the intended blue/green cutover (§19) structural: build the new collection fully, verify it, atomically repoint whatever consumes the collection name, then delete the old collection — never a mixed, ambiguous collection.

**Compatibility check, not just a naming convention:** before any upsert, the indexing pipeline calls `collectionInfo(collection)` (§6) and compares its reported `dimensions` against the `EmbeddingRecord`'s own `dimensions` — a mismatch is a loud, thrown error (`VectorStoreValidationError`), never a best-effort attempt. This is the third instance of the exact provenance-mismatch-guard pattern named in §0.8.

**Explicitly not done:** one collection per document (forbidden by the brief, and architecturally pointless at this project's scale — 1,508 documents would mean 1,508 tiny collections, defeating HNSW's own efficiency). One collection per embedding _batch_ or _run_ — collections represent a stable domain+model identity, not a job execution.

---

## 10. Query Embedding & the Model-Compatibility Guarantee

**Reuses `EmbeddingProviderPort` directly — no new embedding abstraction, no fifth provider.** `RetrievalService` is constructed with the _same_ `EMBEDDING_PROVIDER_PORT` DI token `embedding`'s own module already binds, via the _same_ `EmbeddingConfigService` (§0.4). There is exactly one embedding configuration active in the process at any time; the query and every indexed vector it's compared against are guaranteed to come from the same provider/model/dimensions **as long as the retrieval service is pointed at the collection whose name encodes that exact configuration** (§9).

**How mismatch is actually caught, explicitly, at each failure point the brief names:**

| Failure                                                                                                   | Where it's caught                                                                                                                                                                                                                                                           | How                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Model mismatch** (retrieval configured for a different model than the target collection was built with) | `RetrievalService.retrieve()`, before the search call                                                                                                                                                                                                                       | `collectionInfo(collection).dimensions` compared against the _current_ `EmbeddingConfigService.dimensions` — a mismatch throws `RetrievalConfigMismatchError` naming both configurations, mirroring `EmbeddingOutputStoreService`'s existing message shape exactly |
| **Dimension mismatch**                                                                                    | Same check as above — dimension is the one property both configs expose unambiguously, and it's the property that would otherwise cause a cryptic vector-store-level rejection                                                                                              |
| **Unavailable provider**                                                                                  | `EmbeddingProviderPort.embed()` throws its own existing `TransientEmbeddingProviderError`/`PermanentEmbeddingProviderError` — `RetrievalService` does not catch and swallow these; they propagate, exactly as `EmbeddingBatchProcessorService` already treats them upstream |
| **Provider errors** (rate limit, auth, 5xx)                                                               | Same — the existing, already-tested `withRetry` (relocated per §5) wraps the single query-embedding call with a small `maxAttempts` (query-time latency budget, not a bulk-indexing budget — configurable separately, §16)                                                  |
| **Invalid query** (empty string)                                                                          | `RetrievalService.retrieve()` validates non-empty, trimmed query text before calling the embedding provider at all — a clear `RetrievalValidationError`, never an empty-vector search                                                                                       |

---

## 11. Indexing Pipeline

```
EmbeddingRecord[] (read from *.jsonl in EMBEDDING_OUTPUT_DIR)
    │
    ▼
Filter: provider/model/modelVersion/dimensions match target collection's config (§9) — mismatch aborts the WHOLE run loudly, before any upsert
    │
    ▼
Filter: provider !== 'fake' when INDEXING_ALLOW_FAKE_PROVIDER is false (default) — see §16
    │
    ▼
For each eligible record: read the ORIGINAL Chunk[] file (chunkId -> chunk lookup, cached per document) — join full text + resolved parent text (§7.1, §13); null parentText if parentChunkId is null or the parent chunk cannot be found (logged at warn, not fatal)
    │
    ▼
validateVectorPoint() — non-empty vector, length === collection dimensions, every element finite (mirrors validateProviderResponse exactly, §0.6)
    │
    ▼
Filter: embeddingId (mapped via deriveVectorPointId) not yet confirmed present — see resumability note below
    │
    ▼
chunkArray(eligiblePoints, VECTOR_STORE_BATCH_SIZE) — default 200 (no external rate limit to respect, unlike embedding's conservative default of 128; local Qdrant write throughput is the only bound)
    │
    ▼
p-limit(VECTOR_STORE_MAX_CONCURRENT_BATCHES) — default 4
    │
    ▼
IndexingBatchProcessorService.processBatch() — withRetry(port.upsert(...)) + timeout race, mirrors EmbeddingBatchProcessorService exactly
    │
    ▼
Per-batch outcome recorded; failures isolated per-batch, never fatal to other batches
    │
    ▼
IndexRunResult — jobId, totalRecordsScanned, skippedByProvenanceMismatch, skippedFakeProvider, attempted, succeeded, failed, failures[], totalBatches, collection, durationMs
```

**Resumability, without a second ledger:** unlike embedding (where re-calling a real provider costs real money/quota and _must_ be skipped for already-embedded content), upserting to a local, self-hosted Qdrant instance is comparatively cheap — idempotent by ID (§8), no external cost, no rate limit. The pipeline therefore does **not** need a pre-flight "does the store already have this point" check for _correctness_ (re-upserting an unchanged point is a harmless no-op). For _efficiency_ at 1M+ scale, an optional lightweight resume marker is still worth having: `IndexingPipelineService` can (config-gated, `VECTOR_STORE_SKIP_EXISTING`, default `true`) call `search`/`scroll`-style existence checks in bulk per batch rather than per-point, or simply accept the idempotent-but-redundant cost of re-upserting a full run on resume — both are documented options, and the default favors simplicity (accept redundant re-upsert cost) unless real-corpus timing (§22) shows it matters. This is a deliberately lighter resumability story than M3's, justified by the fact that the expensive, quota-limited step (embedding) already happened and is not repeated here.

**Failure isolation and threshold, mirroring `EMBEDDING_FAILURE_THRESHOLD` exactly:** a batch's `upsert` call failing after retries (§0.6) marks every point in that batch as failed, not fatal to the run; `failures.length / attempted` exceeding `VECTOR_STORE_FAILURE_THRESHOLD` (default `0.5`) aborts the whole run via `VectorStoreThresholdExceededError` — the fourth application of this exact philosophy (ingestion → embedding-batch → embedding-run → indexing-run).

**Never require regenerating embeddings when only indexing fails, and vice versa:** because the indexer reads `embeddings.jsonl` as its input and never mutates it, an indexing failure (Qdrant down, a bad batch) is retried by re-running `pnpm index` alone — the embeddings are untouched, already on disk, already paid for. Symmetrically, an ingestion or chunking failure never requires re-running the embedding or indexing steps for documents it didn't touch, because each pipeline stage is already independently resumable by design (M1–M3's own established property, unchanged here).

---

## 12. Indexing Batch Processor

Structurally identical to `EmbeddingBatchProcessorService` (§0.6), with the DB-specific call swapped in:

```typescript
// src/vector-store/indexing-batch-processor.service.ts
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
        getRetryAfterMs: () => null, // vector stores don't send Retry-After; pure exponential backoff
      });
      return { batchId, succeededIds: points.map((p) => p.id), failed: [] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        { batchId, pointCount: points.length, error: message },
        'Index batch failed permanently after retries',
      );
      return {
        batchId,
        succeededIds: [],
        failed: points.map((p) => ({ chunkId: p.payload.chunkId, message })),
      };
    }
  }

  private upsertWithTimeout(
    collection: string,
    points: VectorPoint[],
  ): Promise<void> {
    /* Promise.race timeout, mirrors embedding exactly */
  }
}
```

---

## 13. Parent / Child Retrieval Strategy

**M4 baseline: search only `'child'`-type vectors (matching M3's own default embedding scope), but every returned result carries its resolved parent's full text pre-joined into the payload (§7).** This is a variant of the brief's option 4 ("store searchable child vectors but return parent context"), made concrete:

- Only `'child'` chunks are embedded by default today (`EMBEDDING_CHUNK_TYPES=child`) and this document does not change that — `'parent'` chunks remain "uncapped, whole-section text meant only for post-retrieval context expansion" exactly as M2's design doc defined them.
- Rather than _also_ indexing parent chunks as separate (unsearched) vector-store points — which would require either a real embedding call for arbitrarily-long parent text (defeating the cost/quality reason children-only embedding was chosen) or a placeholder/zero vector (awkward, and every vector database is search-first, not a natural fit for pure non-vector KV lookup) — the indexing pipeline resolves each child's `parentChunkId` **once, at index time**, against the same local `Chunk[]` files already being read for the child's own text (§11), and stores the parent's full text directly in that child's `parentText` payload field.
- **Result: one vector search call returns everything needed for parent-context expansion** — no second round-trip to the vector store, no separate lookup service, no query-time filesystem dependency.

**Why not the other options:**

1. _Return matched child only_ — throws away exactly the context M2's whole parent/child split exists to preserve; a child chunk alone is often too narrow (that's the entire reason `wasSplit`/size-bounding exists).
2. _Retrieve child then expand to parent as a second store call_ — correct in principle, but adds a query-time round-trip and a second point-lookup-by-ID call for every result, for context this document can resolve once, at index time, for free.
3. _Search parents and children independently_ — doubles indexing/search cost and reintroduces the exact "arbitrarily long parent text as a search target" problem M2 designed against; parent chunks were deliberately made non-searchable.

**Named tradeoff:** parent-text duplication across sibling children (§7.1) is the cost of this simplicity; §7.1 already names the concrete migration trigger if it becomes material.

**Reranking is explicitly not implemented** — `RetrievalResult` (§14) returns raw similarity-ranked matches; a future M5 rerank step consumes this list and reorders it, entirely outside this milestone's scope.

---

## 14. Retrieval Interface & `RetrievalResult`

```typescript
// src/retrieval/retrieval.types.ts
export interface RetrievalFilter {
  domain?: string;
  documentId?: string;
  sourcePath?: string;
  // deliberately NOT `chunkType` — retrieval always searches 'child' vectors
  // by internal convention (§13); exposing it would let a caller accidentally
  // search parent-typed points that were never meant to be vector-searched.
}

export interface RetrievalQuery {
  text: string;
  domain: string;
  topK: number;
  scoreThreshold?: number;
  filter?: RetrievalFilter;
  expandToParent?: boolean; // default true, per config (§16)
}

export interface RetrievalResult {
  chunkId: string;
  documentId: string;
  parentChunkId: string | null;
  chunkType: ChunkType;
  score: number;
  text: string; // the matched child's own full text
  parentText: string | null; // populated when expandToParent is true and a parent exists
  headingPath: string;
  documentTitle: string;
  sourcePath: string;
  domain: string;
}

export interface RetrievalService {
  retrieve(query: RetrievalQuery): Promise<RetrievalResult[]>;
}
```

**Never a database-specific object crosses this boundary** — `RetrievalService.retrieve()` internally calls `VectorStorePort.search()` (which itself never leaks a Qdrant SDK type, per §6) and maps `VectorSearchMatch[]` into `RetrievalResult[]`, dropping vector-store-internal fields (`embeddingId`, `provider`, `model`, `indexedAt`) that a retrieval consumer (M5's prompt assembly, M6's citations) has no use for — the same "DTOs are never domain entities... neither leaks past its layer" discipline `rag-platform-architecture.md` §7 already states as a project-wide convention.

---

## 15. Metadata Filtering

`RetrievalFilter` (§14) is the **only** shape a caller can supply; `RetrievalService` maps it directly into `VectorSearchFilter` (§6) — a 1:1, fully-validated mapping, never a passthrough. Both types are deliberately small today (`domain`, `documentId`, `sourcePath`) because those are the only filters with a real, named use case before a second domain or document-versioning exists:

- **`domain`** — mandatory in `RetrievalQuery` (not optional), mirroring `rag-platform-architecture.md`'s own architectural risk #1 ("domain leakage in retrieval... mitigate by making the domain filter mandatory at the `VectorStorePort` level, never optional"). Even with one domain today, the field is required so no code path can be written that forgets it once a second domain exists.
- **`documentId`** — supports the retrieval smoke test's own need to sanity-check "does this specific document's content come back for its own questions" (§21).
- **`sourcePath`** — useful for the same debugging/benchmark purpose, and free to expose since it's already a flat payload field.

**Explicitly deferred, not forgotten:** document-version filtering (no `Document` version concept exists yet — that's an Option-C-style relational need §2 names as a future trigger) and free-form chunk-metadata filtering (the brief's own "chunk metadata fields" — most `ChunkMetadata` fields like `wasSplit`/`wasMerged`/`exceedsMaxSize` are pipeline-internal facts with no retrieval-time relevance; adding a filter for them without a real query need would be exactly the "arbitrary unvalidated" surface the brief warns against, just self-inflicted instead of caller-inflicted).

---

## 16. Fake-vs-Real Provider Safety & Configuration Schema

**The system must never silently mix or misidentify fake and real vectors** — enforced structurally, not just documented, via two independent mechanisms:

1. **Collection naming already makes it structural** (§9): `EMBEDDING_PROVIDER=fake` produces collection names like `docker__fake_fake-model_4d_v1` — trivially distinguishable from `docker__google_gemini-embedding-2_768d_v1` by name alone, and a real query configured for the real collection can never accidentally search the fake one (different collection, full stop).
2. **An explicit guard, on by default:** `IndexingPipelineService` refuses to index `provider: 'fake'` records unless `VECTOR_STORE_ALLOW_FAKE_PROVIDER=true` is explicitly set (default `false`) — a fail-closed default, not fail-open, specifically because the milestone brief calls this out as a real risk ("fake embeddings must be clearly identifiable and must never accidentally be treated as production semantic vectors"). Development/testing against the fake provider remains fully supported — it's an explicit opt-in, not a blocked path.

New environment variables, added to the single zod schema in `src/config/env.validation.ts` (§0.5), each wrapped by a dedicated `*ConfigService` — the same convention as every prior milestone, never read via `process.env` directly:

| Env var                               | Type / default                              | Purpose                                                                                                  |
| ------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `VECTOR_STORE_PROVIDER`               | `'qdrant' \| 'fake'`, default `'qdrant'`    | Selects the `VectorStorePort` adapter — mirrors `EMBEDDING_PROVIDER`'s exact pattern                     |
| `VECTOR_STORE_URL`                    | `string`, default `'http://localhost:6333'` | Qdrant REST endpoint                                                                                     |
| `VECTOR_STORE_API_KEY`                | `string`, default `''`                      | Optional Qdrant API key — never logged, same convention as `EMBEDDING_API_KEY`                           |
| `VECTOR_STORE_DOMAIN`                 | `string`, default `'docker'`                | The domain slug used in collection naming (§9) and required in every `RetrievalQuery`                    |
| `VECTOR_STORE_BATCH_SIZE`             | `number`, default `200`                     | Points per upsert call                                                                                   |
| `VECTOR_STORE_MAX_CONCURRENT_BATCHES` | `number`, default `4`                       | `p-limit` concurrency for indexing                                                                       |
| `VECTOR_STORE_MAX_RETRIES`            | `number`, default `5`                       | Max retry attempts per failed batch                                                                      |
| `VECTOR_STORE_RETRY_BASE_DELAY_MS`    | `number`, default `200`                     | Backoff base (indexing is local, so a smaller base than embedding's `500` is appropriate)                |
| `VECTOR_STORE_RETRY_MAX_DELAY_MS`     | `number`, default `10000`                   | Backoff cap                                                                                              |
| `VECTOR_STORE_REQUEST_TIMEOUT_MS`     | `number`, default `10000`                   | Per-batch upsert timeout                                                                                 |
| `VECTOR_STORE_FAILURE_THRESHOLD`      | `number` (0–1), default `0.5`               | Fraction of attempted points that may fail before the run aborts — mirrors `EMBEDDING_FAILURE_THRESHOLD` |
| `VECTOR_STORE_SKIP_EXISTING`          | `boolean`, default `true`                   | Whether to attempt bulk existence pre-checks for indexing efficiency (§11)                               |
| `VECTOR_STORE_ALLOW_FAKE_PROVIDER`    | `boolean`, default `false`                  | Fail-closed guard against accidentally indexing fake vectors as if real                                  |
| `RETRIEVAL_DEFAULT_TOP_K`             | `number`, default `10`                      | Default `topK` when a caller doesn't specify one                                                         |
| `RETRIEVAL_MAX_TOP_K`                 | `number`, default `100`                     | Hard ceiling — rejects/clamps oversized queries (§23)                                                    |
| `RETRIEVAL_SCORE_THRESHOLD`           | `number`, default `0` (no threshold)        | Default minimum similarity score                                                                         |
| `RETRIEVAL_EXPAND_TO_PARENT`          | `boolean`, default `true`                   | Whether `retrieve()` populates `parentText` by default                                                   |
| `RETRIEVAL_REQUEST_TIMEOUT_MS`        | `number`, default `10000`                   | Query-time embed+search latency budget                                                                   |
| `RETRIEVAL_MAX_RETRIES`               | `number`, default `2`                       | Small — a user-facing query path should fail fast, not retry as patiently as a bulk indexing job         |

`EMBEDDING_INCLUDE_HEADING_CONTEXT`-style boolean footgun avoided the same way M3 already established (`z.union([z.boolean(), z.enum(['true','false'])])`, never bare `z.coerce.boolean()`) — every new boolean field above follows that exact pattern. `.env.example` additions are subject to the same, already-known, pre-existing permission constraint (§0.5) — the implementation plan documents the exact lines for manual addition, exactly as every prior milestone's plan has.

---

## 17. Re-Indexing, Deletion, and Stale-Vector Detection

**Lifecycle operations, each named explicitly:**

- **Initial indexing** — `pnpm index` against a fresh `embeddings.jsonl`, target collection created via `ensureCollection` if absent.
- **Incremental indexing** — re-running `pnpm index` after a _new_ embedding run (new documents/chunks embedded, existing ones unchanged) naturally only adds new points; existing points are idempotently re-upserted (§8) at worst, never duplicated.
- **Re-indexing after a content edit** — a chunk's `contentHash` changes → re-embedding produces a new `embeddingId` → indexing produces a _new_ point alongside the _old, now-stale_ one (§8's explicitly-named limitation). **Stale-vector detection**, since there is no separate ledger (§2) to consult: a `pnpm index --prune-stale <documentId>` mode scrolls all points in the target collection filtered by `documentId`, compares their `chunkId` set against the _current_ `Chunk[]` file for that document, and deletes (via `deleteByFilter`) any point whose `chunkId` no longer appears in the current chunk output — i.e., any point representing a chunk that no longer exists (was merged, removed, or superseded). This is a deliberate, explicit, opt-in reconciliation step — never run silently as part of ordinary indexing, since deletion is inherently higher-stakes than upsert.
- **Deletion** — `deleteByFilter(collection, filter)` supports the same explicit deletion for a removed document (`filter: {documentId}`) or an entire stale collection (dropping the collection itself once a blue/green cutover, §19, is verified complete).
- **Embedding-model migration** — covered fully in §19.
- **Collection/index migration** (moving data to a differently-versioned or differently-provisioned Qdrant instance) — Qdrant's own snapshot/Migration Tool (§3) is the mechanism; this project's responsibility is limited to re-running `pnpm index` against the new instance if a snapshot-based migration isn't available, since indexing is fully idempotent and re-derivable from `embeddings.jsonl` at any time.

---

## 18. Deletion Strategy

Two explicit deletion entry points, both requiring an explicit, named filter — never an unscoped "delete everything" default:

1. **`deleteByFilter(collection, {documentId})`** — removes every point for a specific document, used when a document is removed from the corpus (a re-ingestion scenario) or as part of `--prune-stale` (§17).
2. **Collection drop** — an entire collection is deleted only as the final step of a verified blue/green cutover (§19) or an explicit operator decision; never automated as part of ordinary indexing runs.

Both are logged at `info` with the exact filter and the count of points actually deleted (`deleteByFilter`'s return value, §6) — a deletion with an unexpectedly high or low count is exactly the kind of signal an operator needs surfaced, not swallowed.

---

## 19. Model Migration Strategy

Building directly on §9's collection-per-embedding-config naming, blue/green migration is structural, not a special procedure invented separately:

1. Update `EMBEDDING_MODEL`/`EMBEDDING_MODEL_VERSION`/`EMBEDDING_DIMENSIONS` config and re-run `pnpm embed` — M3's own existing resumability means this naturally re-embeds the _whole_ corpus (a version/model/dimension change forces new `embeddingId`s for every chunk, per M3's own design intent, §0.7).
2. Run `pnpm index` against the new `embeddings.jsonl` output — since the collection name (§9) is derived from the _new_ provider/model/dimensions/version, this targets a **brand-new collection**, built in parallel; the old collection is completely untouched throughout.
3. Validate the new collection (run the retrieval smoke test, §21, against it).
4. **Cutover**: `RETRIEVAL_*` config (specifically, whatever resolves the active collection name — derived from the active `EmbeddingConfigService` values) is updated to point at the new collection. Since collection name derivation is a pure function of config already in use for indexing, this is the same config change, not a separate migration script.
5. Once traffic/validation confirms the new collection is correct, the old collection is dropped (§18) — a deliberate, manual, final step, not automatic.

This is "zero/minimal-downtime where practical," per the milestone's own phrasing — practical here because there is no shared mutable state between old and new collections at any point in the process; the only genuinely manual step is human judgment on when to cut over and when it's safe to delete the old collection.

---

## 20. Local Development

**New: `docker-compose.yml` at the project root** (first Compose file this project has ever had — everything through M3 ran with zero external services):

```yaml
services:
  qdrant:
    image: qdrant/qdrant:v1.19.0
    ports:
      - '6333:6333' # REST
      - '6334:6334' # gRPC (unused by this project's client today, exposed for future use / the Qdrant dashboard)
    volumes:
      - qdrant_storage:/qdrant/storage
volumes:
  qdrant_storage:
```

Pinned to a specific version (§3), matching this project's reproducibility conventions elsewhere. No auth/TLS configured — correct for local dev (§23 names this explicitly as a must-fix-before-shared-deployment item, not an oversight).

**The reproducible local workflow, documented in full in the implementation plan and in a new `docs/architecture/vector-retrieval-smoke-test-runbook.md` (§21):**

1. `docker compose up -d qdrant` — starts the vector database.
2. `pnpm build && pnpm index ./data/embedding-output` — creates the collection (if absent) and indexes every eligible `EmbeddingRecord`.
3. `pnpm query "How do I install Docker on Ubuntu?"` — embeds the query, searches, prints ranked `RetrievalResult[]` as JSON.
4. Inspect results — either via the CLI's own printed JSON, or directly against Qdrant's REST API / bundled web dashboard at `http://localhost:6333/dashboard`.
5. `docker compose down -v` — resets the local store completely (drops the volume) for a clean-slate re-run.

---

## 21. Real Docker Retrieval Benchmark

A new, human-supervised runbook (`docs/architecture/vector-retrieval-smoke-test-runbook.md`), mirroring the structure and rigor of the existing Google embedding smoke-test runbook exactly (a real precedent, not a new pattern): a documented command, a documented expectation, a documented "what to check," and an explicit non-claim of quality from mere successful execution.

**Benchmark questions** (from the milestone brief, verbatim — chosen because each has a knowably-correct answer somewhere in the real Docker corpus, making "did the right chunk come back" a checkable fact, not a subjective judgment call):

- What is the difference between CMD and ENTRYPOINT?
- How do Docker volumes differ from bind mounts?
- How does bridge networking work?
- What does `COPY --from` do?
- How does Docker Compose healthcheck work?
- What is the difference between ARG and ENV?

**For each query, `pnpm query "<question>"` is run and the following is recorded** (mirroring the observability fields in §24 exactly, since the CLI output _is_ those fields): `topK` results returned, each result's similarity score, `documentId`/`chunkId`/`sourcePath`/`headingPath`, and a human judgment — does at least one of the top-K results actually address the question? (A yes/no per query, plus notes — e.g., "correct document, but the `CMD`/`ENTRYPOINT` distinction chunk ranked 3rd, not 1st" is a real, useful, recorded finding, not a pass/fail flattening.)

**Explicit non-claim, stated directly in the runbook itself:** a successful vector search (no errors, plausible-looking scores) is not evidence of retrieval _quality_ — only running the benchmark and checking whether the right content actually surfaces is. This baseline (which queries work well today, which don't) is the concrete input M5's hybrid-retrieval and reranking work is measured against — a documented "before" state, not a vague intention.

---

## 22. Performance Analysis

**Current scale (30,016 total chunks, 14,387 eligible `'child'` chunks — the real, measured M3 corpus figures):**

- **Indexing throughput:** unlike embedding, there is no external rate limit to respect — the bottleneck is local network round-trip + Qdrant's own HNSW insertion cost per point. At `VECTOR_STORE_BATCH_SIZE=200` and `VECTOR_STORE_MAX_CONCURRENT_BATCHES=4`, indexing the full 14,387-chunk corpus is expected to complete in low tens of seconds on a local machine (by comparison, M3's 14,387-chunk fake-provider embedding run — itself with zero network latency — completed in ~2 seconds for a much smaller per-item payload; a real vector+payload upsert is heavier per item, but still processes far faster than the embedding step it follows, which is rate-limited by an external API).
- **Query latency:** at 14,387 vectors, Qdrant's own published figures (§3) suggest single-digit-millisecond search latency is achievable even unquantized — current scale is not a meaningful performance concern at all.
- **Memory:** 14,387 vectors × 768 dimensions × 4 bytes ≈ 44MB of raw vector data, plus HNSW graph overhead (typically 1.5–2x raw) — well under 100MB total. Negligible on any modern machine.
- **Storage:** Qdrant's on-disk footprint (WAL + segments + payload) will exceed the raw JSONL file size somewhat, due to index structures — expected and acceptable at this scale.

**Future scale (1M+ chunks) — expected bottlenecks, named without prematurely solving them:**

- **Memory** becomes the first real constraint: 1M × 768 × 4 bytes ≈ 3GB raw vector data; with HNSW graph and payload overhead, realistically 6–10GB to keep fully in-memory (directionally consistent with the pgvector research's own cited 6–8GB/1M-vector figure, §3). **Migration trigger, named explicitly:** enable Qdrant's scalar (INT8) or binary quantization (§3) once memory provisioning becomes a real constraint — not implemented now, since current scale doesn't warrant it, per the same "prove it first" philosophy applied throughout M1–M3.
- **Indexing throughput at 1M+** will take meaningfully longer than "tens of seconds" — a batch-size/concurrency tuning pass is the first lever, well before considering architectural changes.
- **Index build time** for a fresh collection at 1M+ is a real, multi-minute-to-hour-scale operation (consistent with pgvector's own cited HNSW-build-time figures at comparable scale, §3) — relevant to planning a model-migration cutover window (§19), not a blocker to M4 itself.
- **Concurrent queries** — not a concern until an actual concurrent-query load exists (there is no HTTP API yet); noted as a forward-looking consideration for M6, not solved here.
- **Metadata filtering at scale** — Qdrant's filter-during-traversal architecture (§3) is specifically why it was chosen over pgvector's overfiltering-pitfall profile; no additional work needed for this to hold at 1M+, per the research already gathered.

**Explicitly not done:** no quantization, no sharding, no connection pooling tuning — none of it warranted by the current, measured 14,387-chunk real-corpus scale. Every deferred item above is a named, concrete trigger, not an unaddressed gap.

---

## 23. Observability

Every injectable in this module follows the existing, exception-free logging convention (§0): constructor-injects `PinoLogger`, `this.logger.setContext(ClassName.name)`, structured objects first, message second — no new logging pattern introduced.

| Event                          | Level   | Fields (never full document/chunk text, never `VECTOR_STORE_API_KEY`)                                                                                                                                       |
| ------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Indexing run started           | `info`  | `jobId`, `collection`, `provider`, `model`, `dimensions`                                                                                                                                                    |
| Index batch completed          | `info`  | `jobId`, `batchId`, `pointCount`, `succeeded`, `failed`, `durationMs`                                                                                                                                       |
| Index batch failed permanently | `warn`  | `jobId`, `batchId`, `pointCount`, `error` (message only, never a raw point payload)                                                                                                                         |
| Indexing run completed         | `info`  | full `IndexRunResult` minus `failures` (logged separately, one line per failure)                                                                                                                            |
| Retrieval query executed       | `info`  | `queryId`, `domain`, `collection`, `topK`, `resultCount`, `highestScore`, `durationMs`, `provider`, `model` — **never the query text itself**, consistent with never logging user-supplied content verbatim |
| Retrieval config mismatch      | `error` | `expectedProvider`/`expectedModel`/`expectedDimensions` vs. `actualProvider`/`actualModel`/`actualDimensions`                                                                                               |

**M10 extension point, prepared now, mirroring M3's own stated pattern exactly:** every count on `IndexRunResult` is already a plain number on a plain object, ready to forward to a metrics backend without internal changes. Qdrant's own native Prometheus metrics (§3) are a second, complementary observability source available from day one — this project's own structured logs cover the application-level pipeline; Qdrant's own `/metrics` endpoint covers the database's internal state (query latency histograms, segment counts) — the two are not redundant.

---

## 24. Security

- **Database credentials:** `VECTOR_STORE_API_KEY` follows the exact `EMBEDDING_API_KEY` convention — validated config only, never logged, never in an error message (§16).
- **Untrusted query filters:** `RetrievalFilter`'s small, closed shape (§15) is the entire defense — no code path anywhere accepts a raw filter object and forwards it to `VectorStorePort`.
- **Malformed vectors:** `validateVectorPoint()` (§11) checks length and finiteness before every upsert, mirroring `validateProviderResponse` exactly (§0.6) — a malformed vector is a loud validation error, never silently accepted, truncated, or padded (the milestone brief's own explicit requirement).
- **Resource exhaustion / oversized queries:** `RETRIEVAL_MAX_TOP_K` (§16) is a hard ceiling — a caller-requested `topK` above this is rejected, not silently clamped (an explicit `RetrievalValidationError`, so a caller learns their request was invalid rather than getting fewer results than expected with no explanation).
- **Connection security:** local dev is deliberately unsecured (§20) — this is documented as a dev-only posture, with an explicit note that a shared or production deployment must enable Qdrant's API-key auth and TLS before that happens. This is a named, not-yet-needed item, not a silent gap.
- **Secret handling:** every new secret-shaped config value goes through the same zod-validated, `*ConfigService`-wrapped path as every existing secret in this project (§16) — no second configuration mechanism, per the milestone's own explicit constraint.

---

## 25. Testing Strategy

**Unit tests — no running external database, ever**, per the milestone's explicit requirement. Every unit test uses `FakeVectorStoreAdapter` (an in-memory `Map`-based implementation of `VectorStorePort`, mirroring `FakeEmbeddingProvider`'s exact role and shape):

- `vector-store-id.util.spec.ts` — deterministic UUID derivation; same input always produces the same output; different `embeddingId` inputs produce different UUIDs; output is a well-formed v5 UUID (version/variant nibbles correct).
- `vector-store-record-validator.util.spec.ts` — table-driven: valid record passes; provider/model/modelVersion/dimensions mismatch against target collection each throws `VectorStoreValidationError`; `provider: 'fake'` without the explicit allow-flag throws; empty/non-finite vector throws.
- `vector-store-record-transformer.util.spec.ts` — `EmbeddingRecord` + a real `Chunk[]` fixture correctly produces a `VectorPoint` with joined `text`/`parentText`; a chunk with `parentChunkId: null` produces `parentText: null`; a chunk whose parent cannot be found in the fixture logs a warning and produces `parentText: null` (not a thrown error).
- `indexing-batch-processor.service.spec.ts` — mirrors `embedding-batch-processor.service.spec.ts`'s exact test list (success, retry-then-succeed, permanent failure fails the whole batch, retry-exhaustion fails the whole batch, timeout classified as transient, never throws out of `processBatch` itself) against `FakeVectorStoreAdapter`.
- `indexing-pipeline.service.spec.ts` — mirrors `embedding-pipeline.service.spec.ts`'s exact test list (accounting invariant, resumability via idempotent re-upsert, threshold-exceeded abort, fake-provider guard, provenance-mismatch guard) against `FakeVectorStoreAdapter` + real temp-directory `Chunk[]`/`EmbeddingRecord` fixtures.
- `retrieval.service.spec.ts` — query embedding via `FakeEmbeddingProvider` + search via `FakeVectorStoreAdapter`; empty-query validation; model/dimension-mismatch guard; `expandToParent` true/false; `RetrievalFilter` correctly maps to `VectorSearchFilter`; oversized `topK` rejected.
- `qdrant-vector-store.adapter.spec.ts` — mocks `global.fetch` exactly like the three embedding adapters (`jest.spyOn(global, 'fetch')`), asserting request shape/auth header per operation (`ensureCollection`, `upsert`, `search`, `deleteByFilter`, `collectionInfo`) and the same error-mapping table (auth → permanent, 429/5xx → transient, network rejection → transient with `cause`) — no real Qdrant instance involved.

**Integration tests — require a real, running Qdrant**, a genuinely new pattern for this project (no prior milestone had one), introduced deliberately and narrowly:

- New script: `"test:integration": "jest --config ./test/jest-integration.json"` (a new Jest config, separate from `test:e2e`, which today has zero external-service dependencies and should keep that property for every contributor who hasn't run `docker compose up`).
- `test/vector-store.integration-spec.ts` — against a real local Qdrant (from `docker-compose.yml`, §20): collection creation (`ensureCollection` is idempotent — calling it twice doesn't error), real upsert, idempotency (upserting the same point twice results in exactly one point, not two), deletion by filter, real similarity search returns sensible nearest-neighbor ordering for hand-crafted near-identical vs. far-apart vectors, filter combined with search correctly excludes non-matching points.
- Documented prerequisite, stated plainly in the test file's own header comment and in the local-dev runbook (§20): `docker compose up -d qdrant` must be running before `pnpm test:integration`; the suite fails fast with a clear connection-refused message otherwise, not a cryptic timeout.

**Failure-case tests** (split across unit — mocked — and integration — real — as appropriate):

- Database unavailable → `TransientVectorStoreError`, retried, eventually surfaces as a batch failure (unit, via a fake that throws; integration, by pointing the adapter at a wrong port).
- Timeout → same transient classification (unit, via `FakeVectorStoreAdapter`'s configurable delay, mirroring `FakeEmbeddingProvider`'s `delayMs` option exactly).
- Malformed `EmbeddingRecord` (missing/wrong-typed fields) → caught by the record validator before any transform is attempted (unit).
- Dimension mismatch, model mismatch → `VectorStoreValidationError` / `RetrievalConfigMismatchError` (unit, table-driven).
- Duplicate record (same `embeddingId` upserted twice) → exactly one point, not two (unit against the fake; integration against real Qdrant, since this is the one behavior worth confirming against the real system's actual upsert semantics, not just the fake's).
- Partial batch failure → isolated, doesn't abort other batches, correctly aggregated into `IndexRunResult.failures` (unit).
- Retryable vs. permanent error classification → table-driven against the same `withRetry` predicate pattern already proven in `embedding` (unit).

---

## 26. M5 Integration Boundary

M4 leaves exactly this clean baseline for M5 to build on, per the milestone brief's own diagram:

```
Query
  │
  ▼
Query Embedding (EmbeddingProviderPort, reused)
  │
  ▼
Vector Similarity Search (VectorStorePort, 'child'-only, single collection)
  │
  ▼
Metadata Filtering (RetrievalFilter — domain/documentId/sourcePath)
  │
  ▼
Normalized RetrievalResult[] (chunk + parent text, provenance, score)
```

M5 adds hybrid/lexical retrieval, BM25, score fusion, improved strategies, and retrieval evaluation **on top of** this baseline — none of which requires touching `VectorStorePort`'s shape (§6 already anticipated exactly this, mirroring the platform doc's own "capability interface" escape hatch) or `RetrievalResult`'s shape (already carries everything M5/M6/M7 need: chunk text, parent text, score, full provenance). If M5's own work later finds Qdrant's native sparse-vector support (§3) insufficient for its hybrid-search needs, Weaviate is the already-evaluated, named fallback (§3) — not a decision made from scratch at that point.

---

## 27. Risks and Tradeoffs

1. **No relational ledger means stale-vector cleanup is opt-in, not automatic** (§17) — a real operational responsibility a future Postgres-backed reconciliation job (per `rag-platform-architecture.md`'s own architectural-risk #9) would eventually automate. Named as the concrete trigger for revisiting Option A vs. Option C (§2), not ignored.
2. **Parent-text duplication across sibling children** (§7.1) is a real, bounded storage cost, with a named migration trigger if it becomes material at 1M+ scale.
3. **Resumability for indexing is lighter than embedding's** (§11) — correct by construction (idempotent upsert) but potentially inefficient (redundant re-upserts on a resumed run) at large scale; the config-gated bulk-existence-check option is named but its exact implementation is left to real-corpus timing data, not designed further than necessary today.
4. **Qdrant's own noted flags from research** (§3): one unconfirmed anecdotal data-loss report (mitigated by testing this project's own backup/restore path before relying on it in any shared environment) and a known delete-by-filter/concurrent-upsert race (mitigated by this project's own indexing pipeline never running concurrent filtered-deletes against a live ingest path — `--prune-stale`, §17, is an explicit, standalone, non-concurrent operation).
5. **A new test-execution pattern** (`pnpm test:integration` requiring real infrastructure, §25) is a genuine first for this project — mitigated by keeping it fully separate from `pnpm test`/`pnpm test:e2e`, so no existing contributor workflow is disrupted by the new requirement.
6. **Choosing Qdrant over pgvector forecloses, for now, the "one database for everything eventually" simplicity** pgvector would have offered if a relational need existed today. This is an accepted tradeoff (§2, §3) — revisit if and when that relational need becomes real, not before.

---

## 28. Step-by-Step Implementation Sequence

Fully detailed, TDD-bite-sized, in the companion implementation plan: `docs/superpowers/plans/2026-08-17-vector-storage-retrieval-plan.md`. Sequence, at a glance:

1. Relocate + generalize `withRetry` into `src/common/` (§5) — zero behavior change for `embedding`, verified by its own existing test suite.
2. Vector-store domain types, error taxonomy, deterministic point-ID derivation (§7, §8).
3. `VectorStoreConfigService` + env schema extension (§16).
4. `VectorStorePort` + `FakeVectorStoreAdapter` (§6).
5. Record validator + transformer, including the parent-text join (§7.1, §11, §13).
6. `IndexingBatchProcessorService` (§12).
7. `IndexingPipelineService` orchestrator (§11).
8. `QdrantVectorStoreAdapter` (§3, §6) + its mocked-fetch test suite.
9. `VectorStoreModule` DI wiring + provider factory (`qdrant` vs `fake`).
10. `pnpm index` CLI (§20).
11. Retrieval domain types + `RetrievalConfigService` (§14, §16).
12. `RetrievalService` — query embedding, search, parent expansion, model-compatibility guard (§10, §13, §14).
13. `RetrievalModule` DI wiring.
14. `pnpm query` CLI (§20).
15. `docker-compose.yml` + local-dev documentation (§20).
16. Integration test suite against real Qdrant (§25) — new `test:integration` script.
17. Real Docker retrieval smoke-test runbook + human-supervised execution (§21) — mirrors the Google embedding smoke test's own two-part structure (build/test everything against fakes and mocks first, then one final human-supervised real-system run).

---

## 29. Definition of Done

- All 17 tasks in the companion implementation plan complete, each independently reviewed (per this project's established subagent-driven-development process).
- `pnpm build`, `pnpm lint`, `pnpm test` all clean (the one known, pre-existing, unrelated `.env.example` drift-guard failure aside — not a regression this milestone introduces, and this milestone's own new env vars are documented for manual addition exactly as every prior milestone's were).
- `pnpm test:integration` passes against a real local Qdrant instance.
- `pnpm index` successfully indexes the full real corpus (14,387 real `'child'` chunks) — using the **fake provider's** embeddings by default (matching M3's own fake-only verification precedent, since no full real-embedding run of the whole corpus exists yet, only 90 real Google-embedded chunks) — with `attempted === succeeded` and zero unexpected failures.
- `pnpm query` successfully runs against the indexed collection and returns well-formed `RetrievalResult[]`.
- The real Docker retrieval smoke-test runbook (§21) has been executed at least once, human-supervised, against real semantic vectors (the 90 real Google-embedded chunks, or a larger real run if more real embeddings exist by then), with its findings — which questions retrieved well, which didn't — recorded, not just "it ran without errors."
- No Postgres, Redis, BullMQ, or second database of any kind was introduced.
- No hybrid/lexical retrieval, BM25, reranking, LLM call, prompt assembly, conversation state, HTTP API, SSE, authentication, or rate limiting was implemented.

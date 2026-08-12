# Embedding Infrastructure — Design (M3)

**Scope:** the next bounded context after Semantic Chunking — transforming a `Chunk` (produced by `ChunkingPipelineService`, see [`semantic-chunking-design.md`](./semantic-chunking-design.md)) into a deterministic, provenance-rich `EmbeddingRecord` holding a real vector from a configurable embedding provider. This document is design-only, per explicit instruction: no source files are created or modified as part of it. Vector storage, retrieval, reranking, LLM generation, conversation, and the HTTP API are explicitly out of scope — those are M4+.

**Relationship to the platform architecture:** [`rag-platform-architecture.md`](./rag-platform-architecture.md) sketches an `EmbeddingProviderPort` (`embed(texts: string[]): Promise<number[][]>`) and names `chromadb`/OpenAI as likely choices. This document supersedes that sketch with a concrete, richer port (id-correlated request/response items, not bare string arrays — see §6), a named provider recommendation backed by current benchmarks/pricing (§3–4), and the full batching/retry/resumability machinery the platform doc left unspecified. It does not change the platform doc's higher-level bounded-context map.

---

## 0. Investigation — the existing system

Read directly from `src/chunking/chunking.types.ts`, `chunking-pipeline.service.ts`, `chunking-config.service.ts`, `chunking.errors.ts`, `chunking.module.ts`, `length-measurer.ts`, `src/config/env.validation.ts`, `src/config/app-config.service.ts`, `src/config/pino-http-options.factory.ts`, `src/common/filters/global-exception.filter.ts`, `src/ingestion/ingestion.errors.ts`, and every `*.spec.ts` alongside those, before designing anything below. The facts that drive this design:

1. **`Chunk` is already the correct, stable input contract.** `ChunkingPipelineService.chunk()` writes one `{documentId}.chunks.json` array per document to `CHUNKING_OUTPUT_DIR` (default `./data/chunks-output`). Each `Chunk` (`chunking.types.ts:62-67`) carries `chunkId` (deterministic SHA-256, collision-free as of the `occurrenceIndex` fix verified against the full 1,508-document / 30,016-chunk real corpus), `text` (the literal Markdown, heading line included), and `metadata.contentHash` (SHA-256 of `text`). This module needs nothing more from Chunking than these three fields plus `metadata.documentId`, `metadata.sourcePath`, `metadata.chunkType`, and `metadata.headingPath` — all of which are already public, stable fields. **No change to the chunking module is needed or proposed.**
2. **`chunkType: 'parent' | 'child'` already encodes exactly the split this module needs.** `'child'`-type chunks are the size-bounded leaf units meant for search; `'parent'`-type chunks are uncapped, whole-section text meant only for post-retrieval context expansion (`semantic-chunking-design.md` §2.2). Nothing about a `'parent'` chunk makes it a good embedding target — it is arbitrarily long (by design) and would either blow a model's input-token limit or, if truncated, throw away most of its own value. **Design consequence (§7):** only `'child'`-type chunks are embedded by default.
3. **Every existing bounded context follows one config convention with no exceptions:** a single zod schema in `src/config/env.validation.ts` (`envSchema`), wrapped by a dedicated `*ConfigService` (`ChunkingConfigService`, `IngestionConfigService`, `AppConfigService`) exposing typed getters — nothing reads `process.env` directly. A drift-guard test (`src/config/env-example.spec.ts`) fails the suite if `.env.example`'s keys don't exactly match the schema's keys. **This module follows the same convention exactly** (§15).
4. **Every existing bounded context follows one DI-port convention when — and only when — a second implementation is a near-certain future need**, not speculatively (`semantic-chunking-design.md` §1.4 states this explicitly: `LengthMeasurerPort` is a real port because a tokenizer swap is foreseeable; everything else is a concrete class). `LENGTH_MEASURER_PORT` (`length-measurer.ts:1`) is the exact precedent this module's `EMBEDDING_PROVIDER_PORT` follows: a `Symbol`-based DI token, an interface, a factory keyed off config, injected via `@Inject(TOKEN)`. **This module deliberately does _not_ import `LengthMeasurerPort` from `src/chunking/`** — see §7's explicit rationale for why embedding input's own token estimation is a small, intentionally duplicated ~5-line function rather than a cross-module runtime dependency, preserving the milestone's hard requirement that this module stay "completely independent of ... chunking."
5. **Error-handling convention: per-unit isolation, a percentage-based abort threshold, never a silent swallow.** `IngestionPipelineService` isolates failures per file and only aborts the whole run via `IngestionThresholdExceededError` if `failedCount / matchedCount` exceeds 50% (`ingestion.errors.ts:20-29`). This module's `EmbeddingThresholdExceededError` (§7, §16) mirrors this exactly, including the "not swallowed, not fatal-per-item" philosophy.
6. **Logging convention, no exceptions found:** every injectable constructor-injects `PinoLogger` and calls `this.logger.setContext(ClassName.name)`; log calls pass a structured object first, a static message second (`this.logger.info({...}, 'message')`). Secrets are redacted only for HTTP request headers today (`pino-http-options.factory.ts:6`, `REDACT_PATHS`) — there is **no existing precedent for redacting an arbitrary application-level secret** (like an embedding API key) because no prior module has held one. §19 states the rule this module must originate: never construct a log object containing the API key, full stop — not a redact-list entry, because redact-lists only intercept HTTP request/response objects, not arbitrary `logger.info({...})` calls.
7. **CLI convention:** `src/cli/ingest.ts` is a small, self-contained `NestFactory.createApplicationContext` bootstrap (its own tiny `@Module`, not `AppModule`) wired with `ConfigModule.forRoot({validate: validateEnv})` + `LoggerModule.forRootAsync(...)` + the one feature module it needs, reads a positional CLI arg, calls one pipeline service method, prints the JSON result, and sets `process.exitCode = 1` on any failure count. `package.json`'s `"ingest": "node dist/cli/ingest.js"` script requires `pnpm build` first; `jest`'s `collectCoverageFrom` already excludes `"!cli/**"`. **This module's CLI (§20, plan Task 12) copies this shape exactly**, module-for-module.
8. **`Chunk[]` files already validated at full real-corpus scale this session:** 1,508 documents, 30,016 total chunks, 15,629 `'parent'` + 14,387 `'child'`, zero `chunkId` collisions, zero known bugs. **§17's performance analysis uses these exact, already-measured numbers** rather than estimates from scratch.
9. **No project-level `CLAUDE.md` exists** (only the user's global one, which sets general engineering-quality rules already reflected throughout this document and the accompanying plan).

---

## 1. Embedding Bounded-Context Design

**Responsibility:** convert `Chunk` records (read from `CHUNKING_OUTPUT_DIR`) into `EmbeddingRecord`s (a chunk's `chunkId`/`contentHash` + a real vector + full model/provider provenance), written to a local, resumable, idempotent JSONL output. Nothing more.

**Must NOT do** (hard constraints, restated from the milestone brief and enforced by the module boundary below):

- Write to, query, or import any vector-database client (`chromadb`, `@qdrant/js-client-rest`, `pg`) — that is `VectorStorePort`'s job, entirely out of scope, M4.
- Write to, query, or import Postgres/Prisma — no `DocumentMetadataRepositoryPort`/`KnowledgeDomainRepositoryPort` exists yet, and this module does not need one (§13 explains why local JSONL is sufficient for M3's resumability needs).
- Perform retrieval, reranking, or similarity search of any kind.
- Call an LLM or build a generation prompt.
- Expose an HTTP endpoint. `EmbeddingPipelineService` is invoked only via a CLI (§20) in M3, exactly as `IngestionPipelineService`/`ChunkingPipelineService` are today.
- Depend on chunking's _internal_ implementation. The only cross-module reference is a **type-only** import of `Chunk`/`ChunkMetadata`/`ChunkType`/`HeadingPathSegment` from `src/chunking/chunking.types.ts` — the identical discipline `semantic-chunking-design.md` §0 already established for chunking's own dependency on ingestion's `StructuredDocument` type. No runtime import of any chunking _service_ exists anywhere in this design.

**Provider-swap guarantee (the milestone's central architectural ask):** every provider-specific detail — auth header shape, request/response JSON shape, error-code mapping, base URL — lives inside one adapter class per provider, implementing `EmbeddingProviderPort` (§6). `EmbeddingPipelineService`, `EmbeddingBatchProcessorService`, the input builder, the retry util, and the output store never reference a provider by name or import a provider SDK. Swapping `EMBEDDING_PROVIDER=voyage` to `EMBEDDING_PROVIDER=openai` (or a future `EMBEDDING_PROVIDER=local`) changes zero pipeline code — only which adapter class the DI factory (§6, §20) instantiates. §11's second adapter (OpenAI) exists specifically to prove this guarantee with working code, not just an interface on paper.

---

## 2. Domain Models

```typescript
// embedding.types.ts

export interface EmbeddingModelMetadata {
  provider: string; // 'voyage' | 'openai' | 'fake' | future providers — not a closed union in the type
  // itself, so a new adapter never requires touching this shared type
  model: string; // e.g. 'voyage-code-3'
  modelVersion: string; // operator-controlled string (see below), NOT the provider's own version string
  dimensions: number;
}

export interface EmbeddingRecord {
  embeddingId: string; // deterministic, see §12
  chunkId: string; // copied verbatim from Chunk.chunkId — never re-derived
  documentId: string; // copied from Chunk.metadata.documentId
  sourcePath: string; // copied from Chunk.metadata.sourcePath — cheap traceability without a join
  vector: number[];
  dimensions: number;
  provider: string;
  model: string;
  modelVersion: string;
  contentHash: string; // copied from Chunk.metadata.contentHash — the chunk-content half of staleness detection
  inputHash: string; // SHA-256 of the exact text sent to the provider (post heading-context prefix,
  // whitespace normalization, and truncation) — the embedding-input half of
  // staleness detection; can differ from contentHash even when contentHash is
  // unchanged, e.g. if EMBEDDING_INCLUDE_HEADING_CONTEXT is flipped
  inputTokenCount: number; // per this module's own token estimate (§7) — for cost/throughput observability
  truncated: boolean; // true if the input was cut to fit EMBEDDING_INPUT_MAX_TOKENS
  createdAt: string; // ISO timestamp, informational only — excluded from embeddingId derivation (§12),
  // mirroring chunking's chunkedAt precedent exactly
}
```

**Why no separate `EmbeddingModelMetadata` field is duplicated 4 times inside `EmbeddingRecord`:** it is spread into 4 flat fields (`provider`, `model`, `modelVersion`, `dimensions`) rather than nested as `record.model: EmbeddingModelMetadata`, so that `EmbeddingRecord` — the thing written to disk and eventually bulk-upserted into a vector store by M4 — stays a flat, directly-filterable JSON object (`WHERE provider = 'voyage' AND model = 'voyage-code-3'`-style filtering is exactly what a vector store's metadata filter needs, and flat fields map to that with zero transformation).

**What is deliberately _not_ on `EmbeddingRecord`:** the chunk's own `text`, `headingPath`, or any other `ChunkMetadata` field. M4's vector-store upsert can always re-join on `chunkId` against the `Chunk[]` JSON files if it needs the original text (e.g., for a hybrid keyword+vector search later) — duplicating it here would violate "do not duplicate information unnecessarily" for ~30,000 records' worth of text, most of which never needs to travel with the vector itself.

**`modelVersion` is operator-controlled, not provider-reported, and this is intentional.** Voyage and OpenAI do not expose a machine-readable version string that changes when they silently update a model's underlying weights behind the same model name — this is a known, industry-wide embedding-provider behavior, not a gap in this design. `EMBEDDING_MODEL_VERSION` (§15) is a config value the operator bumps by hand whenever they have reason to believe the model's behavior changed (a provider changelog entry, a deliberate dimension change, or simply "re-embed everything to be safe"). Bumping it changes every chunk's `embeddingId` (§12), which means the resumability check (§13) treats every chunk as new and re-embeds the whole corpus — the correct, intended effect of a version bump.

---

## 3. Provider Comparison

|                                               | **OpenAI `text-embedding-3-large`**                                                                                         | **Voyage `voyage-3-large`**                                                                                                                                                                                                                                       | **Voyage `voyage-code-3`**                                                                                                                                                                                                                                                                                                                                  | **Local/self-hosted (e.g. BGE-M3, Nomic-Embed via a TEI server)**                                                                                                                                                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Technical-doc / general retrieval quality** | Strong, widely-benchmarked baseline.                                                                                        | Beats `text-embedding-3-large` by ~9.7% across 100 general-domain retrieval datasets (Voyage's published benchmark).                                                                                                                                              | Same lineage as `voyage-3-large`, specifically re-tuned for code.                                                                                                                                                                                                                                                                                           | Competitive on public leaderboards (MTEB) but no vendor is independently benchmarking these against Docker's specific doc mix; quality is "good, unverified for this corpus" rather than "measured better."                                                                          |
| **Docker/CLI/code-documentation suitability** | General-purpose; code and CLI-flag text is not a specialized training target.                                               | General-purpose, same caveat as OpenAI.                                                                                                                                                                                                                           | **Purpose-built for this exact content shape.** Beats `text-embedding-3-large` by 5–8 NDCG points specifically on code-retrieval benchmarks (CodeSearchNet-derived), and Docker's docs corpus is dense with CLI commands, Dockerfile snippets, YAML, and flag-reference tables — closer to "code" than "prose" for a meaningful fraction of every document. | Depends entirely on which base model is chosen; none has a code-specific variant as mature as `voyage-code-3`'s published benchmark story.                                                                                                                                           |
| **Dimensions**                                | 3072 default, or 1536 via the `dimensions` param (Matryoshka-style truncation) at unchanged API price but half the storage. | Matryoshka: 2048 / 1024 (default) / 512 / 256.                                                                                                                                                                                                                    | Matryoshka: 2048 / 1024 / 512 / 256 (first _k_ entries of the 2048-dim embedding are themselves a valid _k_-dim embedding).                                                                                                                                                                                                                                 | Fixed per model, typically 768–1024; no native Matryoshka truncation on most open models.                                                                                                                                                                                            |
| **Input/context limit**                       | 8,191 tokens/input.                                                                                                         | Not independently found in this pass's research; Voyage's v3-family models are documented in the tens-of-thousands-of-tokens range — **confirm the exact figure against `docs.voyageai.com` at implementation time** rather than trust an unverified number here. | Same caveat as `voyage-3-large` — confirm at implementation time.                                                                                                                                                                                                                                                                                           | Typically 512–8192 tokens depending on base model; must be checked per model chosen.                                                                                                                                                                                                 |
| **Latency**                                   | Low, mature global infra.                                                                                                   | Comparable; Voyage is API-only (no local inference option itself).                                                                                                                                                                                                | Comparable to `voyage-3-large`.                                                                                                                                                                                                                                                                                                                             | Depends entirely on self-hosted hardware — can be the fastest option (no network hop) or the slowest (CPU-only inference), operator-controlled either way.                                                                                                                           |
| **Cost**                                      | $0.13/M tokens ($0.065/M via Batch API).                                                                                    | $0.18/M tokens; first tranche of tokens free on newer Voyage model families per their pricing page.                                                                                                                                                               | Same pricing tier as `voyage-3-large` per Voyage's published pricing structure — **confirm the exact current figure at implementation time**, since Voyage revises tiers per model generation.                                                                                                                                                              | Infrastructure cost only (compute), no per-token fee — cheaper at very high volume, more expensive in ops burden at Docker-docs-corpus volume (§17 shows the real-provider cost is under $1 one-time for this corpus, which no self-hosting setup beats in total cost of ownership). |
| **Batching**                                  | Up to 2,048 embeddings/request.                                                                                             | 300 requests/min, 4M tokens/min (paid tier default).                                                                                                                                                                                                              | Same family limits as `voyage-3-large`.                                                                                                                                                                                                                                                                                                                     | Fully operator-controlled; can batch arbitrarily large if hardware allows, but throughput is hardware-bound rather than a documented API ceiling.                                                                                                                                    |
| **Rate limits**                               | Tiered by account spend history — generous at any real production tier.                                                     | 300 RPM / 4M TPM default, raisable on request.                                                                                                                                                                                                                    | Same.                                                                                                                                                                                                                                                                                                                                                       | None (self-imposed only) — but this "advantage" is irrelevant if self-hosted throughput is the actual bottleneck.                                                                                                                                                                    |
| **Operational complexity**                    | Zero infra — pure API call.                                                                                                 | Zero infra — pure API call.                                                                                                                                                                                                                                       | Zero infra — pure API call.                                                                                                                                                                                                                                                                                                                                 | Real infra burden: a hosted inference server (TEI/vLLM/Ollama), a GPU or accepting slow CPU inference, model updates/patching, uptime — a genuinely new operational surface this project has none of today (no queue, no worker process, no GPU anywhere in the stack).              |
| **Privacy / portability**                     | Data leaves the network to OpenAI.                                                                                          | Data leaves the network to Voyage.                                                                                                                                                                                                                                | Data leaves the network to Voyage.                                                                                                                                                                                                                                                                                                                          | **Best-in-class** — no data ever leaves the operator's infrastructure; the only option viable if Docker's docs (public, so moot today) were ever swapped for a domain with genuinely sensitive source material.                                                                      |
| **Production maturity**                       | Very high — OpenAI's embeddings API has years of production usage across the industry.                                      | High — used in production by multiple well-known RAG vendors; younger than OpenAI's offering but not experimental.                                                                                                                                                | High, same vendor/infra as `voyage-3-large`, purpose-built variant is the newer piece but built on proven infra.                                                                                                                                                                                                                                            | Widely varies by chosen model/server; "production maturity" here is really "does _your_ ops team run inference services well," which is a team-capability question, not a model-quality one.                                                                                         |

**Not selected merely for popularity:** OpenAI is the most popular choice in the ecosystem, which is exactly why it is evaluated on its technical merits above rather than defaulted to — `voyage-code-3` wins on the metric that matters most for this specific corpus (code/CLI-heavy technical documentation), not on brand recognition.

---

## 4. Recommended Provider/Model

**Recommendation: Voyage AI's `voyage-code-3`, at 1024 output dimensions, as the default (`EMBEDDING_PROVIDER=voyage`, `EMBEDDING_MODEL=voyage-code-3`, `EMBEDDING_DIMENSIONS=1024`).**

**Why:**

1. Docker's documentation corpus is not prose — it is saturated with CLI invocations, Dockerfile/Compose YAML, flag-reference tables, and inline shell snippets (confirmed directly in this session's real-corpus validation work: 2,916 `'note'` chunks, hundreds of `'code'`/`'table'` blocks per hundred documents). `voyage-code-3`'s entire training focus — beating general-purpose models by 5–8 NDCG points specifically on code retrieval — is a direct match to this content shape, not a generic upgrade.
2. 1024 dimensions (the model's own default under Matryoshka truncation) is chosen over the full 2048 as the balanced default: half the storage/compute cost of the full dimension at a documented "slight loss of retrieval quality" per Voyage's own Matryoshka design — an acceptable trade for a documentation corpus that does not need maximum-fidelity separation between billions of vectors. `EMBEDDING_DIMENSIONS` is fully configurable (§15) if a future evaluation shows 2048 is worth the cost at this specific corpus's scale.
3. Zero new operational surface — no GPU, no inference server, no queue — consistent with this project's current all-in-process, no-infra-beyond-the-app state (no Redis, no Postgres, no BullMQ exist yet either).
4. Total one-time cost to embed this project's entire real corpus is well under $1 (§17) — cost is not a meaningful factor in this decision at the current scale, so quality-for-this-content-type is correctly the deciding criterion.

**Why not the alternatives, briefly:**

- **OpenAI `text-embedding-3-large`** is the credible, mature runner-up — kept as the second implemented adapter (§11) specifically so the provider-abstraction claim is proven with working code, not just asserted. If Voyage's real-world retrieval quality on this corpus disappoints once M4/retrieval exists to measure it, switching the default to OpenAI is a one-line config change.
- **Local/self-hosted models** are rejected for the _initial_ implementation on operational-complexity grounds alone (§3) — this project has zero inference infrastructure today, and introducing a GPU-hosted or CPU-bound embedding server is a disproportionate cost for a corpus that costs under $1 to embed via API. This is documented as a **future migration trigger**, not a permanent rejection: if data residency ever becomes a real requirement (a future non-public documentation domain) or API cost becomes material at a much larger corpus, add a `LocalEmbeddingProviderAdapter` behind the same `EmbeddingProviderPort` — no pipeline change required, per §1's provider-swap guarantee. Notably, many self-hosted inference servers (Hugging Face's TEI, vLLM) expose an OpenAI-compatible embeddings endpoint, so `OpenAiEmbeddingProviderAdapter` (§11) pointed at a different `EMBEDDING_BASE_URL` may cover this migration with _zero new adapter code_ — worth trying first when that day comes.

**The architecture is not provider-specific despite this recommendation:** nothing outside `providers/voyage-embedding-provider.adapter.ts` and its DI registration (§6, §20) knows `voyage-code-3` exists.

---

## 5. Provider Interface (Port)

```typescript
// embedding-provider.port.ts

export const EMBEDDING_PROVIDER_PORT = Symbol('EMBEDDING_PROVIDER_PORT');

export interface EmbeddingProviderRequestItem {
  id: string; // the source chunkId — never sent over the wire to a provider (no provider in this
  // comparison accepts a client-supplied id); carried purely so the adapter can re-attach
  // it to the provider's positional response and the validator (§14) can assert the
  // adapter didn't get that re-attachment wrong.
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

**Why `id` exists on both request and response items even though no real provider's HTTP API has a client-id concept:** every provider evaluated in §3 returns embeddings as a bare, positionally-ordered array (OpenAI and Voyage both include an `index` field precisely because their own contract is "trust request order," not "trust an echoed id"). If this port's `embed()` simply returned `number[][]` (as the platform architecture doc's original sketch had it), a single off-by-one bug inside an adapter — or a future provider that silently reorders — would silently mismatch every vector to the wrong chunk, with no way for `validateProviderResponse` (§14) to catch it. Making every adapter responsible for reconstructing `{id, vector}` pairs from its provider's raw positional response, and making the pipeline validate that those ids match the request ids 1:1, converts a silent-corruption risk into a loud, tested failure. This is the concrete value this port adds beyond "a thin wrapper around an HTTP call."

**Why `metadata` is a property, not a parameter passed to `embed()`:** an adapter instance is constructed once per process (from config, §20) and its model/provider/dimensions never change mid-run — exposing it as a readonly property lets the pipeline (§10, §12) read it once and reuse it for every `deriveEmbeddingId` call without threading it through every function signature.

**Implementations:**

- `VoyageEmbeddingProviderAdapter` (§11) — the default (§4).
- `OpenAiEmbeddingProviderAdapter` (§11) — the proof-of-swap second implementation.
- `FakeEmbeddingProvider` — a deterministic test double (hash-derived pseudo-vectors, no network), used by every unit/e2e test in this module and selectable in real runs via `EMBEDDING_PROVIDER=fake` for dry-run/local development without spending API credits.

---

## 6. Embedding Input Strategy

**Chunk content is never modified to satisfy a provider.** `buildEmbeddingInput` (a pure function) derives a request string from a `Chunk` without mutating anything on disk or in memory beyond its own return value.

```typescript
// embedding-input-builder.util.ts

export interface EmbeddingInput {
  chunkId: string;
  documentId: string;
  sourcePath: string;
  contentHash: string;
  text: string; // the exact string that will be sent to the provider
  inputHash: string; // SHA-256 of `text`
  tokenCount: number;
  truncated: boolean;
}

export function estimateTokenCount(text: string): number {
  // Deliberately duplicates chunking's ~4-chars-per-token heuristic (length-measurer.ts's
  // ApproxTokenLengthMeasurer) rather than importing it — see rationale below.
  return Math.ceil(text.length / 4);
}

export function buildEmbeddingInput(
  chunk: Chunk,
  options: { includeHeadingContext: boolean; maxInputTokens: number },
): EmbeddingInput | null {
  /* full implementation in the plan, Task 3 */
}
```

**Should heading context be included? Yes, by default (`EMBEDDING_INCLUDE_HEADING_CONTEXT=true`), and this is not a stylistic choice — it fixes a real, already-observed retrieval-quality problem.** This session's real-corpus validation found two structurally distinct sections in the same document both literally titled "From the GUI" (`uninstall.md`) — a bug in `chunkId` derivation, now fixed, but the underlying _content_ ambiguity is still real: two `'child'`-type chunks under different platform tabs can have near-identical or literally identical short text ("Open the app, click Uninstall.") differing only in which ancestor heading they sit under. Embedded without heading context, those two chunks would produce near-identical vectors and be nearly indistinguishable to a similarity search — exactly the retrieval failure mode the occurrenceIndex chunkId fix was solving for at the identity layer, now solved for at the _content_ layer by prefixing the chunk's own heading-path breadcrumb (`chunk.metadata.headingPath.map(s => s.text).join(' › ')`) before the chunk's own text. This costs a small, bounded number of extra tokens per chunk and is directly reversible via config if a future evaluation shows it hurts more than it helps for a specific provider/corpus combination.

**Code blocks:** included verbatim, exactly as they appear in `chunk.text` — no special-casing. A code-aware embedding model (`voyage-code-3`, §4) is precisely the point of choosing a model that already understands code as code; re-formatting or stripping code blocks before embedding would throw away the exact signal the model is trained to use.

**Whitespace normalization:** collapse 3+ consecutive newlines to 2, strip trailing whitespace per line, trim the whole string. This is the same class of normalization `DocumentCleanerService` already performs at the ingestion boundary (a proven, low-risk step) — never touches code-fence _contents_ (only blank lines between blocks), so it cannot corrupt a code sample's actual whitespace-sensitive content (e.g. YAML indentation) since those live _inside_ a fenced block's own lines, not in the blank-line runs this normalization targets.

**Empty chunks:** `buildEmbeddingInput` returns `null` if the fully-prepared text is empty after normalization (e.g., a chunk whose only content was already stripped by upstream cleaning — rare but possible for a heading with genuinely zero body text). The pipeline (§10) logs this at `warn` and skips it — never sent to a provider, never a fatal error, mirroring `EmptyDocumentError`'s "not fatal" handling in chunking.

**Extremely large chunks / token limits:** `EMBEDDING_INPUT_MAX_TOKENS` (default 8,000 — comfortably under every evaluated provider's per-input limit even accounting for this module's own ±20%-accurate heuristic) caps the final input length. A chunk whose prepared text exceeds this is truncated to the limit (at the nearest whitespace boundary, never mid-word) and flagged `truncated: true` on its `EmbeddingRecord` — this should be rare in practice, since `'child'`-type chunks are already bounded by `CHUNKING_MAX_CHUNK_SIZE` (default 500 approx-tokens) well under this limit; the real corpus's own measured `childChunkSizeDistribution` (§0.8) tops out at a max of 2,207 approx-tokens (one outlier oversized-and-unsplittable code fence), still under 8,000. Truncation exists as a safety net for that kind of outlier, not as an expected everyday path.

**Why this module does not import chunking's `LengthMeasurerPort`:** the milestone's hard requirement is that embedding stay "completely independent of ... chunking." `LengthMeasurerPort` is a small interface, but importing it (even type-only for the interface, and definitely for `createLengthMeasurer`/`ApproxTokenLengthMeasurer` at runtime) would make this module's compiled output depend on chunking's module graph for a five-line arithmetic heuristic. `estimateTokenCount` intentionally duplicates the exact `Math.ceil(text.length / 4)` formula rather than sharing an implementation — a deliberate, small, documented exception to "reuse existing utilities before creating new ones," justified because the alternative (a real cross-module runtime dependency) directly violates an explicit architectural requirement of this milestone. If this heuristic needs to change later, it changes in exactly one place per module, and the two modules are free to diverge (e.g., embedding could later adopt a true tokenizer for its specific chosen model without chunking's own sizing algorithm needing to match).

---

## 7. Batching Strategy

```
Chunk[] (read from *.chunks.json files in CHUNKING_OUTPUT_DIR)
    │
    ▼
Filter: chunkType ∈ EMBEDDING_CHUNK_TYPES (default: ['child'] only — §0.2)
    │
    ▼
buildEmbeddingInput (§6) — normalize, prefix heading context, truncate; null ⇒ skip
    │
    ▼
Filter: embeddingId (§12) not already present in embeddings.jsonl (§13 resumability)
    │
    ▼
chunkArray(eligibleInputs, EMBEDDING_BATCH_SIZE)   — fixed-size batches, default 128
    │
    ▼
p-limit(EMBEDDING_MAX_CONCURRENT_BATCHES)          — default 5 batches in flight at once (§8)
    │
    ▼
EmbeddingBatchProcessorService.processBatch()      — withRetry(provider.embed(...)) + timeout race (§9, §10)
    │
    ▼
validateProviderResponse()                          — dimension, count, ordering, numeric checks (§15)
    │
    ▼
EmbeddingRecord[] per batch → EmbeddingOutputStoreService.append() (JSONL, one line per record, §13)
```

**`EMBEDDING_BATCH_SIZE` default 128:** comfortably under every evaluated provider's per-request item cap (OpenAI: 2,048; Voyage: no published hard per-request item cap found in this pass, only aggregate RPM/TPM — 128 stays well clear of either limit while keeping individual batch payload/latency small enough that a single slow/failed batch doesn't waste a large amount of already-embedded work).

**Partial-batch failures are handled at the batch level, not the item level, and this is a deliberate simplification, stated plainly:** if a batch's `provider.embed()` call ultimately fails (after retries, §10), **every chunk in that batch** is recorded as failed — this module does not attempt to bisect a failed batch to isolate which specific input caused a permanent failure (e.g., one malformed input inside an otherwise-valid batch). Justification: (1) `buildEmbeddingInput` already prevents the two known "one input is bad" causes — empty text (filtered before batching) and oversized text (truncated before batching) — so a permanently-failing batch is far more likely to indicate a provider-wide issue (invalid API key, unsupported model, wrong dimension request) than a single-poison-pill input; (2) bisection would multiply request count for a failure mode this design does not expect to be common; (3) failed chunks are still recorded individually in `EmbeddingRunResult.failures` (§10) with their own `chunkId`, so a future run naturally retries exactly those chunks (since a whole-corpus re-run's idempotency check, §13, skips only the chunks that _succeeded_) — no data is silently lost, just not diagnosed to single-item granularity within one failed batch. If single-item bisection is ever needed, it is a contained addition to `EmbeddingBatchProcessorService` alone.

**Whole-run abort threshold, mirroring `IngestionThresholdExceededError` (§0.5):** per-chunk failures are isolated (a failed chunk never stops other chunks/batches from proceeding), but if `failures.length / attempted` exceeds `EMBEDDING_FAILURE_THRESHOLD` (§16, default 0.5) once the whole corpus has been processed, `EmbeddingPipelineService.run()` throws `EmbeddingThresholdExceededError(failedCount, attemptedCount)` — the same "isolate per-unit, abort the whole run only past a configurable ratio" philosophy `IngestionPipelineService` already established, extended here to be configurable (§16) rather than a hardcoded constant, per this milestone's explicit "configuration-driven behavior" requirement.

---

## 8. Concurrency Strategy

`p-limit` — a zero-transitive-dependency concurrency limiter already named for exactly this purpose in `rag-platform-architecture.md` §5 ("Concurrency limiting for embedding batch calls, layered under BullMQ's own rate limiting") — is added as this module's one new production dependency. No unbounded `Promise.all(batches.map(...))` exists anywhere in this design: every batch is scheduled through `pLimit(EMBEDDING_MAX_CONCURRENT_BATCHES)` (default 5), so at most 5 provider requests (each carrying up to 128 inputs) are in flight at once regardless of how many batches the full corpus produces (§17: 113 batches for the current corpus's 14,387 eligible `'child'` chunks).

**Memory characteristic:** eligible `EmbeddingInput`s for the _entire_ run are computed up front and held in one in-memory array before batching begins (§10) — at the current corpus's scale (14,387 inputs × roughly 1–2 KB of prepared text each) this is on the order of 20–30 MB, negligible on any modern machine. **This is an explicit, documented scaling limit, not an oversight:** if a future, much larger corpus (Kubernetes docs plus Docker plus more) made this array a real memory concern, the fix is switching `EmbeddingPipelineService.run()`'s chunk-file-reading loop from "collect all, then batch" to a streaming async generator that yields one batch at a time directly from disk — a contained, backward-compatible change to one method, not a redesign. Not implemented now because the current, measured corpus size does not warrant it (the same "no streaming needed at current scale... migration trigger" reasoning `semantic-chunking-design.md` §13 already applied to chunking).

---

## 9. Retry Strategy

Every provider error is classified into exactly one of two families by its exception type (§18's `embedding.errors.ts`):

| Family        | Exceptions                                                                                                                                                                                                                                                                                                                  | Retried?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Transient** | `TransientEmbeddingProviderError` (network failure, connection reset, 5xx, request timeout — §10's timeout race throws this exact type), `RateLimitEmbeddingProviderError extends TransientEmbeddingProviderError` (429, carries an optional `retryAfterMs` parsed from a `Retry-After` header when the provider sends one) | **Yes**, up to `EMBEDDING_MAX_RETRIES` (default 5), exponential backoff with jitter: `min(baseDelayMs * 2^(attempt-1), maxDelayMs)` (defaults 500 ms base, 30,000 ms cap), randomized to `0.5x–1.0x` of the computed value to avoid thundering-herd retries across concurrent batches. If the error is specifically a `RateLimitEmbeddingProviderError` with a `retryAfterMs`, that value is used verbatim instead of the computed backoff — the provider is telling us exactly how long to wait. |
| **Permanent** | `PermanentEmbeddingProviderError` (401/403 auth, 400 invalid input, unsupported model, dimension mismatch — any 4xx that is not a rate limit), `EmbeddingResponseValidationError` (§14 — a malformed response is a contract violation, not a transient blip; retrying it would just get the same malformed response again)  | **No** — rethrown on the first occurrence, no attempt wasted.                                                                                                                                                                                                                                                                                                                                                                                                                                     |

```typescript
// retry.util.ts
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  /* full implementation in the plan, Task 6 — see design rationale above for the exact classification rule:
     `if (!(err instanceof TransientEmbeddingProviderError) || attempt >= maxAttempts) throw err;` is the
     single line that implements the whole table above, since RateLimitEmbeddingProviderError IS-A
     TransientEmbeddingProviderError and PermanentEmbeddingProviderError/EmbeddingResponseValidationError
     are not. */
}
```

**Request timeouts (`EMBEDDING_REQUEST_TIMEOUT_MS`, default 30,000):** implemented as a `Promise.race` between the adapter's `embed()` call (passed an `AbortSignal` it should forward to its own `fetch`) and a timer promise that rejects with a fresh `TransientEmbeddingProviderError` — this makes a hang classify and retry exactly like any other transient failure, with no special-casing needed in `withRetry` itself.

---

## 10. Rate-Limit Handling

Handled at two layers, deliberately not just one:

1. **Reactive (§9):** a `429` response is classified as `RateLimitEmbeddingProviderError`, and its `Retry-After` header (when present) is honored verbatim as the wait time before the next attempt — this is more accurate than blind exponential backoff whenever a provider actually tells us the real wait.
2. **Proactive (§8):** `EMBEDDING_MAX_CONCURRENT_BATCHES` bounds total in-flight requests, which is the primary defense against _causing_ a 429 in the first place — 5 concurrent batches of 128 inputs is comfortably inside both evaluated providers' documented RPM ceilings (Voyage: 300 RPM default) even under sustained load.

No separate token-bucket/leaky-bucket rate limiter is introduced in M3 — `p-limit`'s concurrency cap plus reactive backoff is sufficient at this corpus's real measured scale (§17: 113 total batches for the whole corpus, nowhere near 300/minute even run back-to-back with zero concurrency limiting). **Migration trigger:** if a much larger corpus or a stricter-limited provider makes proactive concurrency capping alone insufficient, add a token-bucket layer inside `EmbeddingBatchProcessorService` — contained to that one class.

---

## 11. Recommended Adapters (implementation sketch, full code in the plan)

Both adapters share one shape: build a provider-specific request body from `EmbeddingProviderRequestItem[]`, `fetch()` (Node 22's native global — no new HTTP client dependency needed, matching `package.json`'s `engines.node: ">=22 <23"`), map the provider's HTTP status/response shape into this module's error taxonomy (§9), and reconstruct `{id, vector}[]` from the provider's positionally-ordered response by zipping against the original request items (§6's rationale for why this reconstruction is real, tested logic and not a formality).

- **`VoyageEmbeddingProviderAdapter`** (default, §4) — `POST https://api.voyageai.com/v1/embeddings`, `Authorization: Bearer <EMBEDDING_API_KEY>`, body `{ input: string[], model, input_type: 'document', output_dimension }`.
- **`OpenAiEmbeddingProviderAdapter`** (proof-of-swap, §5) — `POST https://api.openai.com/v1/embeddings`, `Authorization: Bearer <EMBEDDING_API_KEY>`, body `{ input: string[], model, dimensions }`. Its base URL is overridable via `EMBEDDING_BASE_URL` specifically so it can later be pointed at a self-hosted OpenAI-compatible inference server (e.g. Hugging Face TEI) — see §4's local-model migration note.

Both map: `401`/`403` → `PermanentEmbeddingProviderError`; `400`/`404` (invalid input, unknown model, dimension mismatch) → `PermanentEmbeddingProviderError`; `429` → `RateLimitEmbeddingProviderError` (with `Retry-After` if present); `5xx` or a thrown network error from `fetch` itself → `TransientEmbeddingProviderError`.

---

## 12. Idempotency Strategy

**Identity rule: the same chunk content, embedded with the same provider/model/version/dimension configuration, must always resolve to the same `embeddingId` — and only those exact factors, nothing invented beyond them.**

```typescript
// embedding-id.util.ts
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

**Why `contentHash` is included even though `chunkId` is already collision-free:** `semantic-chunking-design.md` §9 documents, as a known and accepted limitation, that `chunkId` is _structural_ (derived from `documentId`/`chunkType`/`headingPath`/`occurrenceIndex`/`localSequenceIndex`), not content-based — an upstream prose edit that doesn't shift a section across a split/merge size boundary can leave `chunkId` unchanged while `chunk.text` (and therefore `metadata.contentHash`) changes. Including `contentHash` in `embeddingId`'s derivation means such an edit is correctly detected as "this needs a new embedding" (a new `embeddingId`, since the old one no longer matches anything about to be embedded) rather than silently serving a stale vector for updated content forever. This directly answers the milestone's "whether the embedding is stale after a chunk/model change" requirement using existing fields — no new identifier invented beyond what `Chunk` already provides.

**Why provider/model/version/dimensions are included:** identical reasoning, one layer up — changing `EMBEDDING_MODEL_VERSION` (§2) or swapping `EMBEDDING_PROVIDER` must force a full re-embedding, because a vector from a different model is not comparable to one from another model; two records must never share an `embeddingId` unless they are genuinely interchangeable.

**No unnecessary identifier is invented.** `embeddingId` is a pure function of exactly the five inputs listed — no random UUID, no run-scoped counter, no timestamp — so it is reproducible by anyone re-running the same chunk through the same configuration, which is precisely what makes §13's resumability check correct without a separate manifest.

---

## 13. Resumability Strategy

**No separate manifest/checkpoint file — the JSONL output itself is the checkpoint, and this is a deliberate simplification over a two-file design.** `rag-platform-architecture.md` §6 names "Postgres/vector-store ledger divergence" as a real, named architectural risk _precisely because_ a separate tracking file (or table) can drift out of sync with the data it's tracking if a process crashes between writing the two. This module has no such risk because there is only one file: `EmbeddingOutputStoreService.loadExistingEmbeddingIds()` reads `embeddings.jsonl` at the start of every run, parses every line, and collects every `embeddingId` already present into an in-memory `Set<string>` — that set _is_ the checkpoint, derived from the actual output, not a second source of truth that could diverge from it.

**Interrupted-run tolerance:** if a previous run was killed mid-write, the very last line of `embeddings.jsonl` may be a partial, unparseable JSON fragment (a single `appendFile` call is atomic at the OS level for small writes, but the _process_ could still be killed between two separate `append()` calls, or — far less likely but handled anyway — mid-syscall on some filesystems). `loadExistingEmbeddingIds()` tolerates exactly this one failure mode: if the **last** line fails to parse, it is logged at `warn` and skipped (treated as never-written); if any **non-last** line fails to parse, that is a genuine corruption signal and the load throws — a crash should only ever be able to corrupt the tail of an append-only file, never an interior line, so a non-tail parse failure indicates something worse than an interrupted run and should not be silently ignored.

**Resulting resume behavior:** re-running `pnpm embed` after an interruption re-scans every chunk file (cheap — local disk reads, no network), recomputes `embeddingId` for each eligible chunk, and skips every one whose id is already in the loaded set — only the chunks that were never successfully written (including the one possibly-corrupted tail line) are re-sent to the provider. A fully-completed prior run makes a second `pnpm embed` invocation a near-zero-cost no-op (all ids already present, zero provider calls, zero batches).

**Concurrent-write safety within a single run:** `EmbeddingOutputStoreService.append()` chains every write onto a single in-process `Promise` queue (`this.writeQueue = this.writeQueue.then(() => appendFile(...))`), so even though up to `EMBEDDING_MAX_CONCURRENT_BATCHES` batches complete and want to write concurrently, actual `appendFile` calls are serialized — no interleaved partial lines from two batches racing each other.

**No database introduced for this milestone, per the explicit instruction — and none is needed:** the JSONL file fully satisfies "resumable" and "idempotent" without a Postgres ledger. A real database-backed ledger becomes justified once M4/M5 need transactional guarantees across the embedding _and_ vector-store write together (the exact "reconciliation job" scenario `rag-platform-architecture.md` §3/§6 describes for the full ingestion pipeline) — that is explicitly deferred, not solved prematurely here.

---

## 14. Persistence / Output Boundary

`EMBEDDING_OUTPUT_DIR` (default `./data/embedding-output`) holds exactly one file, `embeddings.jsonl` — one `EmbeddingRecord` (§2) per line, newline-delimited JSON, append-only. This is the **entire** persistence surface of this module; no other format, no directory-per-document sharding (unlike chunking's one-file-per-document convention — a single file is simpler here because §13's resumability check needs one comprehensive read at startup regardless, and 30,016 lines of compact JSON is not large enough to need sharding for read/write performance).

**Validation performed before any record is ever written (§16):** dimension match, numeric/finite vector values, response-count match, response-ordering match against request — never write a record built from an unvalidated provider response.

---

## 15. Validation

Every provider response is validated before a single `EmbeddingRecord` is constructed from it:

```typescript
// embedding-response-validator.util.ts
export function validateProviderResponse(
  requestItems: EmbeddingProviderRequestItem[],
  responseItems: EmbeddingProviderResponseItem[],
  expectedDimensions: number,
): void {
  /* full implementation in the plan, Task 5 */
}
```

Checks, all raising `EmbeddingResponseValidationError` (a permanent, non-retried failure per §9 — a malformed response is a contract violation the same call will reproduce identically on retry):

- **Count match:** `responseItems.length === requestItems.length` — no missing or extra embeddings.
- **Ordering match:** each `responseItems[i].id === requestItems[i].id`, asserting the adapter correctly reconstructed id-tagged output from its provider's positional response (§6's rationale for why `id` exists on the port at all).
- **Vector exists and is non-empty:** `Array.isArray(vector) && vector.length > 0`.
- **Expected dimension:** `vector.length === expectedDimensions`, read from `provider.metadata.dimensions` — catches a misconfigured `EMBEDDING_DIMENSIONS` or a provider silently ignoring the requested dimension.
- **Numeric, finite values:** every element is `typeof === 'number' && Number.isFinite(...)` — catches `NaN`/`Infinity`/string-typed values a lenient JSON parse might otherwise let through.

A malformed response is **never** silently accepted, coerced, or padded — it fails the whole batch (§7's partial-failure design) loudly.

---

## 16. Configuration Schema

Extends `src/config/env.validation.ts`'s single zod schema exactly as chunking did (§0.3), plus a dedicated `EmbeddingConfigService` — never reading `process.env` directly:

| Env var                             | Type / default                                                                 | Purpose                                                                                                                                                                                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMBEDDING_PROVIDER`                | `'voyage' \| 'openai' \| 'fake'`, default `'voyage'`                           | Selects the `EmbeddingProviderPort` adapter (§20's factory).                                                                                                                                                                                                                                             |
| `EMBEDDING_MODEL`                   | `string`, default `'voyage-code-3'`                                            | Passed to the adapter as the provider's model identifier.                                                                                                                                                                                                                                                |
| `EMBEDDING_MODEL_VERSION`           | `string`, default `'1'`                                                        | Operator-controlled version tag (§2) — part of `embeddingId` derivation (§12).                                                                                                                                                                                                                           |
| `EMBEDDING_DIMENSIONS`              | `number`, default `1024`                                                       | Requested output vector width; validated against the chosen model's supported set inside the adapter (not by zod, since valid sets differ per model).                                                                                                                                                    |
| `EMBEDDING_API_KEY`                 | `string`, default `''`                                                         | Read from validated config only, never logged (§19); the provider factory (§20) throws a clear startup error if `EMBEDDING_PROVIDER` is `'voyage'`/`'openai'` and this is empty. Empty is valid only for `EMBEDDING_PROVIDER=fake`.                                                                      |
| `EMBEDDING_BASE_URL`                | `string`, default `''` (meaning "use the adapter's built-in default endpoint") | Overrides an adapter's endpoint — enables pointing `OpenAiEmbeddingProviderAdapter` at a self-hosted OpenAI-compatible server (§4, §11).                                                                                                                                                                 |
| `EMBEDDING_BATCH_SIZE`              | `number`, default `128`                                                        | Items per provider request (§7).                                                                                                                                                                                                                                                                         |
| `EMBEDDING_MAX_CONCURRENT_BATCHES`  | `number`, default `5`                                                          | `p-limit` concurrency (§8).                                                                                                                                                                                                                                                                              |
| `EMBEDDING_MAX_RETRIES`             | `number`, default `5`                                                          | Max attempts per batch before it is recorded as failed (§9).                                                                                                                                                                                                                                             |
| `EMBEDDING_RETRY_BASE_DELAY_MS`     | `number`, default `500`                                                        | Exponential-backoff base (§9).                                                                                                                                                                                                                                                                           |
| `EMBEDDING_RETRY_MAX_DELAY_MS`      | `number`, default `30000`                                                      | Backoff cap (§9).                                                                                                                                                                                                                                                                                        |
| `EMBEDDING_REQUEST_TIMEOUT_MS`      | `number`, default `30000`                                                      | Per-batch request timeout (§9).                                                                                                                                                                                                                                                                          |
| `EMBEDDING_INPUT_MAX_TOKENS`        | `number`, default `8000`                                                       | Truncation ceiling (§6).                                                                                                                                                                                                                                                                                 |
| `EMBEDDING_INCLUDE_HEADING_CONTEXT` | `boolean`, default `true`                                                      | Whether to prefix the heading breadcrumb (§6). Uses the same `z.union([z.boolean(), z.enum(['true','false'])])` pattern `CHUNKING_INCLUDE_PARENT_CHUNKS` already established — **not** bare `z.coerce.boolean()`, which has the known `Boolean('false') === true` footgun this project already hit once. |
| `EMBEDDING_CHUNK_TYPES`             | comma-separated string → `ChunkType[]`, default `'child'`                      | Which `chunkType`s are eligible for embedding (§0.2, §7). Validated against the literal set `['parent', 'child']`.                                                                                                                                                                                       |
| `EMBEDDING_OUTPUT_DIR`              | `string`, default `'./data/embedding-output'`                                  | Where `embeddings.jsonl` lives (§14).                                                                                                                                                                                                                                                                    |
| `EMBEDDING_FAILURE_THRESHOLD`       | `number` (0–1), default `0.5`                                                  | Fraction of attempted chunks that may fail before `EmbeddingThresholdExceededError` aborts the run — mirrors `IngestionThresholdExceededError`'s 50% precedent exactly.                                                                                                                                  |

`EMBEDDING_RETRY_BASE_DELAY_MS < EMBEDDING_RETRY_MAX_DELAY_MS` is enforced by a zod `.refine()`, mirroring the existing `CHUNKING_MIN_CHUNK_SIZE < CHUNKING_MAX_CHUNK_SIZE` refinement.

**Known, already-experienced friction, stated up front:** `.env.example` cannot be edited by the assistant in this session (the user's global `~/.claude/settings.json` denies `Read`/`Write`/`Edit` on any `.env*` path) — this already happened for chunking's 7 new keys, which remain pending manual addition. This module adds 16 more keys with the identical friction; the plan's config task documents the exact lines for the user to add by hand, and until they do, `src/config/env-example.spec.ts`'s drift-guard test will fail — a known, non-code-defect blocker, not a bug in this module.

---

## 17. Logging Strategy

Every injectable in this module follows the existing, exception-free convention exactly (§0.6): constructor-injects `PinoLogger`, calls `this.logger.setContext(ClassName.name)`, logs structured objects.

| Event                                                 | Level   | Fields (never chunk/document text, never a vector, never `EMBEDDING_API_KEY`)                                                                                           |
| ----------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run started                                           | `info`  | `jobId`, `provider`, `model`, `dimensions`, `chunksDir`                                                                                                                 |
| Chunk skipped (wrong type / empty / already embedded) | `debug` | `chunkId`, `reason`                                                                                                                                                     |
| Batch completed                                       | `info`  | `jobId`, `batchId`, `chunkCount`, `succeeded`, `failed`, `provider`, `model`, `durationMs`                                                                              |
| Batch failed permanently after retries                | `warn`  | `jobId`, `batchId`, `chunkCount`, `attempts`, `error` (the `Error.message` only — never the raw provider response body, which could theoretically echo back input text) |
| Retry attempted                                       | `debug` | `batchId`, `attempt`, `delayMs`, `errorType`                                                                                                                            |
| Corrupted tail line tolerated (§13)                   | `warn`  | `filePath`                                                                                                                                                              |
| Run completed                                         | `info`  | full `EmbeddingRunResult` minus its `failures` array (logged separately, one line per failure, so a long failure list doesn't produce one enormous log line)            |

**M10 observability extension point, prepared now:** every count in `EmbeddingRunResult` (§10) — `totalChunksScanned`, `skippedByType`, `skippedEmpty`, `alreadyEmbedded`, `attempted`, `succeeded`, `failed`, `totalBatches`, `durationMs` — is already a plain number on a plain object, ready to be forwarded as-is to a metrics backend (StatsD/Prometheus/OpenTelemetry counters) by a future M10 pass wrapping `EmbeddingPipelineService.run()`'s return value, with zero change to this module's internals. Throughput (`succeeded / (durationMs / 1000)`) is a derived value computed once at the CLI layer (§20) for human-readable console output, not stored on the result type itself (keeping `EmbeddingRunResult` a set of independently-true facts, not facts plus their own derived ratios).

---

## 18. Testing Strategy

Every stage is a pure function or a narrowly-scoped injectable class taking plain strings/objects — **no test in the normal suite ever calls a real provider**, satisfying the milestone's explicit requirement directly:

- **`embedding-id.util.spec.ts`** — deterministic; changes on each of the 5 inputs independently; matches the exact style of `chunk-id.util.spec.ts` (already proven in this codebase to catch real collision bugs).
- **`embedding-input-builder.util.spec.ts`** — heading-context prefix present/absent per config; whitespace normalization; empty-after-normalization returns `null`; truncation triggers only above `maxInputTokens` and never mid-word; `inputHash` changes when `text` changes; `tokenCount` matches `estimateTokenCount`.
- **`embedding-response-validator.util.spec.ts`** — table-driven: count mismatch, ordering mismatch, missing vector, wrong dimension, non-numeric element, `NaN`/`Infinity` element, and the happy path — each raising or not raising `EmbeddingResponseValidationError` exactly as specified.
- **`retry.util.spec.ts`** — a fake `sleep` injected (no real timers in the test suite); transient error retried up to `maxAttempts` then rethrown; permanent error (`PermanentEmbeddingProviderError`, `EmbeddingResponseValidationError`) never retried, rethrown on first occurrence; `RateLimitEmbeddingProviderError`'s `retryAfterMs` is used verbatim instead of computed backoff when present.
- **`embedding-output-store.service.spec.ts`** — round-trip write-then-load; a truncated/corrupt **last** line is tolerated with a warning and excluded from the loaded set; a corrupt **non-last** line throws; concurrent `append()` calls never interleave partial lines (assert final file has exactly N well-formed lines after N concurrent appends).
- **`embedding-batch-processor.service.spec.ts`** (using `FakeEmbeddingProvider`) — successful batch produces one `EmbeddingRecord` per input with correct `embeddingId`/provenance fields; a provider that always throws transient errors exhausts retries and reports the whole batch as `failed`, never throwing out of `processBatch` itself; a provider that throws a permanent error fails immediately with exactly one attempt recorded; a slow `FakeEmbeddingProvider` (configurable artificial delay) exceeding `EMBEDDING_REQUEST_TIMEOUT_MS` is caught by the timeout race and classified transient (retried, then eventually failed if it never speeds up).
- **`embedding-pipeline.service.spec.ts`** — end-to-end within the module using `FakeEmbeddingProvider` and an in-memory set of `Chunk[]` fixtures (both `'parent'` and `'child'` types, to prove type filtering works): asserts the full `EmbeddingRunResult` accounting invariant `totalChunksScanned === skippedByType + skippedEmpty + alreadyEmbedded + attempted` explicitly (the exact class of counting bug this project already hit twice with `mergedSections`/`splitSections` — this test exists specifically so that mistake cannot recur silently here); asserts a second `run()` call against the same chunks and output directory embeds zero new chunks (resumability, §13); asserts `EmbeddingThresholdExceededError` is thrown when a fake provider is configured to fail enough batches to cross `EMBEDDING_FAILURE_THRESHOLD`.
- **`providers/voyage-embedding-provider.adapter.spec.ts`** / **`providers/openai-embedding-provider.adapter.spec.ts`** — `fetch` mocked (via Jest's module/global mock, never a real network call): asserts correct request body shape per provider, correct `Authorization` header, correct status-code-to-error-family mapping (401→Permanent, 429→RateLimit with parsed `Retry-After`, 500→Transient, 400→Permanent), and correct positional-response-to-`{id, vector}` reconstruction.
- **`test/embedding.e2e-spec.ts`** — reads a small, real `Chunk[]` fixture (generated once by actually running the real ingestion→chunking pipeline over a fixture document, mirroring `test/fixtures/chunking/docker-install-guide.json`'s own provenance) through the fully-wired `EmbeddingModule` configured with `EMBEDDING_PROVIDER=fake`, asserting realistic end-to-end shape and the resumability property across two real `EmbeddingPipelineService.run()` calls against the same real filesystem output directory.

**A small, explicitly optional integration test** (`embedding.integration.spec.ts` or similar, excluded from `pnpm test`/`pnpm test:e2e` by Jest's `testPathIgnorePatterns` or a separate `test:integration` script gated on a real `EMBEDDING_API_KEY` being present) may later call the real Voyage API with 1–2 real chunks to confirm the adapter's request/response shape assumptions against the live API — never required for the normal suite to pass, exactly as the milestone specifies. Not scheduled as a numbered task in the accompanying plan (optional, not required for Definition of Done), but the module structure (§20) leaves an obvious, uncontested place for it (`src/embedding/providers/`) if the team wants it later.

**Coverage target:** the existing project-wide 80% branch/function/line/statement floor applies unchanged.

---

## 19. Performance Analysis for 30,016 Chunks

Using this session's own already-measured real-corpus numbers (§0.8) rather than fresh estimates:

- **Eligible input:** 14,387 `'child'`-type chunks (the other 15,629 `'parent'`-type chunks are never embedded by default, §0.2/§7) — **not** all 30,016.
- **Requests:** at `EMBEDDING_BATCH_SIZE=128`, `⌈14387 / 128⌉ = 113` provider requests total for a full, from-scratch run.
- **Concurrency waves:** at `EMBEDDING_MAX_CONCURRENT_BATCHES=5`, `⌈113 / 5⌉ ≈ 23` sequential waves of up to 5 concurrent requests each.
- **Estimated tokens:** the real corpus's measured `childChunkSizeDistribution` (approx-token units, §0.8) has a median of 162 and a p75 of 294; estimating a right-skew-adjusted mean of roughly 190 tokens/chunk (a stated estimate, not a re-measurement) gives `14,387 × 190 ≈ 2.73M` total input tokens for a full run, before any heading-context prefix overhead (§6) adds a small additional amount per chunk.
- **Estimated one-time cost:** at Voyage's published `voyage-3-large` rate ($0.18/M tokens — `voyage-code-3`'s exact current rate should be confirmed against `docs.voyageai.com/docs/pricing` at implementation time, §3), full-corpus embedding costs on the order of **$0.50, one time**. Every subsequent run is near-zero-cost due to resumability (§13) unless content, model, or version actually changes.
- **Estimated wall-clock:** assuming roughly 1–2 seconds of round-trip latency per batch (typical for an embeddings API call of this size), 23 waves at ~1.5s each is roughly **35 seconds** of pure request time; accounting for local file I/O (reading 1,508 chunk files), JSON parsing, and any retries, a realistic full from-scratch run should complete in **low single-digit minutes**, not hours — this is an estimate to be confirmed empirically during implementation (the plan's final task runs the CLI against the real corpus), not a guarantee.
- **Memory:** the full set of 14,387 prepared `EmbeddingInput` objects held in memory at once (§8) is on the order of 20–30 MB; per-wave in-flight data (5 concurrent batches × 128 items × ~1–2 KB text + ~1024-float response vectors) is a few more MB — trivial on any development machine, no streaming needed at this scale (§8's documented migration trigger for if that ever changes).
- **Obvious bottleneck, named plainly:** the sequential nature of resumability's initial `loadExistingEmbeddingIds()` read (§13) — a single-threaded parse of every existing line in `embeddings.jsonl` before any new work starts. At 14,387 lines this is fast (well under a second); it is named here only so a much later, much larger corpus knows exactly where the first real scaling limit would appear.

---

## 20. Security Considerations

- **`EMBEDDING_API_KEY` is read exclusively through `EmbeddingConfigService`, sourced from validated zod config — never a literal in code, never a CLI argument (which would leak into shell history/`ps` output).**
- **Never logged, anywhere, under any log level.** Unlike HTTP request headers (which pino-http's `redact` option can intercept generically, §0.6), this module's provider adapters never construct a log object that could contain the key — the key is used exactly once per adapter, inside the `Authorization` header of its own `fetch()` call, and never re-serialized into any object passed to `this.logger.*`. This is enforced by an explicit test (§18's adapter specs assert the mocked `fetch` call's headers contain the key — proving it's used — while a separate assertion over every `logger.*` call recorded during that same test asserts the key string never appears in any logged argument).
- **Provider response bodies are never logged verbatim** (§17's table) — only derived counts and `Error.message` strings, since a provider error response could in principle echo back a fragment of the input text that was sent.
- **No credential is ever written to `embeddings.jsonl`** — `EmbeddingRecord` (§2) has no field capable of holding one; this is a property of the type, not just current code behavior.
- **`.env.example` documents `EMBEDDING_API_KEY=` with an empty example value** (never a real-looking placeholder key that could be mistaken for a working credential or accidentally copy-pasted into a real deployment).

---

## 21. Folder Structure

Flat `src/embedding/` feature folder, mirroring `src/chunking/`'s and `src/ingestion/`'s established convention exactly:

```
src/embedding/
  embedding.types.ts                        # EmbeddingModelMetadata, EmbeddingRecord, EmbeddingInput,
                                             # EmbeddingFailure, EmbeddingRunResult
  embedding.errors.ts                       # TransientEmbeddingProviderError, RateLimitEmbeddingProviderError,
                                             # PermanentEmbeddingProviderError, EmbeddingResponseValidationError,
                                             # EmbeddingThresholdExceededError
  embedding-id.util.ts                      # deriveEmbeddingId (§12)
  embedding-input-builder.util.ts           # estimateTokenCount, buildEmbeddingInput (§6)
  embedding-response-validator.util.ts      # validateProviderResponse (§15)
  retry.util.ts                             # withRetry (§9)
  embedding-provider.port.ts                # EMBEDDING_PROVIDER_PORT + EmbeddingProviderPort (§5)
  providers/
    fake-embedding-provider.ts              # deterministic test double (§5, §18)
    voyage-embedding-provider.adapter.ts    # default provider (§4, §11)
    openai-embedding-provider.adapter.ts    # proof-of-swap provider (§5, §11)
  embedding-config.service.ts               # wraps ConfigService, typed getters (§16)
  embedding-output-store.service.ts         # JSONL append + resumability load (§13, §14)
  embedding-batch-processor.service.ts      # per-batch retry+timeout+validate orchestration (§9, §15)
  embedding-pipeline.service.ts             # top-level orchestrator (§7, §10)
  embedding.module.ts                       # DI wiring, provider factory (§5, §20)
  *.spec.ts                                 # one per file above, co-located
src/cli/embed.ts                            # pnpm embed [chunks-dir] (§22)
test/
  embedding.e2e-spec.ts
  fixtures/embedding/
    docker-install-guide.chunks.json        # a real Chunk[] fixture, generated once via the real
                                             # ingestion→chunking pipeline over a small fixture document
```

No new top-level directories. `EmbeddingModule` is a sibling of `IngestionModule`/`ChunkingModule` under `src/`, importable into `AppModule` the same way — though as of M3, nothing yet requires it to be imported into `AppModule` at all, since (like chunking before it) it is invoked purely via CLI; wiring it into `AppModule` becomes relevant only once a future HTTP admin surface needs it directly.

---

## 22. M4 Integration Boundary

M4 (vector storage) depends on exactly one thing from this module: **the `embeddings.jsonl` file** (§14), read as a plain, static input — never a live service call into `EmbeddingPipelineService`. A future `VectorStoreBulkLoaderService` (M4, not part of this plan) reads `embeddings.jsonl` line by line and calls `VectorStorePort.upsert(collection, records)` with a direct field mapping:

```
EmbeddingRecord                          →  VectorStorePort.upsert(...) record
────────────────────────────────────────────────────────────────────────────
embeddingId                              →  id
vector                                   →  vector
{ chunkId, documentId, sourcePath,       →  metadata (everything a retrieval-time filter
  provider, model, modelVersion,             or citation needs, without a join back to
  dimensions, contentHash, createdAt }       the Chunk[] files for the common case)
```

**This module requires zero changes for M4 to be built.** No embedding-provider code, no batching/retry/concurrency code, and no config in this module needs to know a vector database exists. The only new code M4 introduces is a reader for this module's already-stable output format plus the vector-store adapter itself — satisfying the milestone's explicit integration-boundary requirement.

---

## 23. Risks and Tradeoffs

| Risk / tradeoff                                                                                                                                                                               | Mitigation                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Voyage's exact current input-token limit and `voyage-code-3` pricing were not independently confirmed in this research pass (§3 flags both explicitly)                                        | `EMBEDDING_INPUT_MAX_TOKENS` defaults conservatively (8,000) well under any plausible real limit; exact pricing is only needed for cost _reporting_, not correctness — confirm both against `docs.voyageai.com` during Task 11's implementation, before, not after, a real production run.                                                                                               |
| Batch-level (not item-level) failure granularity (§7) could occasionally mark a healthy chunk as failed alongside one genuinely bad input in the same batch                                   | Documented tradeoff, not a silent gap: failed chunks are individually recorded in `EmbeddingRunResult.failures` and automatically retried on the next run via the same resumability mechanism (§13) that handles any other unembedded chunk — no data loss, only a slightly wasted retry of already-good inputs in the rare case this occurs.                                            |
| `EMBEDDING_MODEL_VERSION` is manually operator-controlled (§2) — an operator could forget to bump it after a real, silent provider-side model change, leaving stale-but-undetected embeddings | Named limitation, consistent with the industry-wide reality that providers don't expose a machine-checkable version signal; mitigated operationally (a changelog-watching habit), not architecturally solvable without a capability no evaluated provider offers.                                                                                                                        |
| Single `embeddings.jsonl` file (§14) is not sharded — a future, much larger corpus could make one file unwieldy to read/parse at startup                                                      | Explicit, documented scaling trigger (§8, §19): switch to per-document or per-run sharded output files, a contained change to `EmbeddingOutputStoreService` alone, not a redesign — not implemented now because the current, measured 30,016-chunk corpus does not need it.                                                                                                              |
| Adding `p-limit` is this module's one new production dependency                                                                                                                               | Justified: zero transitive dependencies, already pre-approved for exactly this purpose in `rag-platform-architecture.md` §5, and hand-rolling a concurrency semaphore would be a needless reinvention of a well-tested, tiny utility — "reuse existing utilities and abstractions before creating new ones" applies to _planned, named_ dependencies exactly as much as to in-repo code. |
| This module's own token-count heuristic (§6) intentionally duplicates chunking's, rather than sharing code                                                                                    | Explicit, bounded exception to DRY, justified by the milestone's explicit independence requirement (§6's rationale) — the duplication is 3 lines, not an algorithm at risk of drifting into subtly different behavior undetected.                                                                                                                                                        |

---

## 24. Definition of Done

This bounded context is complete when, without introducing a vector database, Postgres/Prisma, retrieval, reranking, an LLM, conversation, or an HTTP endpoint:

1. `EmbeddingPipelineService.run(chunksDir: string): Promise<EmbeddingRunResult>` exists, is unit- and integration-tested entirely against `FakeEmbeddingProvider` (no real API calls in the normal suite), and is invokable via `pnpm embed [chunks-dir]`.
2. Given the real, already-validated 1,508-document / 30,016-chunk corpus (14,387 `'child'`-type chunks eligible by default), a full run against a real provider (manually verified once during implementation, not part of the automated suite) produces exactly one `EmbeddingRecord` per eligible, non-empty chunk, each with a correct, dimension-matching vector and complete provenance fields.
3. Re-running the same command against the same output directory performs zero redundant provider calls (§13's resumability property, verified by a real, non-fake test asserting a second run's `attempted` count is `0`).
4. Every one of the 16 new `EMBEDDING_*` env vars (§16) is zod-validated, documented in `.env.example` and the README's config table (subject to the known `.env.example`-edit permission blocker, flagged, not silently skipped), and covered by `EmbeddingConfigService`.
5. `pnpm lint`, `pnpm test` (≥80% coverage floor maintained), `pnpm test:e2e`, and `pnpm build` all pass.
6. No code in `src/embedding/` imports any vector-store client, Prisma/`pg`, a LangChain chain/agent API, or any chunking _service_ (only `src/chunking/chunking.types.ts`'s types, per §1).
7. At least two working `EmbeddingProviderPort` implementations exist (`VoyageEmbeddingProviderAdapter`, `OpenAiEmbeddingProviderAdapter`), proving the provider-swap guarantee (§1, §5) with real code, not just an interface.
8. The security requirements in §20 are enforced by an explicit, passing test — not merely a documented intention.

# Document Ingestion Subsystem — Design

**Scope:** the "Document Ingestion" bounded context defined in [`rag-platform-architecture.md`](./rag-platform-architecture.md), elaborated in full for the first concrete source: the official Docker documentation, distributed as a downloadable ZIP archive. Everything below is designed so that adding a second source — a different archive, a different format, a different domain entirely — requires new adapter/strategy implementations, never changes to the orchestration, entities, or DTOs defined here.

**Relationship to the platform architecture:** the top-level architecture already defines `DocumentLoaderPort`, `ChunkingPort`, and the `Document`/`Chunk`/`IngestionJob` entities, and sketches the ingestion flow as crawl → hash-check → normalize → chunk → embed → upsert. This document replaces and details steps 1–4 of that flow (source acquisition through producing a normalized `Document`) for archive-based sources. Chunking and embedding (steps 5–8) are unchanged and out of scope here.

---

## 1. Ingestion Architecture

The pipeline requested — **ZIP → Extract → Clean → Parse → Metadata Generation → Structured Documents → (JSON)** — maps onto three architectural layers, each independently swappable:

1. **Acquisition layer** (`DocumentLoaderPort`) — gets bytes out of a source and hands over a stream of raw files. This is the _only_ layer that knows the source is a ZIP.
2. **Normalization pipeline** (new in this design) — turns each raw file into a `StructuredDocument`: format-aware cleaning, parsing into a structured shape, metadata derivation, assembly. This is the _only_ layer that knows a file is Markdown vs. HTML vs. something else.
3. **Persistence & handoff** — upserts the `StructuredDocument` as a `Document` row (content-hash gated, matching the platform's incremental-reingestion design) and emits a domain event that the existing chunking pipeline consumes.

No layer knows about "Docker." The source is one row of `KnowledgeDomain` config (`source: { loaderAdapterKey: 'archive', loaderConfig: { archiveUrl, archiveFormat: 'zip', includeGlobs: ['**/*.md'] } } }`) — identical in kind to how the platform architecture already treats the git-repo and web-crawler loaders.

Everything runs as BullMQ jobs on `apps/ingestion-worker`, per the platform's existing async-ingestion model — no new infrastructure component is introduced. The fan-out/fan-in shape (one archive → many files → one completion signal) is implemented with **BullMQ Flows** (`FlowProducer`, parent/child jobs): `extract-archive` is the parent, one `process-file` child job is queued per matched entry, and the parent's own completion step runs automatically only once every child has finished, reading their outcomes via `job.getChildrenValues()`. This is BullMQ's purpose-built mechanism for exactly this shape — the orchestrator does not implement its own "poll until N children are done" logic.

`process-file` jobs run under a worker-level `concurrency` setting (a tunable number, not tied to any external rate limit — unlike the embedding-batch jobs elsewhere in the platform, this stage calls no external API; it's local CPU/filesystem work, so the bound exists only to cap memory/CPU pressure on the worker host).

```
KnowledgeDomain config (archiveUrl, format, globs)
        │
        ▼
┌───────────────────┐
│ download-archive   │  (skipped if source is a local file path)
└─────────┬──────────┘
          ▼
┌───────────────────┐
│ extract-archive    │  BullMQ Flow parent — fans out one process-file
│ (Flow parent)      │  child job per matched entry
└─────────┬──────────┘
          ▼ (per file, bounded worker concurrency)
┌───────────────────────────────────────────────────────────┐
│ process-file (Flow child): Clean → Parse → Metadata →      │
│ Assemble → upsert Document (content-hash gated)             │
└─────────┬───────────────────────────────────────────────────┘
          ▼ (parent's own step runs once ALL children complete)
   diff current file set vs. previously-ingested sourceUris for
   this domain → mark any missing ones Document.status = 'stale'
          ▼
   emit DocumentsIngested → existing chunking/embedding pipeline
```

---

## 2. Services

| Service                             | Responsibility                                                                                                                                                                                                                                                                                                                                                         | Must NOT do                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **`ArchiveExtractionService`**      | Streams entries out of an archive (ZIP today) into a bounded, guaranteed-cleaned-up temp workspace; enforces size/entry-count safety limits (zip-bomb protection); rejects any entry whose resolved path escapes the extraction root (zip-slip protection — see §8); filters entries against the domain's configured include/exclude globs.                            | Know what a "document" is, parse content, or care about file format beyond byte-level filtering.  |
| **`DocumentCleaningService`**       | Selects a format-specific `CleaningStrategy` and strips boilerplate (nav/sidebar/footer for HTML; separates front-matter for Markdown/MDX), normalizes whitespace/line endings, decodes entities.                                                                                                                                                                      | Parse structure (headings, code blocks) — that's the parser's job.                                |
| **`DocumentParsingService`**        | Selects a format-specific `ParsingStrategy` and extracts structure: title, heading tree, body text, code blocks (with language tags), link references.                                                                                                                                                                                                                 | Touch the filesystem, generate metadata, or know about content hashing.                           |
| **`MetadataGenerationService`**     | Derives `DocumentMetadata` from the parsed structure plus ingestion context: content hash (SHA-256 of the _cleaned_ text — the `CleaningStrategy`'s output, not the raw archive-entry bytes, so identical content re-packed into a different archive still hashes identically), word count, language, heading outline, front-matter passthrough, extraction timestamp. | Decide document identity (`documentId` derivation lives in assembly) or persist anything.         |
| **`DocumentAssemblyService`**       | Combines parsed content + metadata into the final `StructuredDocument`, derives the deterministic `documentId`, validates required fields (non-empty title/body) before handoff.                                                                                                                                                                                       | Write to Postgres directly — assembly produces a DTO; a separate repository does the persistence. |
| **`IngestionPipelineOrchestrator`** | Wires the above into the BullMQ job chain per domain; owns job-state transitions on `IngestionJob`; decides per-file vs. whole-archive failure handling (§8); after all `process-file` children complete, diffs the current archive's file set against previously-ingested `sourceUri`s for the domain and marks any that are now missing as stale (§5).               | Contain any format- or source-specific logic itself — it only sequences ports/services.           |

---

## 3. Interfaces (Ports)

All ports live in the domain lib that consumes them, per the platform architecture's dependency-inversion rule; adapters/strategies live in `libs/adapters/*` and are selected via DI tokens or a lookup-by-key registry (never a big if/else in the orchestrator).

- **`DocumentLoaderPort`** (already defined at the platform level) — `load(config): AsyncIterable<RawFile>`. Implemented here by **`ArchiveLoaderAdapter`** (deliberately named for the general case, not `ZipArchiveLoaderAdapter`): takes an `archiveFormat` key (`'zip'` today) and delegates to a pluggable `ArchiveFormatPort` for the actual extraction mechanics. Adding tar/gzip later means one new `ArchiveFormatPort` implementation, not a new loader.
- **`ArchiveFormatPort`** — `openEntries(archivePath): AsyncIterable<ArchiveEntry>`, `readEntryContent(entry): Promise<Buffer>`. Adapter: **`ZipFormatAdapter`**, built on `yauzl`'s promise-based `eachEntry()`/`openReadStreamPromise()` API — confirmed current and actively maintained via its own documentation, specifically chosen because it streams one entry at a time (`lazyEntries`) rather than reading the whole archive into memory, which matters once Docker's doc archive grows.
- **`CleaningStrategyPort`** — `clean(raw: RawFile): CleanedFile`. Adapters: **`MarkdownCleaningAdapter`**, **`HtmlCleaningAdapter`**, selected by `FormatDetector`. Division of labor: `ArchiveExtractionService` sets `RawFile.mimeTypeHint` as a cheap best-guess from the file extension; `FormatDetector` makes the definitive call (hint + content sniffing) and can override the hint — so a misnamed `.txt` file containing HTML still resolves correctly.
- **`ParsingStrategyPort`** — `parse(cleaned: CleanedFile): ParsedDocument`. Adapters: **`MarkdownParsingAdapter`** (built on `unified` + `remark-parse`, walking the resulting `mdast` tree via `unist-util-visit` to pull headings/code blocks/links), **`HtmlParsingAdapter`** (built on `cheerio`, already adopted at the platform level for the web-crawler loader — reused here, not a new dependency).
- **`MetadataGeneratorPort`** — `generate(parsed: ParsedDocument, context: IngestionContext): DocumentMetadata`. One default implementation; format-agnostic (operates on the already-normalized `ParsedDocument` shape, never on raw markdown/HTML).
- **`DocumentAssemblerPort`** — `assemble(parsed: ParsedDocument, metadata: DocumentMetadata): StructuredDocument`. One default implementation.

**Extensibility mechanism (ties directly to the stated requirement):** a new file format needs only a new `CleaningStrategyPort` + `ParsingStrategyPort` pair registered against a MIME/extension key in `FormatDetector`'s lookup table. A new archive format needs only a new `ArchiveFormatPort` implementation. A new source that isn't an archive at all (e.g., a live API) needs only a new `DocumentLoaderPort` implementation, exactly as the platform architecture already anticipated for the web-crawler and git-repo loaders. The orchestrator, entities, and DTOs never change.

---

## 4. DTOs

All DTOs are plain, serializable shapes — no methods, no framework decorators — so they cross BullMQ job boundaries (which serialize job data as JSON) without loss.

- **`RawFile`** — `{ sourcePath, content: Buffer, mimeTypeHint?, archiveEntryMetadata: { compressedSize, uncompressedSize, lastModified } }`
- **`CleanedFile`** — `{ sourcePath, text: string, format: 'markdown' | 'html' | 'mdx', frontMatter?: Record<string, unknown> }`
- **`HeadingNode`** — `{ level, text, anchor, children: HeadingNode[] }`
- **`CodeBlock`** — `{ language, content, position }`
- **`ParsedDocument`** — `{ sourcePath, title, headings: HeadingNode[], bodyText, codeBlocks: CodeBlock[], links: string[] }`
- **`DocumentMetadata`** — `{ title, sourcePath, contentHash, wordCount, language, headingOutline, frontMatter, extractedAt, sourceVersion }`
- **`StructuredDocument`** — `{ documentId, domainId, metadata: DocumentMetadata, headings: HeadingNode[], bodyText, codeBlocks: CodeBlock[], rawFormat }` — this is the literal "Structured Documents (JSON)" the requested pipeline ends at; see §6 for where it's persisted.
- **`IngestionContext`** — `{ domainId, jobId, archiveChecksum, ingestedAt }` — threaded through the pipeline so every stage can attach correlation data without each service needing its own copy of job/domain lookup logic.

---

## 5. Entities

| Entity                                                             | Fields                                                                                                                                                                                                                                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`Document`** (platform-level, **amended here** — see note below) | `id (= documentId)`, `domainId`, `sourceUri (= sourcePath within archive)`, `contentHash`, `title`, `content: StructuredDocument` (JSONB — see §6), `ingestedAt`, `version`, `status: 'pending' \| 'processed' \| 'stale' \| 'failed'` | Upserted keyed by `id`; a new ingestion run with an unchanged `contentHash` is a no-op write, matching the platform's incremental-reingestion design. `status: 'stale'` is set by `IngestionPipelineOrchestrator` when a previously-ingested `sourceUri` is absent from the latest archive (§1) — the row is kept, not deleted, so retrieval/chunking can decide how to treat stale content rather than losing history silently. |
| **`IngestionJob`** (platform-level, detailed here)                 | `id`, `domainId`, `archiveChecksum`, `status: 'queued' \| 'extracting' \| 'processing' \| 'completed' \| 'failed'`, `attemptCount`, `lastError`, `failedFiles: string[]`, `startedAt`, `completedAt`                                   | One row per archive-ingestion run, not per file — file-level outcomes roll up into `failedFiles` rather than each getting their own job row. `attemptCount` increments on this same row across BullMQ retries of the same job; a fresh scheduled ingestion (not a retry) creates a new row referencing a (possibly new) `IngestionArchive`.                                                                                      |
| **`IngestionArchive`** (new)                                       | `id`, `domainId`, `sourceUrl`, `checksum` (SHA-256 of the archive itself), `downloadedAt`, `entryCount`, `status`                                                                                                                      | Archive-level dedup: if a re-triggered ingestion downloads a byte-identical archive to one already fully processed, the whole extract/process phase is skipped — a cheaper, coarser gate than the per-document `contentHash` check.                                                                                                                                                                                              |

`documentId` is a deterministic hash of `domainId + sourcePath` (not a random UUID) — this is what makes re-ingestion idempotent: the same source file always maps to the same `Document` row, so retries and repeated runs update in place rather than duplicating.

**Amendment to the platform architecture's `Document` entity:** the top-level architecture doc defines `Document` with a `sourceMetadata` field. This design supersedes that with `content: StructuredDocument` — a JSONB column holding the _entire_ structured output (metadata **and** body text **and** headings **and** code blocks), not just metadata, since the platform doc's chunking step needs the body text (`content.bodyText`) as its input and keeping everything in one column avoids a second lookup. The platform doc's entity list should be read as amended by this section for archive-based domains; `rag-platform-architecture.md` has been updated to match (see its Core Entities section).

**Retention:** this design does not specify a cleanup/retention policy for `IngestionJob`/`IngestionArchive` history rows, which grow unboundedly across scheduled re-ingestions. Not a blocker for the first implementation — revisit if row growth becomes an operational concern.

---

## 6. File Storage Strategy

Three separate storage decisions, each made independently rather than defaulting to "put everything in object storage":

1. **Extraction workspace — local ephemeral temp directory, not shared/object storage.** Each `process-file` job's Clean→Parse→Metadata→Assemble sequence runs to completion synchronously within one worker process invocation; nothing needs to read a partially-processed file from a _different_ process. `ArchiveExtractionService` extracts into `os.tmpdir()/ingestion-<jobId>/`, wrapped in a try/finally that removes the directory on both success and failure. **Migration trigger:** if archives grow large enough that per-file processing needs to fan out across multiple worker machines mid-archive (not just concurrent jobs on one machine), revisit with shared/object storage. Not justified today — Docker's documentation archive is a few thousand small text files, not a multi-GB dataset.
2. **The raw archive itself — not persisted by default.** Re-downloading from the source on the next scheduled ingestion is cheap and simple; introducing object storage (S3/MinIO) purely for archive audit trail would add a new infrastructure dependency the rest of the platform doesn't otherwise need yet. **Migration trigger:** if the source archive is ever mutable/non-versioned at its URL (so "what exact snapshot produced this ingestion" becomes unanswerable after the fact) or a compliance/audit requirement appears, add archive persistence then — `IngestionArchive.checksum` already gives a ready-made object key if that day comes.
3. **The `StructuredDocument` JSON — a Postgres JSONB column on `Document`, not a separate file store.** Doc pages are text (with embedded code blocks), not binary — well within JSONB's practical size range, and keeping it in Postgres means one query answers "give me this document's full structured content," with no second storage system to keep consistent with the metadata row. **Migration trigger:** if document bodies start regularly exceeding a few MB (unlikely for documentation text) or object storage gets adopted platform-wide for another reason, move `content` to object storage with a pointer column instead.

---

## 7. Metadata Model

`DocumentMetadata` is deliberately format- and source-agnostic everywhere except one field:

- `title`, `sourcePath`, `contentHash`, `wordCount`, `extractedAt` — universal, computed the same way regardless of source. `contentHash` and `wordCount` are both derived from the _cleaned_ text (§2), not raw archive bytes, so they're stable against irrelevant repackaging differences.
- `language` — no NLP language-detection library is introduced for this. Precedence: the front-matter `lang`/`language` field if present, otherwise a configured per-domain default (e.g. `'en'` for Docker). A real detection library is a future addition if a domain with genuinely mixed-language content shows up — not justified for a documentation set that's practically all one language.
- `headingOutline` — the flattened `HeadingNode` tree, universal (every text-based doc format has _some_ notion of headings once parsed).
- `sourceVersion` — the `IngestionArchive.checksum` this document came from, universal (every archive-based source has a version/checksum).
- `frontMatter: Record<string, unknown>` — the **one** deliberately-generic escape hatch. Docker's Markdown front-matter (e.g. `title`, `description`, `keywords`, product-version tags) passes through here untouched. A future source with a completely different front-matter schema (or none at all) just populates this bag differently or leaves it empty — nothing in the shared `DocumentMetadata` shape, `MetadataGenerationService`, or downstream chunking code needs to know Docker's specific front-matter keys.

---

## 8. Error Handling

**Per-file failures do not fail the archive.** A single malformed or unparseable file is isolated: the failure is recorded in `IngestionJob.failedFiles`, logged at `warn`, and processing continues with the remaining files. Only if the failure rate crosses a threshold (**>50% of matched files fail**) is the whole job marked `failed` — a high failure rate signals a systemic problem (wrong glob pattern, unexpected archive layout), not a one-off bad file, and continuing to "succeed" while quietly dropping most of the archive would be worse than failing loudly.

**Archive-level failures fail the job immediately, no partial extraction attempted:** download failure, corrupt/unreadable ZIP, the size/entry-count safety limit being exceeded (zip-bomb protection — reject before extracting if the archive's stated uncompressed size or entry count exceeds a configured ceiling), or **any entry whose resolved extraction path escapes the extraction root** (zip-slip protection — a single such entry aborts the whole archive rather than being silently skipped, since its presence indicates a malformed or malicious archive, not an isolated bad file).

**Error taxonomy** (each extends a `DomainError` base per the platform's established coding standard, carrying `domainId`/`jobId`/`sourcePath` context):

| Error                            | Raised when                                                                                  |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| `ArchiveDownloadError`           | Remote fetch of the archive fails (network, 4xx/5xx).                                        |
| `ArchiveCorruptError`            | The archive fails to open/parse as a valid ZIP.                                              |
| `ArchiveSizeLimitExceededError`  | Declared entry count or uncompressed size exceeds the configured safety ceiling.             |
| `ArchiveEntryPathTraversalError` | An entry's resolved path escapes the extraction root (zip-slip).                             |
| `FileCleaningError`              | A `CleaningStrategy` throws on a specific file (isolated, doesn't propagate past that file). |
| `FileParsingError`               | A `ParsingStrategy` throws on a specific file (isolated).                                    |
| `MetadataGenerationError`        | Metadata derivation fails for a specific file (isolated).                                    |
| `DocumentAssemblyError`          | Required-field validation fails at assembly (isolated).                                      |

This is a background job pipeline, not an HTTP request path — there is no `GlobalExceptionFilter` equivalent here. Archive-level errors propagate to BullMQ's job-failure handling (§10); file-level errors are caught at the `process-file` job boundary and recorded, never thrown past it.

---

## 9. Logging

Structured Pino logging (matching the platform's established convention — every line carries `domainId` and `jobId`, plus `sourcePath` when the log is file-scoped):

- Stage-transition logs at `info`: job started, archive downloaded, archive extracted (`entryCount`), each file's clean/parse/metadata/assemble completion, job completed.
- File-level failures at `warn` (expected/recoverable at scale — an isolated bad file shouldn't page anyone).
- Archive-level failures at `error`.
- One aggregate summary log at job completion: `{ totalFiles, succeeded, failed, skipped, durationMs }` — this is the single line an operator actually wants when checking "did last night's Docker docs refresh work."

---

## 10. Retry Strategy

- **Whole-job retries** use BullMQ's built-in exponential backoff for transient failures (archive download network error, transient Postgres write failure) — same mechanism the platform architecture already specifies for embedding-batch jobs. Default: 3 attempts, backoff `30s → 2min → 10min`, configurable per domain via `KnowledgeDomain` config (consistent with the platform's config-driven-per-domain philosophy). After exhausting retries, the job lands in a dead-letter state for manual inspection, per the platform's existing dead-letter-queue pattern.
- **Per-file failures within a successful job run are not retried in-place** — they're recorded and skipped (§8). They get naturally retried on the _next_ scheduled ingestion of that domain, since a failed file has no recorded `contentHash` and is therefore reprocessed rather than skipped as unchanged.
- **Idempotency is structural, not a retry special-case:** because `documentId` is a deterministic hash and every write is content-hash-gated, re-running the same archive (whether via retry, a scheduled re-crawl, or manual re-trigger) never creates duplicate `Document` rows and never re-processes unchanged files.

---

## 11. Folder/Module Layout

Extends the platform architecture's existing `libs/` structure — no new top-level directories:

```
libs/
  adapters/
    loaders/
      archive/                  # ArchiveLoaderAdapter + ZipFormatAdapter (ArchiveFormatPort impl)
  domain/
    ingestion/
      pipeline/
        cleaning/                # CleaningStrategyPort + markdown/html adapters, FormatDetector
        parsing/                 # ParsingStrategyPort + markdown/html adapters
        metadata/                # MetadataGeneratorPort + default implementation
        assembly/                # DocumentAssemblerPort + default implementation
      entities/                  # Document, IngestionJob, IngestionArchive
      dtos/                      # RawFile, CleanedFile, ParsedDocument, StructuredDocument,
                                  #   DocumentMetadata, IngestionContext, HeadingNode, CodeBlock
```

---

## 12. Required npm Packages (additions to the platform's existing list)

| Package                                       | Purpose                                                                                                                                                                                                        |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `yauzl`                                       | Streaming ZIP entry iteration (`eachEntry()`/`openReadStreamPromise()`) without loading the whole archive into memory — confirmed current, actively maintained, purpose-built for exactly this access pattern. |
| `unified`, `remark-parse`, `unist-util-visit` | Markdown → `mdast` AST parsing and traversal, for extracting headings/code blocks/links in `MarkdownParsingAdapter`.                                                                                           |
| `cheerio`                                     | HTML parsing for `HtmlParsingAdapter` — already adopted at the platform level for the web-crawler loader; reused here, not a new dependency.                                                                   |
| `gray-matter`                                 | Front-matter extraction for Markdown/MDX — already in the platform's package list; reused in `MarkdownCleaningAdapter`.                                                                                        |

No object-storage client (S3/MinIO) is added — see §6's storage-strategy reasoning.

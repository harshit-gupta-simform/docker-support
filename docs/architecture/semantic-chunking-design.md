# Semantic Document Chunking — Design

**Scope:** the next bounded context after Document Ingestion — transforming a `StructuredDocument` (produced by `IngestionPipelineService`, see [`document-ingestion-subsystem-design.md`](./document-ingestion-subsystem-design.md)) into an ordered array of retrieval-optimized `Chunk` objects. This document is design-only, per explicit instruction: no source files are created or modified as part of it.

**Relationship to the platform architecture:** [`rag-platform-architecture.md`](./rag-platform-architecture.md) defines a `Chunk` entity and a `ChunkingPort` wrapping `@langchain/textsplitters`. This document supersedes that sketch for the concrete implementation: it defines a purpose-built, dependency-light chunker instead of a LangChain splitter (justified in §1.4), and a richer `Chunk`/`ChunkMetadata` shape than the platform doc's placeholder fields. Embeddings, the vector store, and `EmbeddingProviderPort`/`VectorStorePort` remain entirely out of scope and untouched.

---

## 0. Investigation — the existing `StructuredDocument` model

Read directly from `src/ingestion/ingestion.types.ts`, `markdown-parser.service.ts`, and `ingestion-pipeline.service.ts` before designing anything below. Three facts drive the whole design:

1. **`bodyText` is the only structurally-complete field.** It is the _entire_ cleaned Markdown document as one string (post front-matter-stripping, whitespace-normalized), produced by `DocumentCleanerService` and passed through `MarkdownParserService.parse()` unchanged (`bodyText: text` — `markdown-parser.service.ts:87`). Nothing lossy has happened to it yet.
2. **`headings: HeadingNode[]` and `codeBlocks: CodeBlock[]` are lossy, disconnected summaries, not a structural index.** `HeadingNode` (`{ level, text, anchor, children }`) has no offset into `bodyText` and no reference to which content belongs under it. `CodeBlock` (`{ language, content, position }`) has a `position` field that is only a sequential counter (`codePosition += 1` per fence encountered document-wide — `markdown-parser.service.ts:66-68`), not an offset into `bodyText` and not a link to an enclosing heading. **Neither list is sufficient, on its own, to slice `bodyText` into sections.** This is the single most important finding: the chunker cannot reuse ingestion's `headings`/`codeBlocks` as a structural index — it must re-derive structure itself.
3. **`documentId` is a deterministic SHA-256 of `sourcePath`** (`ingestion-pipeline.service.ts:102-104`), and `DocumentMetadata.contentHash` is a SHA-256 of the cleaned text (`metadata-generator.service.ts`). Both are stable, source-of-truth identifiers the chunker should reuse rather than re-derive differently.

**Design consequence:** the chunker's first internal stage re-tokenizes `StructuredDocument.bodyText` with `markdown-it` (already a project dependency, already proven CJS-compatible) to build its own **Section Tree** with real content ownership and ordering — it does not attempt to reconcile or reuse ingestion's `headings`/`codeBlocks` arrays. Those two fields remain useful only as a cheap outline/preview elsewhere in the system; the chunker treats `bodyText` as its sole input alongside `documentId` and `metadata` (for context enrichment, not for structure).

This also directly satisfies requirement 14 (future documentation sources): as long as a future source's `DocumentLoaderPort`/parsing stage still produces a `StructuredDocument` with a Markdown-ish `bodyText`, chunking needs zero changes. If a future source is fundamentally non-Markdown (e.g., a PDF or a video transcript), that is an ingestion-side parsing problem — it would still need to normalize into `bodyText`, or the chunker would need a second `SectionParserPort` implementation (see §1.4 and §3) for that format, never a change to the chunking algorithm itself.

---

## 1. Architecture Proposal

### 1.1 Comparison of chunking strategies

| #     | Strategy                                                                   | How it works                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Verdict for Docker-style technical docs                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** | **Fixed-size chunking**                                                    | Split raw text into equal-sized windows (e.g. every 500 characters), usually with a fixed overlap.                                                                                                                                                                                                                                                                                                                                                                                                                   | **Rejected.** Structure-blind by construction — will split mid-command, mid-table-row, or mid-code-fence with no way to prevent it. Directly violates requirements 1, 2, 3, 4, 5, 6.                                                                                                                                                                                                                                                                     |
| **B** | **Recursive chunking** (e.g. LangChain's `RecursiveCharacterTextSplitter`) | Try splitting on a priority list of separators (`\n\n`, `\n`, `. `, `""`) recursively until each piece is under a size limit.                                                                                                                                                                                                                                                                                                                                                                                        | **Rejected, better than A but still insufficient.** It respects _paragraph_ boundaries but has no concept of "this is a code fence" or "this is a table row" — a long code block is just a long paragraph to it and will still be split mid-block. Has no heading-hierarchy awareness at all: it cannot emit a heading path or parent/child relationship because it never parses structure, only text patterns. Violates 1, 2, 4, 5.                     |
| **C** | **Semantic chunking**                                                      | Embed adjacent sentences, split where cosine similarity between consecutive sentence embeddings drops below a threshold.                                                                                                                                                                                                                                                                                                                                                                                             | **Disallowed by the brief** ("Do not use embeddings") and independently a poor fit: it requires calling an embedding model to _produce_ chunks (violates requirement 12 — testable without an LLM/embedder — and couples the chunker to a specific embedding model, violating requirement 10). Embedding-model updates would silently change chunk boundaries, breaking determinism (requirement 7).                                                     |
| **D** | **Heading/structure-aware chunking**                                       | Parse the document's heading tree; emit exactly one chunk per section (a heading plus everything under it, down to the next heading of equal-or-higher level).                                                                                                                                                                                                                                                                                                                                                       | **Structurally correct, but incomplete on its own.** Perfectly satisfies 1, 2, 4, 5, 6 — but has no size ceiling or floor. A long "Install Docker Engine" section with a dozen sub-steps becomes one giant chunk that may exceed a downstream embedding model's context window and dilutes retrieval precision (too many unrelated facts compressed into one vector). Conversely, a one-line "## See also" section becomes a wasteful, low-signal chunk. |
| **E** | **Hybrid structure-aware + size-bounded chunking**                         | Start from D's section tree. Within each section, group content into ordered, typed **content blocks** (paragraph, code, list, table, note/warning). Emit one chunk per section if it fits a configured size band; if oversized, split it _at content-block boundaries only_ (never inside a code fence or table row); if undersized, merge it with adjacent sibling sections under the same parent. Attach full heading-path and parent/child metadata to every chunk regardless of whether it was split or merged. | **Chosen.** The only strategy that satisfies all 14 stated requirements simultaneously, using no embeddings, no LLM, and no vector database.                                                                                                                                                                                                                                                                                                             |

### 1.2 Chosen architecture: E — Hybrid structure-aware + size-bounded chunking

**Why not stop at D:** retrieval quality in a real RAG system depends on chunk size being roughly uniform and bounded — both for embedding-model context limits and for keeping each vector's semantic content focused enough to rank well against a query. Pure structure-aware chunking (D) is _correct_ but not _retrieval-ready_; E adds the size discipline D lacks, without sacrificing any of D's structural guarantees, because every split/merge decision in E is still made _along_ structural boundaries, never through them.

**Why this needs no LangChain:** LangChain's splitters (`RecursiveCharacterTextSplitter`, `MarkdownHeaderTextSplitter`) solve _generic_ text/Markdown splitting. This design's hard requirements — never split a code fence, never split a table row, merge only within the same parent heading, emit explicit parent/child chunk relationships, attach a rich first-class metadata schema — are specific enough to this project's technical-documentation domain that adopting LangChain would mean fighting its abstractions (subclassing/monkey-patching its splitter to special-case code fences and tables) rather than being helped by them. The platform architecture's own package-adoption philosophy (§1 of `rag-platform-architecture.md`) already commits to LangChain only where "it provides clear value" — chunking is not that place. The one place LangChain _was_ judged worth it, `@langchain/textsplitters` for size-bounded prose splitting, is not needed either: §5 below shows the size-bounding sub-algorithm is a straightforward content-block-boundary walk, not a generic text-splitting problem.

**Three-phase pipeline:**

```
StructuredDocument.bodyText
        │
        ▼
┌─────────────────────────┐
│ Phase 1: Section Parsing │  markdown-it tokenize → Section tree with
│ (structure-aware)        │  ordered, typed ContentBlock[] per section
└────────────┬─────────────┘
             ▼
┌─────────────────────────┐
│ Phase 2: Size Bounding   │  split oversized sections at ContentBlock
│ (size-bounded)           │  boundaries; merge undersized sibling sections
└────────────┬─────────────┘
             ▼
┌─────────────────────────┐
│ Phase 3: Chunk Assembly  │  attach metadata, heading path, parent/child
│                          │  links, deterministic IDs, optional overlap
└────────────┬─────────────┘
             ▼
        Chunk[] (JSON, one array per document)
```

### 1.3 Bounded-context boundary

Chunking is a new bounded context, `src/chunking/`, that **depends on** Ingestion's output type (`StructuredDocument`, imported as a type-only dependency) but is otherwise fully decoupled:

- **Independent of the embedding provider (req. 10):** the chunker never calls an embedding API. Length measurement (§6) is behind a small internal port so a precise tokenizer for a _specific_ embedding model can be swapped in later without touching the chunking algorithm.
- **Independent of the vector database (req. 11):** `Chunk` is a plain serializable DTO. Nothing in this design imports a vector-store client or knows about upsert/collection semantics — that is entirely `VectorStorePort`'s concern, downstream and out of scope.
- **Testable without an LLM (req. 12):** every stage operates on plain strings/token arrays with pure functions or narrowly-scoped injectable services; no network calls anywhere in the chunking path.

### 1.4 Why concrete services, not a full ports-and-strategies layer

Following this project's established precedent from the ingestion MVP (concrete services over premature port/strategy abstractions for a single-format system — see `document-ingestion-subsystem-design.md` §3 vs. the actual flat `src/ingestion/` implementation): chunking today has exactly one input shape (`StructuredDocument.bodyText`, Markdown) and exactly one algorithm (E). Introducing a `ChunkingStrategyPort` with pluggable A–E implementations would be speculative — nothing in this project ever runs strategy B or D standalone. Two genuine seams _are_ worth a real interface, because they have a concrete, foreseeable second implementation:

- **`LengthMeasurerPort`** (§6) — a real port, because swapping in a model-specific tokenizer (e.g., `js-tiktoken` for an OpenAI embedding model) is a near-certain future need once an `EmbeddingProviderPort` adapter is chosen, and the algorithm must not change when that happens.
- **`SectionParserPort`** (§0, §2) — a real port, because a genuinely non-Markdown future source (not just a new Markdown-based domain, which needs zero changes) would need a second implementation, exactly mirroring how `ArchiveFormatPort` was reserved in the ingestion design for a future non-ZIP archive format.

Everything else (content-block classification, the size-bounding split/merge algorithm, ID derivation) is one concrete implementation each, matching this codebase's "concrete services, single responsibility" convention (`ChunkingConfigService`, `MarkdownSectionParserService`, `SectionSizeBounderService`, `ChunkAssemblerService`, `ChunkingPipelineService` — see §7).

---

## 2. Domain Model

### 2.1 Internal working model (Phase 1 output — not persisted)

```typescript
type ContentBlockType = 'paragraph' | 'code' | 'list' | 'table' | 'note'; // blockquote-style admonitions: **Note:**, **Warning:**, > callouts

interface ContentBlock {
  type: ContentBlockType;
  text: string; // the block's literal Markdown source, verbatim
  language: string | null; // only meaningful when type === 'code'
  length: number; // measured by the configured LengthMeasurerPort
}

interface HeadingPathSegment {
  level: number;
  text: string;
  anchor: string;
}

interface Section {
  headingText: string; // '' for the implicit root section before any heading
  headingLevel: number; // 0 for the implicit root section
  anchor: string; // slugified heading, '' for root
  headingPath: HeadingPathSegment[]; // ancestors + self, root section = []
  blocks: ContentBlock[]; // this section's own content, NOT including child sections'
  children: Section[]; // nested subsections, in document order
}
```

**Correction from an earlier draft of this design:** `Section.headingPath` is typed as `HeadingPathSegment[]` (level + text + anchor per ancestor), not bare heading-text strings. This matters because §9's `chunkId` derivation and the public `ChunkMetadata.headingPath` (§2.2) both need each ancestor's `anchor`, not just its text — and `Section` carries no parent back-pointer, so if `headingPath` only stored text, Phase 3 would have no way to recover the missing level/anchor data for each ancestor. Instead, `headingPath` is built incrementally during the Phase 1 heading-stack walk (§4.1): when a new heading is pushed onto the stack, its `Section.headingPath` is computed once, up front, as `[...parentSection.headingPath, { level, text: headingText, anchor }]` — trivial, since the parent's own `headingPath` and the new heading's `level`/`text`/`anchor` are all already in hand at that exact point in the walk. `ChunkMetadata.headingPath` (§2.2) is then a direct, unmodified copy of `Section.headingPath` — no reconstruction step, no second type, no ambiguity.

`Section` is the direct output of Phase 1 (§4.1) and the input to Phase 2 (§4.2). It never leaves the chunking module — it is not serialized or exposed to callers. This mirrors the ingestion module's internal-only `ParsedDocument`/`CleanedFile` types, which likewise never appear in the module's public output.

### 2.2 Public output model (what `ChunkingPipelineService` returns and persists)

```typescript
type ChunkType = 'parent' | 'child';

// HeadingPathSegment is defined once, in §2.1 — ChunkMetadata.headingPath below
// is a direct, unmodified copy of the originating Section's headingPath.

interface ChunkRelationships {
  parentChunkId: string | null; // see below — always null on 'parent'-type chunks
  childChunkIds: string[]; // populated only on 'parent'-type chunks; see below
  previousChunkId: string | null; // previous 'child'-type chunk in whole-document reading order (§4.3 step 5); always null on 'parent'-type chunks
  nextChunkId: string | null; // next 'child'-type chunk in whole-document reading order; always null on 'parent'-type chunks
}

interface ChunkMetadata {
  documentId: string; // copied from StructuredDocument.documentId — never re-derived
  sourcePath: string; // copied from StructuredDocument.metadata.sourcePath
  documentTitle: string; // copied from StructuredDocument.metadata.title
  headingPath: HeadingPathSegment[]; // full ancestor chain, direct copy of Section.headingPath (§2.1); root section = []
  chunkType: ChunkType;
  contentTypes: ContentBlockType[]; // distinct block types present, in first-seen order
  length: number; // per the configured LengthMeasurerPort
  sequenceIndex: number; // 0-based position among this document's 'child'-type chunks only, in whole-document reading order (matches previousChunkId/nextChunkId's ordering, §4.3 step 5); 'parent'-type chunks do not consume a sequenceIndex
  wasSplit: boolean; // true if this chunk is one of several pieces of an oversized section
  wasMerged: boolean; // true if this chunk absorbed one or more undersized sibling sections
  mergedHeadings: string[]; // headingTexts of any sections folded into this chunk beyond its own; [] if wasMerged is false
  exceedsMaxSize: boolean; // true if a single unsplittable unit — a code fence, a note/warning block, or (rarely) one oversized list item — alone exceeds maxChunkSize. Never true for a table, which is always split by row instead (§5.1)
  contentHash: string; // SHA-256 of this chunk's own text — for downstream dedup/change-detection, mirroring DocumentMetadata.contentHash
  chunkedAt: string; // ISO timestamp of the chunking run, informational only — excluded from chunkId derivation (§9) AND from the determinism comparison (§10)
}

interface Chunk {
  chunkId: string; // deterministic, see §9
  text: string; // the chunk's full literal Markdown text, headingPath's own heading line included at the top
  metadata: ChunkMetadata;
  relationships: ChunkRelationships;
}

interface ChunkingResult {
  documentId: string;
  chunks: Chunk[];
  totalSections: number;
  splitSections: number;
  mergedSections: number;
  durationMs: number;
}
```

**Design notes:**

- **`text` includes its own heading line.** A chunk that reads only "Run the following command to verify the installation:\n\n`bash\ndocker --version\n`" is useless without knowing it's under "Install Docker Engine → Verify the installation" — so every chunk's `text` is prefixed with its own heading (`## Verify the installation`), and `metadata.headingPath` carries the full ancestor chain for chunks that need the _ancestors'_ headings too (e.g. for prompt assembly later, joined as breadcrumbs: "Install Docker Engine › Verify the installation").
- **Parent/child retrieval (req. 9) — the full relationship model, stated precisely (an earlier draft of this design left this ambiguous):**
  - A `'parent'`-type chunk is emitted once per `Section` (§4.3 step 3), holding that section's _entire_ content — its own blocks plus every descendant section's content, concatenated in document order, uncapped by `maxChunkSize`.
  - **`'parent'`-type chunks never nest into their own hierarchy.** A `'parent'` chunk's own `relationships.parentChunkId` is always `null`, even for a deeply-nested section — because its `text` already contains its full subtree, a consumer wanting "the next level up" reads the _ancestor section's own_ `'parent'` chunk directly (found via `metadata.headingPath`, which already names every ancestor), not via an ID-chase through nested parent chunks. This keeps the relationship model to exactly one hop (child → its own section's parent) instead of an open-ended walk.
  - A `'parent'` chunk's `relationships.childChunkIds` contains **only** the `'child'`-type chunk IDs produced directly from that section's _own_ blocks (i.e., exactly what `boundSection`/`splitAtBlockBoundaries` produced for this section alone, before considering any descendant section) — never a descendant section's child chunks, and never another section's `'parent'`-type chunk ID.
  - **If a section's own content was folded into a sibling's chunk by the merge pass (§5.2)**, that section still gets its own `'parent'`-type chunk (built from the untouched `Section` tree, independent of Phase 2's merge decisions) — but its `childChunkIds` is `[]`, since no `'child'`-type chunk uniquely represents that section alone anymore. The section's content is still fully recoverable two ways: from its own `'parent'`-type chunk's `text` (unaffected by merging), or from the sibling's merged chunk, discoverable via that chunk's `metadata.mergedHeadings`.
  - A `'child'`-type chunk's `relationships.parentChunkId` is the ID of its own section's `'parent'`-type chunk (or `null` if `CHUNKING_INCLUDE_PARENT_CHUNKS` is `false`, in which case no `'parent'`-type chunks exist at all). Its own `childChunkIds` is always `[]`.
  - `CHUNKING_INCLUDE_PARENT_CHUNKS` (§8) makes the whole `'parent'`-chunk layer opt-outable if a future consumer only ever wants flat chunks.
- **`relationships.previousChunkId`/`nextChunkId` link `'child'`-type chunks in whole-document reading order, not sibling-within-a-section order** (again, stated precisely to remove an earlier ambiguity): they are assigned by one linear pass over the _final, complete_ sequence of `'child'`-type chunks (§4.3 step 5), so the last chunk of one section's `nextChunkId` can point into the first chunk of the following, unrelated section — this is intentional: size-bounded splitting means a single logical section can become 3-4 sequential `'child'` chunks, and a retriever wanting "the paragraph just after" a matched chunk needs a single, unambiguous document-wide chain without needing to know or re-derive section boundaries. Both fields are always `null` on `'parent'`-type chunks — parent-to-parent sequencing is not a supported traversal (use `headingPath` for that, as above).

---

## 3. Chunking Interfaces (Ports)

Per §1.4, only two real ports; everything else is a concrete class.

```typescript
// SectionParserPort — one implementation today (Markdown), a documented seam for a
// genuinely non-Markdown future source. NOT used to add new documentation *domains*
// (Kubernetes, Terraform) — those stay Markdown and need zero new code here.
interface SectionParserPort {
  parse(bodyText: string): Section; // returns the implicit root Section
}

// LengthMeasurerPort — swappable length/token-estimation strategy, kept independent
// of any specific embedding provider's real tokenizer (req. 10).
interface LengthMeasurerPort {
  measure(text: string): number;
}
```

`SectionParserPort` is implemented by `MarkdownSectionParserService` (§4.1). `LengthMeasurerPort` is implemented by `ApproximateTokenLengthMeasurer` by default (§6), selected via `ChunkingConfigService`.

---

## 4. Section-Aware Chunking Algorithm

### 4.1 Phase 1 — Section parsing (structure-aware)

`MarkdownSectionParserService.parse(bodyText: string): Section` re-tokenizes `bodyText` with the same `markdown-it` instance style already used by `MarkdownParserService`, but instead of flattening into `headings`/`codeBlocks` arrays, it builds the nested `Section` tree directly:

1. Walk the token stream maintaining a **heading stack** (same pop-while-`level >= top.level` technique already proven in `MarkdownParserService.parse` — reused conceptually, not by import, since the ownership semantics differ: ingestion's stack builds a read-only outline, this one builds a tree that _owns_ content). When a new `heading_open` creates a `Section`, its `headingPath` is computed once, immediately, as `[...currentStackTop.headingPath, { level, text: headingText, anchor }]` (or `[{ level, text: headingText, anchor }]` if the stack is empty, i.e. the new section is top-level) — see §2.1's correction note for why this is computed here rather than reconstructed later.
2. Every non-heading top-level token between one `heading_open` and the next is converted into a `ContentBlock` and appended to the **current stack top's** `blocks` array (the innermost open section owns the content, matching normal Markdown nesting semantics — content right after `### Grandchild` belongs to _Grandchild_, not to `## Child` or `# Top`).
3. Content appearing _before_ the first heading in the document becomes the implicit root `Section`'s own `blocks` (`headingLevel: 0`, `headingText: ''`, `headingPath: []`) — this covers a short intro paragraph before a doc's first `#`.
4. **Content-block classification** (a pure function, `classifyToken(token, tokens, index): ContentBlockType`):
   - `fence` / `code_block` tokens → `'code'` (language from `token.info`, exactly as `MarkdownParserService` already does).
   - `table_open` … `table_close` token ranges → one `'table'` block per table, `text` reconstructed from the full token range's source span (markdown-it tokens carry `.map: [startLine, endLine]`; slice `bodyText`'s lines directly rather than re-rendering, to preserve the table's exact original Markdown — critical so it round-trips byte-for-byte, satisfying determinism).
   - `bullet_list_open`/`ordered_list_open` … `*_list_close` ranges → one `'list'` block per **top-level** list only. The classifier must track a list-nesting depth counter as it walks: increment on every `bullet_list_open`/`ordered_list_open`, decrement on the matching close, and only start a _new_ `ContentBlock` when such a token is seen **at depth 0** (i.e., not already inside an open list). A nested sub-list's open/close tokens, seen at depth ≥ 1, are not separately classified — they stay inside the enclosing top-level list block's line range, which already spans them (`.map` on the outer `list_open` token already covers the full nested structure). Skipping this depth check would double-classify every nested sub-list as its own extra `ContentBlock`, producing overlapping/duplicated line ranges. A list is never split across blocks, only across chunks if oversized, per §5.1/§5.2.
   - `blockquote_open` ranges whose first inline text matches `/^\s*\*{0,2}(note|warning|important|caution|tip)\b/i` → `'note'` (Docker docs' `> **Note**: ...` / `> **Warning**: ...` convention); all other blockquotes fall through to `'paragraph'` rather than guessing.
   - Everything else (`paragraph_open` ranges, standalone `heading_open` text is NOT a block — it's the `Section.headingText` itself) → `'paragraph'`.
5. Each `ContentBlock.length` is computed immediately via the injected `LengthMeasurerPort`, memoized on the block — never recomputed in later phases.

**Why line-range slicing instead of `markdown-it`'s renderer:** `md.renderer.render(tokens)` re-serializes Markdown from the AST, which can normalize whitespace, list-marker style (`-` vs `*`), or table alignment syntax differently than the source. Slicing `bodyText.split('\n').slice(startLine, endLine).join('\n')` guarantees the chunk's `text` is a byte-identical substring of the original document — essential for requirement 4 ("never arbitrarily split a command") and for the determinism requirement (7): the same source always yields byte-identical block text, never a re-rendered approximation of it.

### 4.2 Phase 2 — Size bounding (the E-specific step)

Operates on the `Section` tree bottom-up (post-order: children resolved before their parent's siblings are considered for merging).

```
function boundSection(section, config, measurer):
    descendantChunks = []
    for child in section.children:
        descendantChunks += boundSection(child, config, measurer)

    ownLength = sum(block.length for block in section.blocks) + measurer.measure(headingLine(section))

    if ownLength > config.maxChunkSize:
        ownPieces = splitAtBlockBoundaries(section, config, measurer)   // §5.1, each tagged wasSplit: true
    else:
        ownPieces = [oneChunkFor(section)]   // exactly one piece; may still be < minChunkSize, resolved by the caller below

    return { ownPieces, descendantChunks }
```

`boundSection` never merges anything itself — merging requires visibility into _adjacent siblings_, which a single section's own recursive call cannot see. Instead, `boundSection` returns each section's own (possibly split, but never merged) pieces separately from its descendants' chunks, and the merge pass runs **once per sibling group**, immediately after that group's parent has called `boundSection` on every one of its children in document order:

```
function resolveSiblingGroup(children, config):
    results = [boundSection(child, config, measurer) for child in children]
    mergedOwnPieces = mergeUndersizedSiblings(results.map(r => r.ownPieces), config)   // §5.2
    return mergedOwnPieces + results.flatMap(r => r.descendantChunks)
```

`resolveSiblingGroup` is called once for the document's top-level sections (the implicit root's `children`) and once again, independently, for every section's own `children` — so merging is always scoped to one sibling group at a time and never crosses a level boundary. A section that was split (`ownPieces.length > 1`, i.e. oversized) is **never** merge-eligible: `mergeUndersizedSiblings` (§5.2) only ever considers a section whose `ownPieces` is the single, unsplit result from the `else` branch above, and even then only when that single piece's length is below `config.minChunkSize`.

### 4.3 Phase 3 — Chunk assembly

For every resolved section-or-split-piece from Phase 2, in document order:

1. Compute `chunkId` (§9).
2. Populate `ChunkMetadata` from the `Section`'s `headingPath`, the originating `StructuredDocument`'s `documentId`/`metadata`, and the split/merge flags carried through from Phase 2.
3. If `config.includeParentChunks`, also emit one `'parent'`-type `Chunk` per `Section` (from the original, unmodified `Section` tree — independent of whatever Phase 2 decided to split or merge at the `'child'`-chunk level) containing that section's full text (own blocks + all descendant sections' text, concatenated in document order). Its `relationships.childChunkIds` contains only the `'child'`-type chunk ID(s) produced from that section's own `ownPieces` (§4.2) — `[]` if that section's own content was folded into a sibling's merged chunk (§5.2) rather than surviving as its own distinct `'child'`-type chunk. Its own `relationships.parentChunkId`/`previousChunkId`/`nextChunkId` are always `null` (§2.2).
4. Apply the configured overlap strategy (§8) to `'child'`-type chunks only — parent chunks never carry synthetic overlap, since they already contain full context by construction.
5. Assign `previousChunkId`/`nextChunkId` by a single linear pass over the final `'child'`-type chunk sequence.

---

## 5. Code-Block, Table, and List Handling

### 5.1 Oversized-section splitting (never inside an atomic block)

`splitAtBlockBoundaries(section, config, measurer)` greedily packs the section's own `blocks` (in order) into successive pieces, each kept under `config.maxChunkSize`:

- Start a new piece whenever adding the next block would exceed `maxChunkSize`, **except** the very first block of a piece is always accepted regardless of its own size (a piece must never be empty).
- **A `'code'` block is never split internally**, full stop — even if a single code fence alone exceeds `maxChunkSize`. In that case it becomes its own one-block piece and `ChunkMetadata.exceedsMaxSize` is set `true` on that piece's chunk. This is the direct, literal satisfaction of requirement 4 ("never arbitrarily split a command or code block") — the design explicitly accepts an oversized chunk over a corrupted one. An oversized-but-intact code block is still useful to an LLM reading it at generation time; a truncated `docker run` command with a cut-off flag is actively harmful. (`'note'` blocks get the same never-split, `exceedsMaxSize`-if-oversized treatment — §5.3. `'table'` blocks are the one deliberate exception, handled next.)
- **A `'list'` block _may_ be split, but only at item boundaries, never mid-item.** A list's `text` is stored with per-item line ranges retained internally during Phase 1 (not exposed in the public `ContentBlock` shape, but tracked by `MarkdownSectionParserService` for exactly this purpose); if a list alone exceeds `maxChunkSize`, it is re-split into multiple `'list'`-type pieces along item boundaries, each a valid, self-contained list fragment. **If a single item within the list is itself, alone, larger than `maxChunkSize`** (e.g. one list item contains a long embedded code block or paragraph), that item is never split internally — it becomes its own one-item piece and `ChunkMetadata.exceedsMaxSize` is set `true` on it, the same "accept oversized over corrupted" principle applied one level down from whole-list splitting.
- **A `'table'` block, if it alone exceeds `maxChunkSize`,** is the one exception to "never split": it is split along row boundaries (never mid-row), and the header row (first row + the `---|---` separator row) is repeated verbatim at the top of every piece after the first, so each piece remains a syntactically valid, independently-readable Markdown table. This is called out explicitly because it is the one deliberate exception to "atomic blocks are never split" — justified because an unbounded table (e.g., a full CLI flag-reference table) is common in technical docs and a single 10,000-token table chunk would be actively worse for retrieval than several coherent, correctly-headed row groups.
- Split pieces of the same section share `headingPath` and get `wasSplit: true`; the section's heading line itself is repeated at the top of every piece after the first, exactly like the table-header repetition above, so each split piece remains independently comprehensible (this is the design's overlap-equivalent for splits — see §8's distinction between split-context and true configurable overlap).

### 5.2 Small-section merging strategy

**Corrected from an earlier draft, which described two different, contradictory merge directions.** The rule, stated once and unambiguously: `mergeUndersizedSiblings(ownPiecesPerChild, config)` makes one left-to-right pass over a single sibling group's `ownPieces` (§4.2's `resolveSiblingGroup`) and groups together **consecutive runs of undersized siblings only** — it never touches, absorbs into, or is absorbed by a sibling that was not itself undersized. A normal, correctly-sized chunk is therefore never contaminated by an unrelated small neighbor.

1. **Eligibility.** A child's `ownPieces` is merge-eligible only when it is the single, unsplit result (`ownPieces.length === 1`, `wasSplit: false`) **and** that piece's `length < config.minChunkSize`. A section that was split for being oversized is never eligible (§4.2).
2. **Grouping.** Walk the sibling group's children left to right, maintaining a "pending run" of eligible children (initially empty):
   - If the current child is eligible: append it to the pending run, unless doing so would push the run's combined length over `config.maxChunkSize` — in that case, first flush the pending run (step 3) as-is, then start a new run containing just the current child. (Merging must never itself create a new oversized chunk; this is the only case where a run closes early, before hitting a non-eligible sibling.)
   - If the current child is not eligible (normal-sized, or was split): flush the pending run (step 3) if it is non-empty, then emit that child's own chunk(s) unchanged.
   - After the last child, flush any remaining pending run.
3. **Flushing a run:** a run of exactly one section is emitted as that section's own chunk, unmodified — accepted as slightly under `minChunkSize` (a soft floor, not a hard invariant, unlike `maxChunkSize`, which this pass never allows a merge to exceed). A run of two or more sections is folded into a single merged chunk: `metadata.headingPath` and the heading line at the top of `text` come from the **first** section in the run; `metadata.mergedHeadings` lists every other section's `headingText` in the run; `metadata.wasMerged` is set `true`. This keeps the merged chunk fully self-describing without inventing a synthetic heading that never existed in the source document.
4. **Scope.** This entire pass operates on exactly one sibling group at a time (§4.2's `resolveSiblingGroup` calls it once per parent, including once for the document's top-level sections) — it never reaches across a parent boundary, because merging two sections that don't share a parent would corrupt `headingPath` (whose ancestor chain would the merged chunk even use?) and violate requirement 5 (preserve parent/child relationships).

### 5.3 Notes/warnings

`'note'` blocks are never split (treated as atomic like `'code'` — an oversized note sets `ChunkMetadata.exceedsMaxSize: true` on its own one-block piece, exactly as an oversized code fence does) and never merged into a neighboring `'paragraph'` block during Phase 1 classification — they stay a distinct `ContentBlockType` through to `ChunkMetadata.contentTypes`, so a downstream consumer can choose to weight or surface warnings differently (e.g., "always show the safety note if the matched chunk has one nearby") without needing to re-parse chunk text.

---

## 6. Token/Length Measurement Strategy

`LengthMeasurerPort.measure(text: string): number` is selected by `ChunkingConfigService.lengthStrategy` (§8):

| Strategy                       | Implementation                                                                                                    | When to use                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `'char'`                       | `text.length`                                                                                                     | Simplest, fully deterministic, zero assumptions. Good default for testing.                              |
| `'word'`                       | `text.trim().split(/\s+/).filter(Boolean).length`                                                                 | Slightly more meaningful for prose-heavy docs; still crude for code.                                    |
| `'approx-token'` (**default**) | `Math.ceil(text.length / 4)` — the standard ~4-characters-per-token heuristic for BPE-tokenized English/code text | Closest free approximation to a real embedding-model tokenizer without taking a hard dependency on one. |

No tokenizer library (e.g. `js-tiktoken`) is added now — `approx-token` needs zero dependencies and is accurate enough (±20%, which is what `maxChunkSize`'s margin already assumes — see §14's risk table) for chunk-sizing decisions, which only need to be _roughly_ right, not exact. **Migration trigger:** once a specific embedding model is chosen (`EmbeddingProviderPort` adapter selected), add a model-specific `LengthMeasurerPort` implementation (e.g. `TiktokenLengthMeasurer` using `js-tiktoken`, matching the platform architecture's already-adopted `js-tiktoken` package) and switch `CHUNKING_LENGTH_STRATEGY` to it — no change to any other chunking code, which is the entire reason this is a real port and not a config-only switch.

---

## 7. Folder Structure

Flat `src/chunking/` feature folder, mirroring `src/ingestion/`'s established convention exactly (concrete services, co-located `.spec.ts`, one `*.module.ts`, one `*-config.service.ts`):

```
src/chunking/
  chunking.types.ts                 # Section, ContentBlock, Chunk, ChunkMetadata, ChunkRelationships, ChunkingResult
  chunking.errors.ts                # EmptyDocumentError, UnbalancedHeadingStructureError (see §11)
  chunking-config.service.ts        # wraps ConfigService, exposes typed getters (mirrors IngestionConfigService)
  length-measurer.ts                # LengthMeasurerPort + CharLengthMeasurer/WordLengthMeasurer/ApproxTokenLengthMeasurer + a factory keyed by config
  content-block-classifier.util.ts  # pure function: classifyToken(...) → ContentBlockType (§4.1 step 4)
  markdown-section-parser.service.ts # SectionParserPort impl — Phase 1 (§4.1)
  section-size-bounder.service.ts   # Phase 2 — split/merge (§4.2, §5)
  chunk-id.util.ts                  # pure function: deriveChunkId(...) (§9)
  chunk-assembler.service.ts        # Phase 3 — metadata + relationships + overlap (§4.3, §8)
  chunking-pipeline.service.ts      # orchestrator: StructuredDocument → ChunkingResult
  chunking.module.ts                # DI wiring, exports ChunkingPipelineService
  *.spec.ts                         # one per file above, co-located
test/
  chunking.e2e-spec.ts              # real StructuredDocument fixture → asserted Chunk[] shape
  fixtures/chunking/
    docker-install-guide.json       # a hand-authored StructuredDocument fixture with headings,
                                      # nested sub-sections, a long code block, a table, a list,
                                      # and a note — exercising every ContentBlockType at once
```

No new top-level directories; `IngestionModule` and `ChunkingModule` are siblings under `src/`, imported side-by-side into `AppModule` exactly as `IngestionModule` is today. `ChunkingModule` takes a type-only dependency on `StructuredDocument` from `src/ingestion/ingestion.types.ts` — no runtime dependency on any ingestion _service_ (chunking never calls `IngestionPipelineService`; a future orchestrator or CLI script reads ingestion's JSON output files and passes each parsed `StructuredDocument` into `ChunkingPipelineService.chunk(...)` directly, keeping the two bounded contexts decoupled at the service level even though one clearly runs after the other).

---

## 8. Configuration Design

Extends `src/config/env.validation.ts`'s single zod schema exactly as the ingestion module did, plus a dedicated `ChunkingConfigService` (never reading `process.env` directly, per this project's established config convention):

| Env var                          | Type / default                                                                   | Purpose                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CHUNKING_MAX_CHUNK_SIZE`        | `number`, default `500`                                                          | Upper size bound (in `lengthStrategy` units) before a section is split (§5.1). Lowered from an earlier draft's `800`: the whole justification for `'child'`-type chunks (§2.2) is small, precise retrieval units, and common RAG guidance favors ~200–500 tokens for leaf chunks — 800 sat closer to what this design already reserves `'parent'`-type chunks for. |
| `CHUNKING_MIN_CHUNK_SIZE`        | `number`, default `100`                                                          | Lower size bound before a section is merged with a sibling (§5.2 / §4.2).                                                                                                                                                                                                                                                                                          |
| `CHUNKING_LENGTH_STRATEGY`       | `'char' \| 'word' \| 'approx-token'`, default `'approx-token'`                   | Selects the `LengthMeasurerPort` implementation (§6).                                                                                                                                                                                                                                                                                                              |
| `CHUNKING_OVERLAP_STRATEGY`      | `'none' \| 'heading-context' \| 'sentence-overlap'`, default `'heading-context'` | See below.                                                                                                                                                                                                                                                                                                                                                         |
| `CHUNKING_OVERLAP_SENTENCES`     | `number`, default `1`                                                            | Only consulted when `CHUNKING_OVERLAP_STRATEGY === 'sentence-overlap'`.                                                                                                                                                                                                                                                                                            |
| `CHUNKING_INCLUDE_PARENT_CHUNKS` | `boolean`, default `true`                                                        | Whether Phase 3 also emits `'parent'`-type chunks (§2.2, §4.3 step 3).                                                                                                                                                                                                                                                                                             |
| `CHUNKING_OUTPUT_DIR`            | `string`, default `'./data/chunks-output'`                                       | Where `ChunkingPipelineService` writes one `{documentId}.chunks.json` file per document — mirrors `INGESTION_OUTPUT_DIR`'s exact role and convention.                                                                                                                                                                                                              |

**Overlap strategy, explained:** because chunks are already structure-bounded (split only at content-block boundaries, never arbitrary windows), classic sliding-window byte overlap is less necessary than in fixed-size chunking and actively harmful if overdone (near-duplicate text across adjacent chunks dilutes retrieval precision — two chunks that are 80% identical compete for the same query relevance rather than covering distinct ground). Two lighter-weight strategies are offered instead of raw duplication:

- **`'heading-context'` (default):** every split piece after the first is prefixed with a one-line breadcrumb (`_(continued from "Install Docker Engine › On Ubuntu")_`) instead of duplicated content. Zero content duplication, full context preserved.
- **`'sentence-overlap'`:** duplicates the last `CHUNKING_OVERLAP_SENTENCES` sentences of `'paragraph'` content from the end of one split piece at the start of the next — but **only across `'paragraph'`-to-`'paragraph'` boundaries**; a split boundary adjacent to a `'code'`, `'table'`, or `'list'` block never gets sentence overlap (there is nothing sentence-shaped to overlap, and duplicating half a command would reintroduce the exact problem requirement 4 forbids).
- **`'none'`:** no synthetic context added; pieces stand alone with only their own repeated heading line (§5.1) and `ChunkMetadata.headingPath`.

`ChunkingConfigService` is structured identically to `IngestionConfigService`: constructor-injects `ConfigService<EnvConfig, true>`, exposes one typed getter per key, no mutable state (safe for the same dual-registration pattern used by `AppConfigService` if ever needed).

---

## 9. Chunk IDs, Source Document IDs, Heading Paths

- **`ChunkMetadata.documentId`** is copied verbatim from the input `StructuredDocument.documentId` — never re-derived, so a chunk always traces back to exactly the ingestion record it came from.
- **`chunkId` derivation:** `sha256(documentId + '::' + headingPath.map(h => h.anchor).join('/') + '::' + localSequenceIndex)`, where `localSequenceIndex` is the 0-based index of this chunk among all chunks sharing the exact same `headingPath` (almost always `0`; only `>0` when a single section was split into multiple pieces, or merged pieces are being disambiguated). `chunkedAt` (a wall-clock timestamp) is **deliberately excluded** from this hash — including it would make `chunkId` different on every re-run of an unchanged document, defeating requirement 7 (determinism) and breaking downstream idempotent upserts the same way ingestion's `documentId` is deliberately based on `sourcePath`, not a timestamp.
- **`headingPath`** is the literal ancestor chain from `Section.headingPath` (§2.1), carried through Phase 3 unchanged — `[]` only for content that belonged to the implicit root section before any heading.
- **Known limitation, stated plainly:** `chunkId` stability is _structural_, not content-based. If an upstream edit changes a section's word count enough to cross the `maxChunkSize`/`minChunkSize` boundary (causing a different split/merge decision next run), the `localSequenceIndex`s — and therefore the `chunkId`s — for that section's pieces can shift, even though `documentId` and `headingPath` alone didn't change. This is a known, accepted MVP limitation (documented here rather than silently present): a fully change-stable chunk-identity scheme (e.g., content-hash-of-block-set-based IDs that survive resizing) is a real design problem or its own, deferred until re-ingestion/re-chunking frequency in production shows this instability actually causes churn worth solving. `ChunkMetadata.contentHash` (per-chunk content hash) is provided specifically so a downstream consumer can detect _when_ this has happened (same `chunkId` but different `contentHash` is impossible by construction; a _different_ `chunkId` for what "should" be the same logical chunk is the failure mode being flagged) and treat it as a delete-and-reinsert rather than an update.

---

## 10. Deterministic Chunk Generation

Three concrete guarantees, each independently testable:

1. **No wall-clock or random state feeds into chunk content, ordering, or `chunkId`.** `chunkedAt` is the only timestamp anywhere in the output, and it is explicitly excluded from `chunkId` (§9) and from any equality/dedup logic. No `Math.random()`, no `Date.now()`-seeded anything, anywhere in the chunking module.
2. **Chunk ordering is strictly the document's own reading order** — a pre-order walk of the `Section` tree (a section's own chunks before its children's, children in document order) — never a data-structure-dependent order like object-key iteration or a `Map`'s insertion-order quirks across Node versions.
3. **Byte-identical input ⇒ byte-identical output**, verified directly by a dedicated test (§12): run `ChunkingPipelineService.chunk(sameStructuredDocument)` twice and deep-equal the two `Chunk[]` arrays **after stripping `metadata.chunkedAt` from both** — that field is the one deliberate exception (a wall-clock timestamp, guaranteed to differ or match only by timing luck between two calls) and is never compared. Every other field, including every `chunkId`, must match exactly between the two runs; the test should assert this explicitly (e.g., `chunks.map(c => ({...c, metadata: {...c.metadata, chunkedAt: undefined}}))` on both sides before the deep-equal) so a future change can't silently weaken it by comparing objects that merely happen to look similar.

---

## 11. Error Handling

Mirrors ingestion's established philosophy (per-document isolation, no crashing a batch run over one bad document) rather than inventing a new one:

| Error                                                                                             | Raised when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Handling                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EmptyDocumentError`                                                                              | `StructuredDocument.bodyText` is empty or whitespace-only after trim.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | **Not thrown as fatal** — `ChunkingPipelineService.chunk(...)` catches it internally, logs at `warn`, and returns a `ChunkingResult` with `chunks: []`. A future batch orchestrator (mirroring `IngestionPipelineService`'s per-file try/catch) treats this the same way ingestion treats a per-file failure: recorded, not fatal. |
| `UnbalancedHeadingStructureError`                                                                 | Genuinely malformed input where `markdown-it`'s token stream cannot be walked into a coherent stack (in practice: never, for input already normalized by `DocumentCleaningService`+`MarkdownParserService` — Markdown headings are always well-formed ATX/Setext by the time `markdown-it` tokenizes them). Retained in the taxonomy for defensive completeness and because `MarkdownSectionParserService` is a real seam (§1.4) that a future `SectionParserPort` implementation for a _different_ input format might legitimately throw. | Thrown, not swallowed — this signals a genuine parser-contract violation, not an expected-at-scale content issue like `EmptyDocumentError`.                                                                                                                                                                                        |
| A single oversized, unsplittable unit (a code fence, a note/warning block, or a single list item) | Not an error at all — see §5.1/§5.3. Surfaced as `ChunkMetadata.exceedsMaxSize: true` on that chunk, never a thrown exception. A table is never in this category — it is always split by row instead (§5.1), the one exception to atomicity. Explicitly _not_ in this table as an error because treating expected, handled oversized content as an exception would be exactly the kind of "throw for scenarios that can happen and are handled" this project's engineering standards reject.                                               |

No `GlobalExceptionFilter`-equivalent is needed here, same reasoning as the ingestion design: this is an offline batch/library operation, not an HTTP request path.

---

## 12. Testing Strategy

Every stage is a pure function or a narrowly-scoped injectable class taking plain strings/objects — no LLM, no embedding call, no vector store, no network, matching requirement 12 directly:

- **`content-block-classifier.util.spec.ts`** — table-driven: feed hand-written Markdown snippets of each `ContentBlockType` (a fenced code block, a GFM table, a bullet list, an ordered list, a `> **Note:**` blockquote, a plain paragraph, a plain blockquote that is _not_ a note) and assert the exact classification.
- **`markdown-section-parser.service.spec.ts`** — asserts the `Section` tree shape for: a flat single-level document; a 3-level nested document (`#`/`##`/`###`); content before the first heading (root section); a heading with no content before the next heading (empty `blocks: []`); a code fence containing a line that looks like a heading (`# not a real heading`) — must not be misparsed as a `heading_open` token, proving reliance on `markdown-it`'s real tokenizer rather than a naive line-regex.
- **`section-size-bounder.service.spec.ts`** — the algorithmic core, tested with a stub `LengthMeasurerPort` that returns a controlled length so size thresholds are exercised precisely without real text-length coincidences: a section just over `maxChunkSize` splits into exactly the expected number of pieces; a code block alone exceeding `maxChunkSize` becomes its own piece with `exceedsMaxSize: true` and is never split; a table alone exceeding `maxChunkSize` splits at row boundaries with the header repeated in each piece; a single oversized list item is kept intact with `exceedsMaxSize: true`; two adjacent undersized siblings under the same parent merge into one chunk with `wasMerged: true` and `mergedHeadings` populated; two undersized sections under _different_ parents never merge; **an undersized section directly adjacent to a normal-sized (non-eligible) sibling is never folded into it** — the normal-sized sibling's chunk must come out byte-identical to how it would if the small section didn't exist at all (this is the specific regression guard for the merge-direction bug caught and fixed during design review — §5.2); a run of three-or-more consecutive undersized siblings whose combined length would exceed `maxChunkSize` splits into two merged groups rather than one oversized one.
- **`chunk-id.util.spec.ts`** — same `(documentId, headingPath, localSequenceIndex)` input always produces the same `chunkId`; changing any one of the three inputs changes the ID; `chunkedAt` is not part of the function's input signature at all (a signature-level guarantee, not just a behavioral one).
- **`chunk-assembler.service.spec.ts`** — each `CHUNKING_OVERLAP_STRATEGY` value produces the documented output shape; `'sentence-overlap'` never fires across a `'code'`/`'table'`/`'list'` boundary; `previousChunkId`/`nextChunkId` correctly link a real multi-chunk sequence; parent-chunk `childChunkIds` exactly matches the set of child chunks produced from that section.
- **`chunking-pipeline.service.spec.ts`** — end-to-end within the module (no real files), using an in-memory `StructuredDocument` fixture with every `ContentBlockType` represented; asserts the full `ChunkingResult` shape; asserts the **determinism** property directly (§10 guarantee 3: chunk twice, deep-equal after stripping `chunkedAt` from both results); asserts `EmptyDocumentError` is handled internally, not thrown.
- **`test/chunking.e2e-spec.ts`** — reads a real, hand-authored `StructuredDocument` JSON fixture (`test/fixtures/chunking/docker-install-guide.json`, built once by hand or by actually running the real ingestion pipeline over a small fixture Markdown file and saving its output) through the fully-wired `ChunkingModule`, and asserts on realistic properties: every chunk's `text` contains no truncated code fence (a regex/balance check: equal count of ` ``` ` markers within any single chunk that contains one at all); every `'child'` chunk's `documentId` matches the source; the concatenation of all `'child'` chunk texts (stripped of injected heading-context lines) still contains every original code block's content somewhere, verifying no code content was silently dropped anywhere in the split/merge/assembly pipeline.

**Coverage target:** the existing project-wide 80% branch/function/line/statement floor applies unchanged; the algorithmic density of `section-size-bounder.service.ts` (many branches: split vs. merge vs. pass-through, per `ContentBlockType`) will need the most test cases to hit that floor honestly rather than incidentally.

---

## 13. Performance Considerations

- **Single tokenization pass per document.** `markdown-it.parse()` runs exactly once per document in Phase 1; Phases 2 and 3 operate on the already-built `Section`/`ContentBlock` in-memory structures, never re-tokenizing.
- **Length measurement is memoized at block-creation time** (§4.1 step 5), not recomputed on every size check during Phase 2's split/merge decisions.
- **Algorithmic complexity:** Phase 1 is O(n) in token count. Phase 2 is O(n) for the split/merge walk (each block visited a constant number of times) plus O(k log k) in the worst case for a section with many small pieces needing merge-adjacency sorting, where k is the number of sibling sections at one level — negligible in practice since technical docs rarely have more than a few dozen subsections per level.
- **No streaming needed at current scale.** Docker's documentation corpus is a few thousand small Markdown files; `ChunkingPipelineService` processes one `StructuredDocument` fully in memory per call, matching `IngestionPipelineService`'s existing per-file synchronous-processing model (§1 of the ingestion design already made this call for the same corpus scale; chunking inherits the same reasoning). **Migration trigger:** if a future documentation source includes individual documents large enough that a single `bodyText` string becomes a memory concern (multi-megabyte single files), revisit with a streaming tokenizer — not justified today.
- **Batch orchestration is explicitly out of scope for this design** (see Definition of Done, §16) — this document specifies the single-document `ChunkingPipelineService.chunk(structuredDocument): ChunkingResult` contract only. A future `ChunkingBatchService` (mirroring `IngestionPipelineService`'s loop-with-failure-isolation shape) that reads every `*.json` file out of `INGESTION_OUTPUT_DIR` and calls this per document is a separate, small follow-up task, not part of this bounded context's core algorithm.

---

## 14. Risks and Edge Cases

| Risk / edge case                                                                                                                     | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A code fence with an unterminated/malformed closing ` ``` ` (rare but possible in hand-edited docs)                                  | `markdown-it` itself resolves this at tokenization time (it either finds a closing fence or treats the rest of the document as code) — the chunker inherits whatever `markdown-it` decided; not a new failure mode introduced by chunking.                                                                                                                                                                                                        |
| Heading levels that skip (e.g. `#` directly followed by `###`, no `##`)                                                              | The heading-stack algorithm (§4.1, same technique as `MarkdownParserService`) already handles this correctly — the `###` simply nests as a child of `#` with no intermediate node, matching how a human reader would interpret it. Not a distinct risk from what ingestion already tolerates today.                                                                                                                                               |
| A document with zero headings at all (pure prose, no structure)                                                                      | Falls out of the model naturally: everything lives in the implicit root `Section`, `headingPath: []` for every resulting chunk, and Phase 2's size-bounding still applies — the document is treated as "one large section" and split purely by content-block size. Not a special case in the algorithm, just the root-section path.                                                                                                               |
| Very deep nesting (`#` through `######`, six levels)                                                                                 | `headingPath` simply grows to six entries; no algorithmic limit exists. Retrieval-side consumers may want to cap how much of a long `headingPath` they display, but that is a presentation concern, not a chunking one.                                                                                                                                                                                                                           |
| `CHUNKING_MIN_CHUNK_SIZE >= CHUNKING_MAX_CHUNK_SIZE` misconfiguration                                                                | Caught at config-validation time by a zod `.refine()` on the schema (mirroring how `env.validation.ts` already throws a descriptive error for invalid config combinations) — the app fails fast at boot rather than producing degenerate chunking behavior silently.                                                                                                                                                                              |
| A section that is both "oversized" and has a "child section immediately following with no content of its own"                        | Handled correctly by definition: Phase 2 processes children bottom-up before evaluating the parent, and an empty-`blocks` section with real children simply contributes `ownLength` from its heading line alone (near-zero) plus whatever its children resolved to — it is never spuriously merged with unrelated siblings because merging is scoped to "adjacent siblings under the same parent," and a section's children are not its siblings. |
| `approx-token` heuristic (§6) is only approximately accurate                                                                         | Explicitly accepted (§6) — `maxChunkSize`'s default (500) still carries comfortable margin against real embedding-model tokenizers' typical limits (e.g. most models comfortably handle 1500-2000+ tokens per input); a ±20% estimation error does not risk exceeding a real model's hard context limit at this default. Revisit if a much smaller-context embedding model is ever chosen.                                                        |
| Two different documents happening to produce the same `headingPath` (e.g. two unrelated docs both have a "## Prerequisites" section) | Not a collision risk: `chunkId` is namespaced by `documentId` first (§9) — identical `headingPath`s across different documents produce entirely different `chunkId`s.                                                                                                                                                                                                                                                                             |
| `chunkId` instability under upstream content edits that shift split/merge decisions                                                  | Already documented as a known, accepted limitation in §9 — not silently hidden.                                                                                                                                                                                                                                                                                                                                                                   |

---

## 15. Implementation Plan (roadmap, not yet executed)

This is a task-sequencing roadmap for a future `writing-plans`/`executing-plans` pass, not itself a bite-sized TDD plan — per this turn's explicit "do not implement anything yet." Suggested task order, each independently testable and committable, mirroring the granularity the ingestion plan used:

1. **Domain types + errors** — `chunking.types.ts`, `chunking.errors.ts` (mirrors ingestion Task 1).
2. **`LengthMeasurerPort` + implementations + factory** — `length-measurer.ts`, fully unit-testable in isolation with no other chunking code (mirrors ingestion's pure-utility-first ordering, Task 2).
3. **`ChunkingConfigService` + env schema extension** — mirrors ingestion Task 3, including the same `.env.example`/README update requirement and the same zod-schema-drift-guard-test consideration.
4. **`content-block-classifier.util.ts`** — pure function, unit-tested standalone with hand-written Markdown snippets per `ContentBlockType`, before it's wired into the parser that depends on it.
5. **`MarkdownSectionParserService`** (Phase 1) — depends on Task 4; the largest single unit of new tokenization logic, deserves its own task and its own thorough `Section`-tree-shape test suite.
6. **`SectionSizeBounderService`** (Phase 2) — the algorithmic core (§4.2, §5); depends on Tasks 2 and 5; the highest-risk task, budget the most test cases here.
7. **`chunk-id.util.ts`** — pure function, trivially unit-testable in isolation, no dependencies on any other new file.
8. **`ChunkAssemblerService`** (Phase 3) — depends on Tasks 6 and 7; implements overlap strategies (§8) and relationship-linking (§2.2).
9. **`ChunkingPipelineService` + `ChunkingModule`** — orchestrates Tasks 5, 6, 8; wires into `AppModule` alongside `IngestionModule`, exactly as ingestion's own final wiring task did.
10. **Integration test with a real fixture** — build (or generate via a one-off real ingestion run over a small fixture ZIP) a realistic `StructuredDocument` JSON fixture exercising every `ContentBlockType`, and verify the full pipeline end-to-end, plus final `pnpm lint && pnpm test && pnpm test:e2e && pnpm build` verification and an implementation report — mirroring ingestion's final task exactly.

---

## 16. Definition of Done

This bounded context is complete when, without introducing embeddings, an LLM, a vector database, or LangChain:

1. `ChunkingPipelineService.chunk(document: StructuredDocument): ChunkingResult` exists, is unit- and integration-tested, and is wired into `AppModule` via `ChunkingModule`.
2. Given any `StructuredDocument` whose `bodyText` contains headings, prose, at least one code fence, at least one table, at least one list, and at least one note/warning callout, the resulting `Chunk[]`:
   - Never contains a truncated code fence or a truncated table row (§5.1, verified by the e2e test's balance check).
   - Carries a correct, non-empty `headingPath` on every chunk except those from the implicit root section.
   - Carries correct `parentChunkId`/`childChunkIds` links when `CHUNKING_INCLUDE_PARENT_CHUNKS` is enabled (default).
   - Is byte-identical across two consecutive runs on the same input, excluding each run's `metadata.chunkedAt` (§10, §12's determinism test).
3. All seven new `CHUNKING_*` env vars (§8: `MAX_CHUNK_SIZE`, `MIN_CHUNK_SIZE`, `LENGTH_STRATEGY`, `OVERLAP_STRATEGY`, `OVERLAP_SENTENCES`, `INCLUDE_PARENT_CHUNKS`, `OUTPUT_DIR`) are zod-validated, documented in `.env.example` and the README table, and covered by `ChunkingConfigService`.
4. `pnpm lint`, `pnpm test` (≥80% coverage floor maintained), `pnpm test:e2e`, and `pnpm build` all pass.
5. No chunking code imports or references anything from `@nestjs/bullmq`, any embedding SDK, any vector-store client, or LangChain's chain/agent APIs — only `@langchain/textsplitters`-style narrow utilities would even be permissible per the platform's own package philosophy, and this design uses none of them at all (§1.2).

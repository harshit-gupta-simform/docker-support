# Semantic Document Chunking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a dedicated `ChunkingModule` implementing the finalized, review-corrected design in `docs/architecture/semantic-chunking-design.md` — transforming a `StructuredDocument` into an ordered, retrieval-optimized `Chunk[]` via hybrid structure-aware + size-bounded chunking, with no embeddings, LLM, vector database, or LangChain.

**Architecture:** Flat `src/chunking/` feature folder mirroring `src/ingestion/`'s established conventions exactly. Three-phase pipeline: Phase 1 (`MarkdownSectionParserService`) re-tokenizes `bodyText` into a `Section` tree; Phase 2 (`SectionSizeBounderService`) splits oversized sections at content-block boundaries and merges runs of undersized sibling sections; Phase 3 (`ChunkAssemblerService`) computes deterministic IDs, parent/child/sequence relationships, and applies the configured overlap strategy. `ChunkingPipelineService` orchestrates all three and is exported from `ChunkingModule`, wired into `AppModule` alongside `IngestionModule`.

**Tech Stack:** `markdown-it` (already a dependency — no new packages needed), Node's built-in `crypto` (SHA-256 chunk IDs/content hashes) and `fs/promises` (writing output JSON).

## Global Constraints

- TypeScript strict mode is enabled project-wide (`strict`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`) — all new code must compile under it.
- ESLint config (`eslint.config.mjs`) sets `@typescript-eslint/no-explicit-any: error`, `@typescript-eslint/no-floating-promises: error`, `@typescript-eslint/no-unsafe-argument: error`, plus `tseslint.configs.recommendedTypeChecked`.
- Jest coverage threshold is 80% branches/functions/lines/statements globally — `section-size-bounder.service.ts` is the densest file (many branches) and needs the most test cases.
- Structured logging convention: inject `PinoLogger` from `nestjs-pino`, call `this.logger.setContext(ClassName.name)` in the constructor, then `this.logger.info(obj, msg)` / `.warn(obj, msg)`.
- Config convention: all environment variables are validated by the single zod schema in `src/config/env.validation.ts`, wrapped by a dedicated `*ConfigService` exposing typed getters — never read `process.env` directly.
- `.env.example` **cannot be edited by the assistant in this session** — the user's global `~/.claude/settings.json` denies `Read`/`Write`/`Edit` on any `.env*` path. Task 3 documents the exact lines the user must add by hand; until that happens, `src/config/env-example.spec.ts`'s drift-guard test will fail. This is not a code defect.
- No embeddings, no LLM calls, no vector-database client, no LangChain import anywhere in `src/chunking/` (Definition of Done item 5, design doc §16).
- `markdown-it`'s exact token shape for table rows (`tr_open`'s `.map`) should be confirmed empirically during Task 5's TDD cycle (write the test, run it, inspect actual tokens if the assertion fails) — this plan's code is based on markdown-it's documented/typical block-token behavior (every block-level token, including `tr_open` inside a table, carries `.map: [startLine, endLine]`), matching the precedent already set in this project's ingestion plan (where the exact `yauzl` promise-API shape was likewise confirmed empirically during implementation, not just assumed from a design doc).
- Commit after each task, following this repo's Conventional Commits history (`feat:`, `test:`, `docs:`, etc.).

---

### Task 1: Chunking domain types and error taxonomy

**Files:**

- Create: `src/chunking/chunking.types.ts`
- Create: `src/chunking/chunking.errors.ts`
- Test: `src/chunking/chunking.errors.spec.ts`

**Interfaces:**

- Produces: `ContentBlockType`, `ContentBlock`, `HeadingPathSegment`, `Section` (internal model, design §2.1); `ChunkType`, `ChunkRelationships`, `ChunkMetadata`, `Chunk`, `ChunkingResult` (public model, design §2.2); `ResolvedPiece` (internal Phase-2→Phase-3 handoff type, not in the design doc's public model but needed as the concrete contract between `SectionSizeBounderService` and `ChunkAssemblerService`); `EmptyDocumentError`, `UnbalancedHeadingStructureError` (design §11).

- [ ] **Step 1: Create the domain types file**

```typescript
// src/chunking/chunking.types.ts

export type ContentBlockType = 'paragraph' | 'code' | 'list' | 'table' | 'note';

export interface ContentBlock {
  type: ContentBlockType;
  text: string;
  language: string | null;
  length: number;
  // Populated only for 'list' blocks — one entry per top-level list item, in
  // document order, used by SectionSizeBounderService to split a list that
  // alone exceeds maxChunkSize without ever splitting mid-item (design §5.1).
  itemTexts?: string[];
  // Populated only for 'table' blocks — the header row + separator row,
  // verbatim, repeated at the top of every split piece after the first when
  // a table alone exceeds maxChunkSize (design §5.1).
  headerText?: string;
  // Populated only for 'table' blocks — one entry per data row (excludes the
  // header and separator rows).
  rowTexts?: string[];
}

export interface HeadingPathSegment {
  level: number;
  text: string;
  anchor: string;
}

export interface Section {
  headingText: string;
  headingLevel: number;
  anchor: string;
  headingPath: HeadingPathSegment[];
  blocks: ContentBlock[];
  children: Section[];
}

export type ChunkType = 'parent' | 'child';

export interface ChunkRelationships {
  parentChunkId: string | null;
  childChunkIds: string[];
  previousChunkId: string | null;
  nextChunkId: string | null;
}

export interface ChunkMetadata {
  documentId: string;
  sourcePath: string;
  documentTitle: string;
  headingPath: HeadingPathSegment[];
  chunkType: ChunkType;
  contentTypes: ContentBlockType[];
  length: number;
  sequenceIndex: number;
  wasSplit: boolean;
  wasMerged: boolean;
  mergedHeadings: string[];
  exceedsMaxSize: boolean;
  contentHash: string;
  chunkedAt: string;
}

export interface Chunk {
  chunkId: string;
  text: string;
  metadata: ChunkMetadata;
  relationships: ChunkRelationships;
}

export interface ChunkingResult {
  documentId: string;
  chunks: Chunk[];
  totalSections: number;
  splitSections: number;
  mergedSections: number;
  durationMs: number;
}

// Internal Phase-2 output / Phase-3 input — never exposed outside the module.
export interface ResolvedPiece {
  section: Section;
  headingPath: HeadingPathSegment[];
  localSequenceIndex: number;
  text: string;
  length: number;
  wasSplit: boolean;
  wasMerged: boolean;
  mergedHeadings: string[];
  exceedsMaxSize: boolean;
  contentTypes: ContentBlockType[];
}
```

- [ ] **Step 2: Create the error taxonomy**

```typescript
// src/chunking/chunking.errors.ts

export class EmptyDocumentError extends Error {
  constructor(documentId: string) {
    super(`Document ${documentId} has no content to chunk (empty bodyText)`);
    this.name = 'EmptyDocumentError';
  }
}

export class UnbalancedHeadingStructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnbalancedHeadingStructureError';
  }
}
```

- [ ] **Step 3: Write the failing test for the error taxonomy**

```typescript
// src/chunking/chunking.errors.spec.ts
import {
  EmptyDocumentError,
  UnbalancedHeadingStructureError,
} from './chunking.errors';

describe('chunking errors', () => {
  it('EmptyDocumentError carries the documentId in its message', () => {
    const err = new EmptyDocumentError('abc123');

    expect(err.name).toBe('EmptyDocumentError');
    expect(err.message).toContain('abc123');
    expect(err).toBeInstanceOf(Error);
  });

  it('UnbalancedHeadingStructureError carries name and message', () => {
    const err = new UnbalancedHeadingStructureError('bad token stream');

    expect(err.name).toBe('UnbalancedHeadingStructureError');
    expect(err.message).toBe('bad token stream');
  });
});
```

- [ ] **Step 4: Run the test**

Run: `pnpm test -- chunking.errors.spec.ts`
Expected: PASS (2/2)

- [ ] **Step 5: Commit**

```bash
git add src/chunking/chunking.types.ts src/chunking/chunking.errors.ts src/chunking/chunking.errors.spec.ts
git commit -m "feat(chunking): add chunking domain types and error taxonomy"
```

---

### Task 2: `LengthMeasurerPort` and its implementations

**Files:**

- Create: `src/chunking/length-measurer.ts`
- Test: `src/chunking/length-measurer.spec.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `LengthMeasurerPort` interface (`measure(text: string): number`), `LENGTH_MEASURER_PORT` DI token (a `Symbol`, since this port has multiple real, runtime-selected implementations — unlike ingestion's documentation-only ports), `CharLengthMeasurer`, `WordLengthMeasurer`, `ApproxTokenLengthMeasurer`, `createLengthMeasurer(strategy: 'char' | 'word' | 'approx-token'): LengthMeasurerPort` — consumed by Task 3's `ChunkingModule` wiring (added in Task 9) and Tasks 5/8.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/chunking/length-measurer.spec.ts
import {
  ApproxTokenLengthMeasurer,
  CharLengthMeasurer,
  createLengthMeasurer,
  WordLengthMeasurer,
} from './length-measurer';

describe('CharLengthMeasurer', () => {
  it('measures raw character length', () => {
    expect(new CharLengthMeasurer().measure('hello')).toBe(5);
  });
});

describe('WordLengthMeasurer', () => {
  it('counts whitespace-separated words', () => {
    expect(new WordLengthMeasurer().measure('one two  three')).toBe(3);
  });

  it('returns 0 for empty or whitespace-only text', () => {
    expect(new WordLengthMeasurer().measure('   ')).toBe(0);
  });
});

describe('ApproxTokenLengthMeasurer', () => {
  it('approximates ~4 characters per token, rounded up', () => {
    expect(new ApproxTokenLengthMeasurer().measure('12345678')).toBe(2);
    expect(new ApproxTokenLengthMeasurer().measure('123456789')).toBe(3);
  });

  it('returns 0 for empty text', () => {
    expect(new ApproxTokenLengthMeasurer().measure('')).toBe(0);
  });
});

describe('createLengthMeasurer', () => {
  it('creates a CharLengthMeasurer for "char"', () => {
    expect(createLengthMeasurer('char')).toBeInstanceOf(CharLengthMeasurer);
  });

  it('creates a WordLengthMeasurer for "word"', () => {
    expect(createLengthMeasurer('word')).toBeInstanceOf(WordLengthMeasurer);
  });

  it('creates an ApproxTokenLengthMeasurer for "approx-token"', () => {
    expect(createLengthMeasurer('approx-token')).toBeInstanceOf(
      ApproxTokenLengthMeasurer,
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- length-measurer.spec.ts`
Expected: FAIL with "Cannot find module './length-measurer'"

- [ ] **Step 3: Implement `length-measurer.ts`**

```typescript
// src/chunking/length-measurer.ts

export const LENGTH_MEASURER_PORT = Symbol('LENGTH_MEASURER_PORT');

export interface LengthMeasurerPort {
  measure(text: string): number;
}

export class CharLengthMeasurer implements LengthMeasurerPort {
  measure(text: string): number {
    return text.length;
  }
}

export class WordLengthMeasurer implements LengthMeasurerPort {
  measure(text: string): number {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return 0;
    }
    return trimmed.split(/\s+/).filter((word) => word.length > 0).length;
  }
}

const CHARS_PER_APPROX_TOKEN = 4;

export class ApproxTokenLengthMeasurer implements LengthMeasurerPort {
  measure(text: string): number {
    return Math.ceil(text.length / CHARS_PER_APPROX_TOKEN);
  }
}

export type LengthStrategy = 'char' | 'word' | 'approx-token';

export function createLengthMeasurer(
  strategy: LengthStrategy,
): LengthMeasurerPort {
  switch (strategy) {
    case 'char':
      return new CharLengthMeasurer();
    case 'word':
      return new WordLengthMeasurer();
    case 'approx-token':
      return new ApproxTokenLengthMeasurer();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- length-measurer.spec.ts`
Expected: PASS (9/9)

- [ ] **Step 5: Commit**

```bash
git add src/chunking/length-measurer.ts src/chunking/length-measurer.spec.ts
git commit -m "feat(chunking): add LengthMeasurerPort and its implementations"
```

---

### Task 3: `ChunkingConfigService` and env schema extension

**Files:**

- Modify: `src/config/env.validation.ts`
- Modify: `src/config/env.validation.spec.ts`
- Create: `src/chunking/chunking-config.service.ts`
- Test: `src/chunking/chunking-config.service.spec.ts`
- Modify: `README.md`

**Interfaces:**

- Consumes: `ConfigService<EnvConfig, true>`, `LengthStrategy` (Task 2).
- Produces: `ChunkingConfigService` with getters `maxChunkSize: number`, `minChunkSize: number`, `lengthStrategy: LengthStrategy`, `overlapStrategy: 'none' | 'heading-context' | 'sentence-overlap'`, `overlapSentences: number`, `includeParentChunks: boolean`, `outputDir: string` — consumed by Tasks 5, 6, 8, 9.

- [ ] **Step 1: Extend the env schema**

Modify `src/config/env.validation.ts` — add these seven keys inside `envSchema`'s `z.object({...})`, after the existing `INGESTION_DEFAULT_LANGUAGE` field, and add a cross-field `.refine()` after the object closes:

```typescript
  CHUNKING_MAX_CHUNK_SIZE: z.coerce.number().int().positive().default(500),
  CHUNKING_MIN_CHUNK_SIZE: z.coerce.number().int().positive().default(100),
  CHUNKING_LENGTH_STRATEGY: z
    .enum(['char', 'word', 'approx-token'])
    .default('approx-token'),
  CHUNKING_OVERLAP_STRATEGY: z
    .enum(['none', 'heading-context', 'sentence-overlap'])
    .default('heading-context'),
  CHUNKING_OVERLAP_SENTENCES: z.coerce.number().int().positive().default(1),
  CHUNKING_INCLUDE_PARENT_CHUNKS: z.coerce.boolean().default(true),
  CHUNKING_OUTPUT_DIR: z.string().min(1).default('./data/chunks-output'),
```

The full file after this edit:

```typescript
import { z } from 'zod';

export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'production', 'test'])
      .default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    INGESTION_OUTPUT_DIR: z.string().min(1).default('./data/ingestion-output'),
    INGESTION_MAX_ENTRY_COUNT: z.coerce
      .number()
      .int()
      .positive()
      .default(10000),
    INGESTION_MAX_UNCOMPRESSED_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(524288000),
    INGESTION_INCLUDE_GLOB: z.string().min(1).default('**/*.md'),
    INGESTION_DEFAULT_LANGUAGE: z.string().min(1).default('en'),
    CHUNKING_MAX_CHUNK_SIZE: z.coerce.number().int().positive().default(500),
    CHUNKING_MIN_CHUNK_SIZE: z.coerce.number().int().positive().default(100),
    CHUNKING_LENGTH_STRATEGY: z
      .enum(['char', 'word', 'approx-token'])
      .default('approx-token'),
    CHUNKING_OVERLAP_STRATEGY: z
      .enum(['none', 'heading-context', 'sentence-overlap'])
      .default('heading-context'),
    CHUNKING_OVERLAP_SENTENCES: z.coerce.number().int().positive().default(1),
    CHUNKING_INCLUDE_PARENT_CHUNKS: z.coerce.boolean().default(true),
    CHUNKING_OUTPUT_DIR: z.string().min(1).default('./data/chunks-output'),
  })
  .refine(
    (config) => config.CHUNKING_MIN_CHUNK_SIZE < config.CHUNKING_MAX_CHUNK_SIZE,
    {
      message:
        'CHUNKING_MIN_CHUNK_SIZE must be less than CHUNKING_MAX_CHUNK_SIZE',
      path: ['CHUNKING_MIN_CHUNK_SIZE'],
    },
  );

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const result = envSchema.safeParse(config);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `- ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return result.data;
}
```

Note: wrapping the object in `.refine()` changes `envSchema`'s runtime type from `ZodObject` to `ZodEffects` — `Object.keys(envSchema.shape)` (used by `src/config/env-example.spec.ts`'s drift-guard test) still works because `.refine()` preserves the inner `.shape` accessor on the returned schema in zod v4. Verify this with `pnpm test -- env-example.spec.ts` in Step 4 below; if `.shape` is not accessible on the refined schema, keep `envSchema` as the plain `z.object({...})` (no `.refine()`) and instead move the cross-field check into `validateEnv()` itself as an extra manual check after `safeParse` succeeds, throwing the same descriptive `Invalid environment configuration` error format.

**IMPORTANT — manual step required, cannot be automated in this session:** `.env.example` must gain matching lines, or `src/config/env-example.spec.ts`'s drift-guard test will fail (the assistant's tooling is denied `Read`/`Write`/`Edit` on any `.env*` path). Add these seven lines to `.env.example` by hand:

```
CHUNKING_MAX_CHUNK_SIZE=500
CHUNKING_MIN_CHUNK_SIZE=100
CHUNKING_LENGTH_STRATEGY=approx-token
CHUNKING_OVERLAP_STRATEGY=heading-context
CHUNKING_OVERLAP_SENTENCES=1
CHUNKING_INCLUDE_PARENT_CHUNKS=true
CHUNKING_OUTPUT_DIR=./data/chunks-output
```

- [ ] **Step 2: Update the existing env.validation.spec.ts fixtures**

`src/config/env.validation.spec.ts` currently asserts `validateEnv({})` and a "fully specified valid configuration" test against object literals that don't include the new keys — both will fail once the schema requires them to be present in the parsed _output_ (they have defaults, so they'll still parse, but the `toEqual` assertions need updating to include them). Modify both `toEqual` blocks in `src/config/env.validation.spec.ts` to add the ten ingestion+chunking keys already established by the pattern from the ingestion module's own fix to this file — specifically, add after the `INGESTION_DEFAULT_LANGUAGE` line in the "applies defaults" test:

```typescript
      CHUNKING_MAX_CHUNK_SIZE: 500,
      CHUNKING_MIN_CHUNK_SIZE: 100,
      CHUNKING_LENGTH_STRATEGY: 'approx-token',
      CHUNKING_OVERLAP_STRATEGY: 'heading-context',
      CHUNKING_OVERLAP_SENTENCES: 1,
      CHUNKING_INCLUDE_PARENT_CHUNKS: true,
      CHUNKING_OUTPUT_DIR: './data/chunks-output',
```

And add a new dedicated test for the cross-field refinement:

```typescript
it('throws when CHUNKING_MIN_CHUNK_SIZE is not less than CHUNKING_MAX_CHUNK_SIZE', () => {
  expect(() =>
    validateEnv({
      CHUNKING_MIN_CHUNK_SIZE: '500',
      CHUNKING_MAX_CHUNK_SIZE: '500',
    }),
  ).toThrow(/Invalid environment configuration/);
});
```

- [ ] **Step 3: Update the README environment variable table**

Add seven rows after the `INGESTION_DEFAULT_LANGUAGE` row in `README.md`'s environment variables table:

```markdown
| `CHUNKING_MAX_CHUNK_SIZE` | `500` | Upper size bound (in `CHUNKING_LENGTH_STRATEGY` units) before a section is split into multiple chunks. |
| `CHUNKING_MIN_CHUNK_SIZE` | `100` | Lower size bound before a section is merged with an adjacent, equally undersized sibling section. |
| `CHUNKING_LENGTH_STRATEGY` | `approx-token` | How chunk size is measured: `char`, `word`, or `approx-token` (~4 characters per token). |
| `CHUNKING_OVERLAP_STRATEGY` | `heading-context` | How split pieces of an oversized section stay contextualized: `none`, `heading-context` (a breadcrumb), or `sentence-overlap` (duplicate trailing sentences). |
| `CHUNKING_OVERLAP_SENTENCES` | `1` | Sentences duplicated between split pieces when `CHUNKING_OVERLAP_STRATEGY=sentence-overlap`. |
| `CHUNKING_INCLUDE_PARENT_CHUNKS` | `true` | Whether to also emit one full-section `'parent'`-type chunk per section, for parent-document retrieval. |
| `CHUNKING_OUTPUT_DIR` | `./data/chunks-output` | Directory where chunked `Chunk[]` JSON files are written. |
```

- [ ] **Step 4: Run the env-related tests**

Run: `pnpm test -- env.validation.spec.ts env-example.spec.ts`
Expected: `env.validation.spec.ts` PASSES; `env-example.spec.ts` FAILS until the user manually edits `.env.example` (documented above) — this is the same, already-accepted state of affairs left over from the ingestion module.

- [ ] **Step 5: Write the failing test for `ChunkingConfigService`**

```typescript
// src/chunking/chunking-config.service.spec.ts
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from '../config/env.validation';
import { ChunkingConfigService } from './chunking-config.service';

describe('ChunkingConfigService', () => {
  function build(overrides: Partial<EnvConfig> = {}): ChunkingConfigService {
    const values: EnvConfig = {
      NODE_ENV: 'test',
      PORT: 3000,
      LOG_LEVEL: 'info',
      INGESTION_OUTPUT_DIR: './data/ingestion-output',
      INGESTION_MAX_ENTRY_COUNT: 10000,
      INGESTION_MAX_UNCOMPRESSED_BYTES: 524288000,
      INGESTION_INCLUDE_GLOB: '**/*.md',
      INGESTION_DEFAULT_LANGUAGE: 'en',
      CHUNKING_MAX_CHUNK_SIZE: 500,
      CHUNKING_MIN_CHUNK_SIZE: 100,
      CHUNKING_LENGTH_STRATEGY: 'approx-token',
      CHUNKING_OVERLAP_STRATEGY: 'heading-context',
      CHUNKING_OVERLAP_SENTENCES: 1,
      CHUNKING_INCLUDE_PARENT_CHUNKS: true,
      CHUNKING_OUTPUT_DIR: './data/chunks-output',
      ...overrides,
    };
    const configService = {
      get: (key: keyof EnvConfig) => values[key],
    } as ConfigService<EnvConfig, true>;
    return new ChunkingConfigService(configService);
  }

  it('exposes maxChunkSize from config', () => {
    expect(build({ CHUNKING_MAX_CHUNK_SIZE: 800 }).maxChunkSize).toBe(800);
  });

  it('exposes minChunkSize from config', () => {
    expect(build({ CHUNKING_MIN_CHUNK_SIZE: 50 }).minChunkSize).toBe(50);
  });

  it('exposes lengthStrategy from config', () => {
    expect(build({ CHUNKING_LENGTH_STRATEGY: 'word' }).lengthStrategy).toBe(
      'word',
    );
  });

  it('exposes overlapStrategy from config', () => {
    expect(build({ CHUNKING_OVERLAP_STRATEGY: 'none' }).overlapStrategy).toBe(
      'none',
    );
  });

  it('exposes overlapSentences from config', () => {
    expect(build({ CHUNKING_OVERLAP_SENTENCES: 2 }).overlapSentences).toBe(2);
  });

  it('exposes includeParentChunks from config', () => {
    expect(
      build({ CHUNKING_INCLUDE_PARENT_CHUNKS: false }).includeParentChunks,
    ).toBe(false);
  });

  it('exposes outputDir from config', () => {
    expect(build({ CHUNKING_OUTPUT_DIR: '/tmp/out' }).outputDir).toBe(
      '/tmp/out',
    );
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm test -- chunking-config.service.spec.ts`
Expected: FAIL with "Cannot find module './chunking-config.service'"

- [ ] **Step 7: Implement `ChunkingConfigService`**

```typescript
// src/chunking/chunking-config.service.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from '../config/env.validation';
import { LengthStrategy } from './length-measurer';

@Injectable()
export class ChunkingConfigService {
  constructor(private readonly configService: ConfigService<EnvConfig, true>) {}

  get maxChunkSize(): number {
    return this.configService.get('CHUNKING_MAX_CHUNK_SIZE', { infer: true });
  }

  get minChunkSize(): number {
    return this.configService.get('CHUNKING_MIN_CHUNK_SIZE', { infer: true });
  }

  get lengthStrategy(): LengthStrategy {
    return this.configService.get('CHUNKING_LENGTH_STRATEGY', {
      infer: true,
    });
  }

  get overlapStrategy(): 'none' | 'heading-context' | 'sentence-overlap' {
    return this.configService.get('CHUNKING_OVERLAP_STRATEGY', {
      infer: true,
    });
  }

  get overlapSentences(): number {
    return this.configService.get('CHUNKING_OVERLAP_SENTENCES', {
      infer: true,
    });
  }

  get includeParentChunks(): boolean {
    return this.configService.get('CHUNKING_INCLUDE_PARENT_CHUNKS', {
      infer: true,
    });
  }

  get outputDir(): string {
    return this.configService.get('CHUNKING_OUTPUT_DIR', { infer: true });
  }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm test -- chunking-config.service.spec.ts`
Expected: PASS (7/7)

- [ ] **Step 9: Commit**

```bash
git add src/config/env.validation.ts src/config/env.validation.spec.ts src/chunking/chunking-config.service.ts src/chunking/chunking-config.service.spec.ts README.md
git commit -m "feat(chunking): add ChunkingConfigService and extend env schema"
```

---

### Task 4: Content-block classifier

**Files:**

- Create: `src/chunking/content-block-classifier.util.ts`
- Test: `src/chunking/content-block-classifier.util.spec.ts`

**Interfaces:**

- Consumes: `ContentBlockType` (Task 1), `markdown-it`'s `Token` type.
- Produces: `classifyRange(tokens: Token[], index: number): { type: ContentBlockType; endIndex: number } | null` — consumed by Task 5.

- [ ] **Step 1: Write the failing tests**

````typescript
// src/chunking/content-block-classifier.util.spec.ts
import MarkdownIt from 'markdown-it';
import { classifyRange } from './content-block-classifier.util';

const markdownIt = new MarkdownIt();

describe('classifyRange', () => {
  it('classifies a fenced code block as code', () => {
    const tokens = markdownIt.parse('```bash\necho hi\n```\n', {});
    const result = classifyRange(tokens, 0);

    expect(result).toEqual({ type: 'code', endIndex: 0 });
  });

  it('classifies a GFM table as table', () => {
    const tokens = markdownIt.parse(
      '| A | B |\n| --- | --- |\n| 1 | 2 |\n',
      {},
    );
    const tableOpenIndex = tokens.findIndex((t) => t.type === 'table_open');
    const tableCloseIndex = tokens.findIndex((t) => t.type === 'table_close');
    const result = classifyRange(tokens, tableOpenIndex);

    expect(result).toEqual({ type: 'table', endIndex: tableCloseIndex });
  });

  it('classifies a bullet list as list', () => {
    const tokens = markdownIt.parse('- one\n- two\n', {});
    const openIndex = tokens.findIndex((t) => t.type === 'bullet_list_open');
    const closeIndex = tokens.findIndex((t) => t.type === 'bullet_list_close');
    const result = classifyRange(tokens, openIndex);

    expect(result).toEqual({ type: 'list', endIndex: closeIndex });
  });

  it('classifies an ordered list as list', () => {
    const tokens = markdownIt.parse('1. one\n2. two\n', {});
    const openIndex = tokens.findIndex((t) => t.type === 'ordered_list_open');
    const result = classifyRange(tokens, openIndex);

    expect(result?.type).toBe('list');
  });

  it('classifies a bold "Note:" blockquote as note', () => {
    const tokens = markdownIt.parse('> **Note:** be careful\n', {});
    const openIndex = tokens.findIndex((t) => t.type === 'blockquote_open');
    const result = classifyRange(tokens, openIndex);

    expect(result?.type).toBe('note');
  });

  it('classifies a plain, non-admonition blockquote as paragraph', () => {
    const tokens = markdownIt.parse('> just a quote\n', {});
    const openIndex = tokens.findIndex((t) => t.type === 'blockquote_open');
    const result = classifyRange(tokens, openIndex);

    expect(result?.type).toBe('paragraph');
  });

  it('classifies a plain paragraph as paragraph', () => {
    const tokens = markdownIt.parse('Just some text.\n', {});
    const openIndex = tokens.findIndex((t) => t.type === 'paragraph_open');
    const result = classifyRange(tokens, openIndex);

    expect(result?.type).toBe('paragraph');
  });

  it('returns null for a heading_open token (not a content block)', () => {
    const tokens = markdownIt.parse('# Title\n', {});
    const result = classifyRange(tokens, 0);

    expect(result).toBeNull();
  });

  it('returns null for an inline token seen outside a recognized container', () => {
    const tokens = markdownIt.parse('# Title\n', {});
    const inlineIndex = tokens.findIndex((t) => t.type === 'inline');
    const result = classifyRange(tokens, inlineIndex);

    expect(result).toBeNull();
  });
});
````

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- content-block-classifier.util.spec.ts`
Expected: FAIL with "Cannot find module './content-block-classifier.util'"

- [ ] **Step 3: Implement the classifier**

```typescript
// src/chunking/content-block-classifier.util.ts
import type Token from 'markdown-it/lib/token.mjs';
import { ContentBlockType } from './chunking.types';

const NOTE_PATTERN = /^\s*\*{0,2}(note|warning|important|caution|tip)\b/i;

export interface ClassifiedRange {
  type: ContentBlockType;
  endIndex: number;
}

export function classifyRange(
  tokens: Token[],
  index: number,
): ClassifiedRange | null {
  const token = tokens[index];
  if (!token) {
    return null;
  }

  if (token.type === 'fence' || token.type === 'code_block') {
    return { type: 'code', endIndex: index };
  }

  if (token.type === 'table_open') {
    return { type: 'table', endIndex: findMatchingClose(tokens, index) };
  }

  if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') {
    return { type: 'list', endIndex: findMatchingClose(tokens, index) };
  }

  if (token.type === 'blockquote_open') {
    const endIndex = findMatchingClose(tokens, index);
    const firstInline = findFirstInline(tokens, index, endIndex);
    const type: ContentBlockType =
      firstInline && NOTE_PATTERN.test(firstInline.content)
        ? 'note'
        : 'paragraph';
    return { type, endIndex };
  }

  if (token.type === 'paragraph_open') {
    return { type: 'paragraph', endIndex: findMatchingClose(tokens, index) };
  }

  return null;
}

function findMatchingClose(tokens: Token[], startIndex: number): number {
  const openType = tokens[startIndex]?.type;
  const closeType = openType?.replace(/_open$/, '_close');
  let depth = 0;

  for (let i = startIndex; i < tokens.length; i += 1) {
    const current = tokens[i];
    if (!current) {
      continue;
    }
    if (current.type === openType) {
      depth += 1;
    }
    if (current.type === closeType) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }

  return tokens.length - 1;
}

function findFirstInline(
  tokens: Token[],
  start: number,
  end: number,
): Token | null {
  for (let i = start; i <= end; i += 1) {
    const current = tokens[i];
    if (current?.type === 'inline') {
      return current;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- content-block-classifier.util.spec.ts`
Expected: PASS (9/9). If the `markdown-it/lib/token.mjs` type import path errors under `nodenext` module resolution, replace it with `import type { Token } from 'markdown-it'` (using the namespace member documented in `markdown-it`'s bundled `.d.cts`, i.e. `MarkdownIt.Token`) — confirm via `pnpm exec tsc --noEmit` which form resolves cleanly in this project's TS config.

- [ ] **Step 5: Commit**

```bash
git add src/chunking/content-block-classifier.util.ts src/chunking/content-block-classifier.util.spec.ts
git commit -m "feat(chunking): add content-block classifier"
```

---

### Task 5: `MarkdownSectionParserService` (Phase 1)

**Files:**

- Create: `src/chunking/markdown-section-parser.service.ts`
- Test: `src/chunking/markdown-section-parser.service.spec.ts`

**Interfaces:**

- Consumes: `classifyRange` (Task 4), `LengthMeasurerPort`/`LENGTH_MEASURER_PORT` (Task 2), `Section`/`ContentBlock`/`HeadingPathSegment` (Task 1).
- Produces: `MarkdownSectionParserService.parse(bodyText: string): Section` — consumed by Task 9.

- [ ] **Step 1: Write the failing tests**

````typescript
// src/chunking/markdown-section-parser.service.spec.ts
import { CharLengthMeasurer } from './length-measurer';
import { MarkdownSectionParserService } from './markdown-section-parser.service';

function buildLogger(): { setContext: jest.Mock } {
  return { setContext: jest.fn() };
}

describe('MarkdownSectionParserService', () => {
  const service = new MarkdownSectionParserService(
    new CharLengthMeasurer(),
    buildLogger() as never,
  );

  it('puts content before the first heading into the implicit root section', () => {
    const root = service.parse('Intro text.\n\n# First Heading\n\nBody.');

    expect(root.headingLevel).toBe(0);
    expect(root.headingPath).toEqual([]);
    expect(root.blocks).toHaveLength(1);
    expect(root.blocks[0]?.text).toContain('Intro text.');
    expect(root.children).toHaveLength(1);
  });

  it('builds a flat single-level document correctly', () => {
    const root = service.parse('# Title\n\nSome text.');

    expect(root.children).toHaveLength(1);
    const section = root.children[0]!;
    expect(section.headingText).toBe('Title');
    expect(section.headingLevel).toBe(1);
    expect(section.headingPath).toEqual([
      { level: 1, text: 'Title', anchor: 'title' },
    ]);
    expect(section.blocks).toHaveLength(1);
    expect(section.blocks[0]?.type).toBe('paragraph');
  });

  it('nests a 3-level document and accumulates headingPath correctly', () => {
    const root = service.parse(
      '# Top\n\nTop body.\n\n## Child\n\nChild body.\n\n### Grandchild\n\nGrandchild body.',
    );

    const top = root.children[0]!;
    const child = top.children[0]!;
    const grandchild = child.children[0]!;

    expect(top.headingPath).toEqual([{ level: 1, text: 'Top', anchor: 'top' }]);
    expect(child.headingPath).toEqual([
      { level: 1, text: 'Top', anchor: 'top' },
      { level: 2, text: 'Child', anchor: 'child' },
    ]);
    expect(grandchild.headingPath).toEqual([
      { level: 1, text: 'Top', anchor: 'top' },
      { level: 2, text: 'Child', anchor: 'child' },
      { level: 3, text: 'Grandchild', anchor: 'grandchild' },
    ]);
    expect(child.blocks[0]?.text).toContain('Child body.');
    expect(grandchild.blocks[0]?.text).toContain('Grandchild body.');
  });

  it('gives a heading with no content before the next heading an empty blocks array', () => {
    const root = service.parse('# Empty\n\n## Next\n\nText.');

    expect(root.children[0]?.blocks).toEqual([]);
  });

  it('does not misparse a heading-like line inside a fenced code block', () => {
    const root = service.parse(
      '# Real Heading\n\n```\n# not a real heading\n```',
    );

    expect(root.children).toHaveLength(1);
    expect(root.children[0]?.headingText).toBe('Real Heading');
    expect(root.children[0]?.blocks).toHaveLength(1);
    expect(root.children[0]?.blocks[0]?.type).toBe('code');
  });

  it('classifies a fenced code block with its language', () => {
    const root = service.parse('# T\n\n```bash\ndocker --version\n```');

    const block = root.children[0]!.blocks[0]!;
    expect(block.type).toBe('code');
    expect(block.language).toBe('bash');
    expect(block.text).toContain('docker --version');
    expect(block.text.startsWith('```bash')).toBe(true);
  });

  it('keeps a nested sub-list inside its top-level list block, not as a separate block', () => {
    const root = service.parse(
      '# T\n\n- one\n  - nested one\n  - nested two\n- two',
    );

    const blocks = root.children[0]!.blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('list');
    expect(blocks[0]?.text).toContain('nested one');
  });

  it('reconstructs a table block byte-identically from the source', () => {
    const source = '# T\n\n| A | B |\n| --- | --- |\n| 1 | 2 |';
    const root = service.parse(source);

    const block = root.children[0]!.blocks[0]!;
    expect(block.type).toBe('table');
    expect(block.text).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |');
  });

  it('measures each block length via the injected LengthMeasurerPort', () => {
    const root = service.parse('# T\n\nHello.');

    const block = root.children[0]!.blocks[0]!;
    expect(block.length).toBe(block.text.length);
  });
});
````

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- markdown-section-parser.service.spec.ts`
Expected: FAIL with "Cannot find module './markdown-section-parser.service'"

- [ ] **Step 3: Implement `MarkdownSectionParserService`**

```typescript
// src/chunking/markdown-section-parser.service.ts
import { Inject, Injectable } from '@nestjs/common';
import MarkdownIt from 'markdown-it';
import { PinoLogger } from 'nestjs-pino';
import { classifyRange } from './content-block-classifier.util';
import { LENGTH_MEASURER_PORT, LengthMeasurerPort } from './length-measurer';
import { ContentBlock, HeadingPathSegment, Section } from './chunking.types';

interface HeadingStackEntry {
  level: number;
  section: Section;
}

@Injectable()
export class MarkdownSectionParserService {
  private readonly markdownIt = new MarkdownIt();

  constructor(
    @Inject(LENGTH_MEASURER_PORT)
    private readonly lengthMeasurer: LengthMeasurerPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(MarkdownSectionParserService.name);
  }

  parse(bodyText: string): Section {
    const tokens = this.markdownIt.parse(bodyText, {});
    const lines = bodyText.split('\n');

    const root: Section = {
      headingText: '',
      headingLevel: 0,
      anchor: '',
      headingPath: [],
      blocks: [],
      children: [],
    };

    const stack: HeadingStackEntry[] = [{ level: 0, section: root }];

    let i = 0;
    while (i < tokens.length) {
      const token = tokens[i];
      if (!token) {
        i += 1;
        continue;
      }

      if (token.type === 'heading_open') {
        const level = Number(token.tag.slice(1));
        const inline = tokens[i + 1];
        const headingText = inline?.type === 'inline' ? inline.content : '';
        const anchor = this.slugify(headingText);

        while (stack.length > 1 && stack[stack.length - 1]!.level >= level) {
          stack.pop();
        }

        const parent = stack[stack.length - 1]!.section;
        const headingPath: HeadingPathSegment[] = [
          ...parent.headingPath,
          { level, text: headingText, anchor },
        ];
        const newSection: Section = {
          headingText,
          headingLevel: level,
          anchor,
          headingPath,
          blocks: [],
          children: [],
        };
        parent.children.push(newSection);
        stack.push({ level, section: newSection });

        i += 3; // heading_open, inline, heading_close
        continue;
      }

      const classified = classifyRange(tokens, i);
      if (!classified) {
        i += 1;
        continue;
      }

      const currentSection = stack[stack.length - 1]!.section;
      const block = this.buildBlock(
        classified.type,
        tokens,
        i,
        classified.endIndex,
        lines,
      );
      currentSection.blocks.push(block);
      i = classified.endIndex + 1;
    }

    return root;
  }

  private buildBlock(
    type: ContentBlock['type'],
    tokens: ReturnType<MarkdownIt['parse']>,
    startIndex: number,
    endIndex: number,
    lines: string[],
  ): ContentBlock {
    const openToken = tokens[startIndex]!;
    const text = this.sliceByMap(openToken.map, lines);

    if (type === 'code') {
      return {
        type,
        text,
        language: openToken.info.trim() || null,
        length: this.lengthMeasurer.measure(text),
      };
    }

    if (type === 'list') {
      const itemTexts = this.extractListItems(
        tokens,
        startIndex,
        endIndex,
        lines,
      );
      return {
        type,
        text,
        language: null,
        length: this.lengthMeasurer.measure(text),
        itemTexts,
      };
    }

    if (type === 'table') {
      const { headerText, rowTexts } = this.extractTableRows(
        tokens,
        startIndex,
        endIndex,
        lines,
      );
      return {
        type,
        text,
        language: null,
        length: this.lengthMeasurer.measure(text),
        headerText,
        rowTexts,
      };
    }

    return {
      type,
      text,
      language: null,
      length: this.lengthMeasurer.measure(text),
    };
  }

  private extractListItems(
    tokens: ReturnType<MarkdownIt['parse']>,
    startIndex: number,
    endIndex: number,
    lines: string[],
  ): string[] {
    const itemTexts: string[] = [];
    let depth = 0;

    for (let i = startIndex; i <= endIndex; i += 1) {
      const token = tokens[i];
      if (!token) {
        continue;
      }
      if (
        token.type === 'bullet_list_open' ||
        token.type === 'ordered_list_open'
      ) {
        depth += 1;
      }
      if (
        token.type === 'bullet_list_close' ||
        token.type === 'ordered_list_close'
      ) {
        depth -= 1;
      }
      if (token.type === 'list_item_open' && depth === 1) {
        itemTexts.push(this.sliceByMap(token.map, lines));
      }
    }

    return itemTexts;
  }

  private extractTableRows(
    tokens: ReturnType<MarkdownIt['parse']>,
    startIndex: number,
    endIndex: number,
    lines: string[],
  ): { headerText: string; rowTexts: string[] } {
    let headerText = '';
    const rowTexts: string[] = [];
    let inTbody = false;

    for (let i = startIndex; i <= endIndex; i += 1) {
      const token = tokens[i];
      if (!token) {
        continue;
      }
      if (token.type === 'thead_open') {
        const theadClose = tokens
          .slice(i, endIndex + 1)
          .findIndex((t) => t.type === 'thead_close');
        const closeIndex = i + theadClose;
        const startLine = token.map?.[0] ?? i;
        const endLine = tokens[closeIndex]?.map?.[1] ?? startLine + 1;
        headerText = lines.slice(startLine, endLine).join('\n');
      }
      if (token.type === 'tbody_open') {
        inTbody = true;
      }
      if (token.type === 'tbody_close') {
        inTbody = false;
      }
      if (token.type === 'tr_open' && inTbody) {
        rowTexts.push(this.sliceByMap(token.map, lines));
      }
    }

    return { headerText, rowTexts };
  }

  private sliceByMap(map: [number, number] | null, lines: string[]): string {
    if (!map) {
      return '';
    }
    return lines.slice(map[0], map[1]).join('\n');
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- markdown-section-parser.service.spec.ts`
Expected: PASS (9/9). If `extractTableRows`'s `tr_open` line-range assertions fail because `tr_open` tokens don't carry `.map` as expected, fall back to computing each row's range from its first/last `td_open`/`th_open` child tokens' own `.map` values instead — add a test fixture that logs `JSON.stringify(tokens, null, 2)` temporarily to inspect the real token shape if needed, per this plan's Global Constraints note.

- [ ] **Step 5: Commit**

```bash
git add src/chunking/markdown-section-parser.service.ts src/chunking/markdown-section-parser.service.spec.ts
git commit -m "feat(chunking): add MarkdownSectionParserService (Phase 1)"
```

---

### Task 6: `SectionSizeBounderService` (Phase 2 — the algorithmic core)

**Files:**

- Create: `src/chunking/section-size-bounder.service.ts`
- Test: `src/chunking/section-size-bounder.service.spec.ts`

**Interfaces:**

- Consumes: `Section`/`ContentBlock`/`ResolvedPiece`/`HeadingPathSegment` (Task 1), `LengthMeasurerPort`/`LENGTH_MEASURER_PORT` (Task 2), `ChunkingConfigService` (Task 3).
- Produces: `SectionSizeBounderService.bound(root: Section): ResolvedPiece[]` — consumed by Task 9. Also exports `SizeBoundingConfig` (`{ maxChunkSize: number; minChunkSize: number }`, a narrow slice of `ChunkingConfigService` for easy testing with a plain object instead of a full mocked service).

- [ ] **Step 1: Write the failing tests**

````typescript
// src/chunking/section-size-bounder.service.spec.ts
import { ContentBlock, Section } from './chunking.types';
import { SectionSizeBounderService } from './section-size-bounder.service';

function buildLogger(): { setContext: jest.Mock } {
  return { setContext: jest.fn() };
}

// A stub measurer whose length is always the block's text length in
// characters — deterministic and easy to reason about in test fixtures.
const stubMeasurer = { measure: (text: string) => text.length };

function block(type: ContentBlock['type'], text: string): ContentBlock {
  return { type, text, language: null, length: text.length };
}

function section(
  headingText: string,
  level: number,
  parentPath: { level: number; text: string; anchor: string }[],
  blocks: ContentBlock[],
  children: Section[] = [],
): Section {
  const anchor = headingText.toLowerCase().replace(/\s+/g, '-');
  return {
    headingText,
    headingLevel: level,
    anchor,
    headingPath: [...parentPath, { level, text: headingText, anchor }],
    blocks,
    children,
  };
}

function root(children: Section[]): Section {
  return {
    headingText: '',
    headingLevel: 0,
    anchor: '',
    headingPath: [],
    blocks: [],
    children,
  };
}

describe('SectionSizeBounderService', () => {
  const service = new SectionSizeBounderService(
    stubMeasurer,
    buildLogger() as never,
  );

  it('emits one piece for a section within size bounds', () => {
    const doc = root([
      section('Intro', 1, [], [block('paragraph', 'short text')]),
    ]);

    const pieces = service.bound(doc, { maxChunkSize: 100, minChunkSize: 5 });

    expect(pieces).toHaveLength(1);
    expect(pieces[0]?.wasSplit).toBe(false);
    expect(pieces[0]?.wasMerged).toBe(false);
    expect(pieces[0]?.text).toContain('short text');
  });

  it('splits an oversized section into multiple pieces at block boundaries', () => {
    const doc = root([
      section(
        'Big',
        1,
        [],
        [
          block('paragraph', 'a'.repeat(30)),
          block('paragraph', 'b'.repeat(30)),
          block('paragraph', 'c'.repeat(30)),
        ],
      ),
    ]);

    const pieces = service.bound(doc, { maxChunkSize: 40, minChunkSize: 5 });

    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((p) => p.wasSplit)).toBe(true);
    expect(pieces.map((p) => p.localSequenceIndex)).toEqual(
      pieces.map((_, i) => i),
    );
  });

  it('keeps an oversized code block intact and flags exceedsMaxSize', () => {
    const doc = root([
      section(
        'Code',
        1,
        [],
        [block('code', '```\n' + 'x'.repeat(100) + '\n```')],
      ),
    ]);

    const pieces = service.bound(doc, { maxChunkSize: 20, minChunkSize: 5 });

    expect(pieces).toHaveLength(1);
    expect(pieces[0]?.exceedsMaxSize).toBe(true);
    expect(pieces[0]?.text).toContain('x'.repeat(100));
  });

  it('merges two adjacent undersized siblings under the same parent', () => {
    const doc = root([
      section('A', 1, [], [block('paragraph', 'short')]),
      section('B', 1, [], [block('paragraph', 'also short')]),
    ]);

    const pieces = service.bound(doc, { maxChunkSize: 1000, minChunkSize: 50 });

    expect(pieces).toHaveLength(1);
    expect(pieces[0]?.wasMerged).toBe(true);
    expect(pieces[0]?.mergedHeadings).toEqual(['B']);
    expect(pieces[0]?.text).toContain('short');
    expect(pieces[0]?.text).toContain('also short');
  });

  it('never merges two undersized sections that have different parents', () => {
    const doc = root([
      section(
        'Parent1',
        1,
        [],
        [],
        [
          section(
            'A',
            2,
            [{ level: 1, text: 'Parent1', anchor: 'parent1' }],
            [block('paragraph', 'tiny')],
          ),
        ],
      ),
      section(
        'Parent2',
        1,
        [],
        [],
        [
          section(
            'B',
            2,
            [{ level: 1, text: 'Parent2', anchor: 'parent2' }],
            [block('paragraph', 'tiny too')],
          ),
        ],
      ),
    ]);

    const pieces = service.bound(doc, { maxChunkSize: 1000, minChunkSize: 50 });
    const merged = pieces.filter((p) => p.wasMerged);

    expect(merged).toHaveLength(0);
  });

  it('never folds an undersized section into a normal-sized adjacent sibling', () => {
    const doc = root([
      section('Normal', 1, [], [block('paragraph', 'x'.repeat(60))]),
      section('Tiny', 1, [], [block('paragraph', 'tiny')]),
    ]);

    const pieces = service.bound(doc, { maxChunkSize: 1000, minChunkSize: 50 });
    const normalPiece = pieces.find((p) => p.text.includes('x'.repeat(60)));

    expect(normalPiece?.wasMerged).toBe(false);
    expect(normalPiece?.text).not.toContain('tiny');
    expect(pieces).toHaveLength(2);
  });

  it('splits a run of undersized siblings into two groups when combined length would exceed maxChunkSize', () => {
    const doc = root([
      section('A', 1, [], [block('paragraph', 'a'.repeat(20))]),
      section('B', 1, [], [block('paragraph', 'b'.repeat(20))]),
      section('C', 1, [], [block('paragraph', 'c'.repeat(20))]),
    ]);

    const pieces = service.bound(doc, { maxChunkSize: 35, minChunkSize: 25 });
    const mergedPieces = pieces.filter((p) => p.wasMerged);

    expect(mergedPieces.length).toBeGreaterThanOrEqual(1);
    expect(pieces.every((p) => p.length <= 35)).toBe(true);
  });

  it('keeps a single oversized list item intact with exceedsMaxSize true', () => {
    const bigItem = 'x'.repeat(100);
    const listBlock: ContentBlock = {
      type: 'list',
      text: `- ${bigItem}\n- short`,
      language: null,
      length: `- ${bigItem}\n- short`.length,
      itemTexts: [`- ${bigItem}`, '- short'],
    };
    const doc = root([section('List', 1, [], [listBlock])]);

    const pieces = service.bound(doc, { maxChunkSize: 20, minChunkSize: 5 });

    const oversizedPiece = pieces.find((p) => p.text.includes(bigItem));
    expect(oversizedPiece?.exceedsMaxSize).toBe(true);
  });

  it('splits an oversized table by row and repeats the header in each piece', () => {
    const header = '| A | B |\n| --- | --- |';
    const rows = ['| 1 | 2 |', '| 3 | 4 |', '| 5 | 6 |'];
    const tableBlock: ContentBlock = {
      type: 'table',
      text: [header, ...rows].join('\n'),
      language: null,
      length: [header, ...rows].join('\n').length,
      headerText: header,
      rowTexts: rows,
    };
    const doc = root([section('Table', 1, [], [tableBlock])]);

    const pieces = service.bound(doc, { maxChunkSize: 40, minChunkSize: 5 });

    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.text).toContain(header);
    }
  });

  it('resolves nested children after a merged sibling group, preserving document order', () => {
    const doc = root([
      section(
        'A',
        1,
        [],
        [block('paragraph', 'tiny a')],
        [
          section(
            'A-Child',
            2,
            [{ level: 1, text: 'A', anchor: 'a' }],
            [block('paragraph', 'a child body')],
          ),
        ],
      ),
      section('B', 1, [], [block('paragraph', 'tiny b')]),
    ]);

    const pieces = service.bound(doc, { maxChunkSize: 1000, minChunkSize: 50 });

    expect(pieces[0]?.wasMerged).toBe(true);
    expect(pieces[1]?.text).toContain('a child body');
  });
});
````

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- section-size-bounder.service.spec.ts`
Expected: FAIL with "Cannot find module './section-size-bounder.service'"

- [ ] **Step 3: Implement `SectionSizeBounderService`**

```typescript
// src/chunking/section-size-bounder.service.ts
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { LENGTH_MEASURER_PORT, LengthMeasurerPort } from './length-measurer';
import { ContentBlock, ResolvedPiece, Section } from './chunking.types';

export interface SizeBoundingConfig {
  maxChunkSize: number;
  minChunkSize: number;
}

interface SiblingGroup {
  pieces: ResolvedPiece[];
  memberIndices: number[];
}

@Injectable()
export class SectionSizeBounderService {
  constructor(
    @Inject(LENGTH_MEASURER_PORT)
    private readonly lengthMeasurer: LengthMeasurerPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SectionSizeBounderService.name);
  }

  bound(root: Section, config: SizeBoundingConfig): ResolvedPiece[] {
    return this.resolveSiblingGroup(root.children, config);
  }

  private resolveSiblingGroup(
    children: Section[],
    config: SizeBoundingConfig,
  ): ResolvedPiece[] {
    if (children.length === 0) {
      return [];
    }

    const ownPiecesPerChild = children.map((child) =>
      this.resolveOwnPieces(child, config),
    );
    const groups = this.mergeUndersizedSiblings(
      children,
      ownPiecesPerChild,
      config,
    );

    const result: ResolvedPiece[] = [];
    for (const group of groups) {
      result.push(...group.pieces);
      for (const memberIndex of group.memberIndices) {
        const child = children[memberIndex]!;
        result.push(...this.resolveSiblingGroup(child.children, config));
      }
    }
    return result;
  }

  private resolveOwnPieces(
    section: Section,
    config: SizeBoundingConfig,
  ): ResolvedPiece[] {
    const headingLine = this.headingLineFor(section);
    const headingLength = this.lengthMeasurer.measure(headingLine);
    const ownLength =
      section.blocks.reduce((sum, block) => sum + block.length, 0) +
      headingLength;

    if (ownLength > config.maxChunkSize) {
      return this.splitAtBlockBoundaries(
        section,
        config,
        headingLine,
        headingLength,
      );
    }

    return [this.oneResolvedPieceFor(section, headingLine, ownLength)];
  }

  private oneResolvedPieceFor(
    section: Section,
    headingLine: string,
    length: number,
  ): ResolvedPiece {
    const bodyText = section.blocks.map((block) => block.text).join('\n\n');
    const text = headingLine
      ? `${headingLine}\n\n${bodyText}`.trim()
      : bodyText;
    const contentTypes = Array.from(
      new Set(section.blocks.map((block) => block.type)),
    );

    return {
      section,
      headingPath: section.headingPath,
      localSequenceIndex: 0,
      text,
      length,
      wasSplit: false,
      wasMerged: false,
      mergedHeadings: [],
      exceedsMaxSize: false,
      contentTypes,
    };
  }

  private splitAtBlockBoundaries(
    section: Section,
    config: SizeBoundingConfig,
    headingLine: string,
    headingLength: number,
  ): ResolvedPiece[] {
    const expandedBlocks = section.blocks.flatMap((block) =>
      this.expandOversizedBlock(block, config),
    );

    const pieces: ContentBlock[][] = [];
    let current: ContentBlock[] = [];
    let currentLength = headingLength;

    for (const block of expandedBlocks) {
      const wouldExceed =
        current.length > 0 &&
        currentLength + block.length > config.maxChunkSize;
      if (wouldExceed) {
        pieces.push(current);
        current = [];
        currentLength = headingLength;
      }
      current.push(block);
      currentLength += block.length;
    }
    if (current.length > 0) {
      pieces.push(current);
    }

    return pieces.map((blocks, index) => {
      const bodyText = blocks.map((block) => block.text).join('\n\n');
      const text = headingLine
        ? `${headingLine}\n\n${bodyText}`.trim()
        : bodyText;
      const length = blocks.reduce(
        (sum, block) => sum + block.length,
        headingLength,
      );
      const exceedsMaxSize =
        blocks.length === 1 && blocks[0]!.length > config.maxChunkSize;
      const contentTypes = Array.from(
        new Set(blocks.map((block) => block.type)),
      );

      return {
        section,
        headingPath: section.headingPath,
        localSequenceIndex: index,
        text,
        length,
        wasSplit: true,
        wasMerged: false,
        mergedHeadings: [],
        exceedsMaxSize,
        contentTypes,
      };
    });
  }

  private expandOversizedBlock(
    block: ContentBlock,
    config: SizeBoundingConfig,
  ): ContentBlock[] {
    if (block.length <= config.maxChunkSize) {
      return [block];
    }
    if (block.type === 'table' && block.headerText && block.rowTexts) {
      return this.splitTableByRow(
        block,
        block.headerText,
        block.rowTexts,
        config,
      );
    }
    if (block.type === 'list' && block.itemTexts) {
      return this.splitListByItem(block, block.itemTexts, config);
    }
    return [block];
  }

  private splitTableByRow(
    original: ContentBlock,
    headerText: string,
    rowTexts: string[],
    config: SizeBoundingConfig,
  ): ContentBlock[] {
    const headerLength = this.lengthMeasurer.measure(headerText);
    const pieces: string[][] = [];
    let current: string[] = [];
    let currentLength = headerLength;

    for (const row of rowTexts) {
      const rowLength = this.lengthMeasurer.measure(row);
      if (
        current.length > 0 &&
        currentLength + rowLength > config.maxChunkSize
      ) {
        pieces.push(current);
        current = [];
        currentLength = headerLength;
      }
      current.push(row);
      currentLength += rowLength;
    }
    if (current.length > 0) {
      pieces.push(current);
    }

    return pieces.map((rows) => {
      const text = [headerText, ...rows].join('\n');
      return {
        type: 'table',
        text,
        language: null,
        length: this.lengthMeasurer.measure(text),
        headerText,
        rowTexts: rows,
      };
    });
  }

  private splitListByItem(
    original: ContentBlock,
    itemTexts: string[],
    config: SizeBoundingConfig,
  ): ContentBlock[] {
    const pieces: string[][] = [];
    let current: string[] = [];
    let currentLength = 0;

    for (const item of itemTexts) {
      const itemLength = this.lengthMeasurer.measure(item);
      if (
        current.length > 0 &&
        currentLength + itemLength > config.maxChunkSize
      ) {
        pieces.push(current);
        current = [];
        currentLength = 0;
      }
      current.push(item);
      currentLength += itemLength;
    }
    if (current.length > 0) {
      pieces.push(current);
    }

    return pieces.map((items) => {
      const text = items.join('\n');
      return {
        type: 'list',
        text,
        language: null,
        length: this.lengthMeasurer.measure(text),
        itemTexts: items,
      };
    });
  }

  private mergeUndersizedSiblings(
    children: Section[],
    ownPiecesPerChild: ResolvedPiece[][],
    config: SizeBoundingConfig,
  ): SiblingGroup[] {
    const groups: SiblingGroup[] = [];
    let pendingRun: number[] = [];
    let pendingLength = 0;

    const flush = (): void => {
      if (pendingRun.length === 0) {
        return;
      }
      if (pendingRun.length === 1) {
        const index = pendingRun[0]!;
        groups.push({
          pieces: ownPiecesPerChild[index]!,
          memberIndices: [index],
        });
      } else {
        groups.push({
          pieces: [this.mergeRun(children, ownPiecesPerChild, pendingRun)],
          memberIndices: [...pendingRun],
        });
      }
      pendingRun = [];
      pendingLength = 0;
    };

    children.forEach((_, index) => {
      const pieces = ownPiecesPerChild[index]!;
      const singlePiece = pieces.length === 1 ? pieces[0]! : null;
      const isEligible =
        singlePiece !== null &&
        !singlePiece.wasSplit &&
        singlePiece.length < config.minChunkSize;

      if (!isEligible) {
        flush();
        groups.push({ pieces, memberIndices: [index] });
        return;
      }

      const candidateLength = pendingLength + singlePiece!.length;
      if (pendingRun.length > 0 && candidateLength > config.maxChunkSize) {
        flush();
      }
      pendingRun.push(index);
      pendingLength += singlePiece!.length;
    });

    flush();
    return groups;
  }

  private mergeRun(
    children: Section[],
    ownPiecesPerChild: ResolvedPiece[][],
    indices: number[],
  ): ResolvedPiece {
    const firstIndex = indices[0]!;
    const firstSection = children[firstIndex]!;
    const firstPiece = ownPiecesPerChild[firstIndex]![0]!;

    const mergedHeadings = indices
      .slice(1)
      .map((index) => children[index]!.headingText);
    const combinedText = indices
      .map((index) => ownPiecesPerChild[index]![0]!.text)
      .join('\n\n');
    const combinedLength = indices.reduce(
      (sum, index) => sum + ownPiecesPerChild[index]![0]!.length,
      0,
    );
    const contentTypes = Array.from(
      new Set(
        indices.flatMap((index) => ownPiecesPerChild[index]![0]!.contentTypes),
      ),
    );

    return {
      section: firstSection,
      headingPath: firstPiece.headingPath,
      localSequenceIndex: 0,
      text: combinedText,
      length: combinedLength,
      wasSplit: false,
      wasMerged: true,
      mergedHeadings,
      exceedsMaxSize: false,
      contentTypes,
    };
  }

  private headingLineFor(section: Section): string {
    if (section.headingLevel === 0) {
      return '';
    }
    return `${'#'.repeat(section.headingLevel)} ${section.headingText}`;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- section-size-bounder.service.spec.ts`
Expected: PASS (11/11)

- [ ] **Step 5: Commit**

```bash
git add src/chunking/section-size-bounder.service.ts src/chunking/section-size-bounder.service.spec.ts
git commit -m "feat(chunking): add SectionSizeBounderService (Phase 2)"
```

---

### Task 7: Chunk ID derivation

**Files:**

- Create: `src/chunking/chunk-id.util.ts`
- Test: `src/chunking/chunk-id.util.spec.ts`

**Interfaces:**

- Consumes: `HeadingPathSegment` (Task 1).
- Produces: `deriveChunkId(documentId: string, headingPath: HeadingPathSegment[], localSequenceIndex: number): string` — consumed by Task 8.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/chunking/chunk-id.util.spec.ts
import { createHash } from 'node:crypto';
import { deriveChunkId } from './chunk-id.util';
import { HeadingPathSegment } from './chunking.types';

const path: HeadingPathSegment[] = [
  { level: 1, text: 'Install', anchor: 'install' },
  { level: 2, text: 'On Ubuntu', anchor: 'on-ubuntu' },
];

describe('deriveChunkId', () => {
  it('produces a deterministic SHA-256 hash of documentId + anchors + index', () => {
    const expected = createHash('sha256')
      .update('doc1::install/on-ubuntu::0', 'utf-8')
      .digest('hex');

    expect(deriveChunkId('doc1', path, 0)).toBe(expected);
  });

  it('returns the same id for the same inputs across calls', () => {
    expect(deriveChunkId('doc1', path, 0)).toBe(deriveChunkId('doc1', path, 0));
  });

  it('changes when documentId changes', () => {
    expect(deriveChunkId('doc1', path, 0)).not.toBe(
      deriveChunkId('doc2', path, 0),
    );
  });

  it('changes when headingPath changes', () => {
    const otherPath: HeadingPathSegment[] = [
      { level: 1, text: 'Setup', anchor: 'setup' },
    ];
    expect(deriveChunkId('doc1', path, 0)).not.toBe(
      deriveChunkId('doc1', otherPath, 0),
    );
  });

  it('changes when localSequenceIndex changes', () => {
    expect(deriveChunkId('doc1', path, 0)).not.toBe(
      deriveChunkId('doc1', path, 1),
    );
  });

  it('produces the same id regardless of headingPath text/level, only anchor matters', () => {
    const samePathDifferentText: HeadingPathSegment[] = [
      { level: 99, text: 'Renamed', anchor: 'install' },
      { level: 99, text: 'Renamed too', anchor: 'on-ubuntu' },
    ];
    expect(deriveChunkId('doc1', path, 0)).toBe(
      deriveChunkId('doc1', samePathDifferentText, 0),
    );
  });

  it('handles an empty headingPath (root section content)', () => {
    const id = deriveChunkId('doc1', [], 0);
    const expected = createHash('sha256')
      .update('doc1::::0', 'utf-8')
      .digest('hex');
    expect(id).toBe(expected);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- chunk-id.util.spec.ts`
Expected: FAIL with "Cannot find module './chunk-id.util'"

- [ ] **Step 3: Implement `deriveChunkId`**

```typescript
// src/chunking/chunk-id.util.ts
import { createHash } from 'node:crypto';
import { HeadingPathSegment } from './chunking.types';

export function deriveChunkId(
  documentId: string,
  headingPath: HeadingPathSegment[],
  localSequenceIndex: number,
): string {
  const pathKey = headingPath.map((segment) => segment.anchor).join('/');
  return createHash('sha256')
    .update(`${documentId}::${pathKey}::${localSequenceIndex}`, 'utf-8')
    .digest('hex');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- chunk-id.util.spec.ts`
Expected: PASS (7/7)

- [ ] **Step 5: Commit**

```bash
git add src/chunking/chunk-id.util.ts src/chunking/chunk-id.util.spec.ts
git commit -m "feat(chunking): add deterministic chunk ID derivation"
```

---

### Task 8: `ChunkAssemblerService` (Phase 3)

**Files:**

- Create: `src/chunking/chunk-assembler.service.ts`
- Test: `src/chunking/chunk-assembler.service.spec.ts`

**Interfaces:**

- Consumes: `ResolvedPiece`/`Section`/`Chunk`/`ChunkMetadata`/`ChunkRelationships` (Task 1), `ChunkingConfigService` (Task 3), `deriveChunkId` (Task 7).
- Produces: `ChunkAssemblerService.assemble(pieces: ResolvedPiece[], root: Section, documentId: string, sourcePath: string, documentTitle: string): Chunk[]` — consumed by Task 9.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/chunking/chunk-assembler.service.spec.ts
import { ChunkAssemblerService } from './chunk-assembler.service';
import { ChunkingConfigService } from './chunking-config.service';
import { ResolvedPiece, Section } from './chunking.types';

function buildLogger(): { setContext: jest.Mock } {
  return { setContext: jest.fn() };
}

function buildConfig(
  overrides: Partial<{
    includeParentChunks: boolean;
    overlapStrategy: 'none' | 'heading-context' | 'sentence-overlap';
    overlapSentences: number;
  }> = {},
): ChunkingConfigService {
  return {
    includeParentChunks: overrides.includeParentChunks ?? true,
    overlapStrategy: overrides.overlapStrategy ?? 'heading-context',
    overlapSentences: overrides.overlapSentences ?? 1,
  } as ChunkingConfigService;
}

function sectionOf(headingText: string, level = 1): Section {
  const anchor = headingText.toLowerCase().replace(/\s+/g, '-');
  return {
    headingText,
    headingLevel: level,
    anchor,
    headingPath: [{ level, text: headingText, anchor }],
    blocks: [],
    children: [],
  };
}

function pieceFor(
  section: Section,
  overrides: Partial<ResolvedPiece> = {},
): ResolvedPiece {
  return {
    section,
    headingPath: section.headingPath,
    localSequenceIndex: 0,
    text: `## ${section.headingText}\n\nBody.`,
    length: 10,
    wasSplit: false,
    wasMerged: false,
    mergedHeadings: [],
    exceedsMaxSize: false,
    contentTypes: ['paragraph'],
    ...overrides,
  };
}

describe('ChunkAssemblerService', () => {
  it('assembles one child chunk per resolved piece with correct metadata', () => {
    const service = new ChunkAssemblerService(
      buildConfig(),
      buildLogger() as never,
    );
    const sectionA = sectionOf('A');
    const root: Section = {
      headingText: '',
      headingLevel: 0,
      anchor: '',
      headingPath: [],
      blocks: [],
      children: [sectionA],
    };
    const pieces = [pieceFor(sectionA)];

    const chunks = service.assemble(pieces, root, 'doc1', 'a.md', 'A Doc');
    const childChunks = chunks.filter((c) => c.metadata.chunkType === 'child');

    expect(childChunks).toHaveLength(1);
    expect(childChunks[0]?.metadata.documentId).toBe('doc1');
    expect(childChunks[0]?.metadata.sourcePath).toBe('a.md');
    expect(childChunks[0]?.metadata.headingPath).toEqual(sectionA.headingPath);
    expect(childChunks[0]?.metadata.sequenceIndex).toBe(0);
    expect(childChunks[0]?.metadata.contentHash).toHaveLength(64);
  });

  it('links previousChunkId/nextChunkId across the whole document in reading order', () => {
    const service = new ChunkAssemblerService(
      buildConfig(),
      buildLogger() as never,
    );
    const sectionA = sectionOf('A');
    const sectionB = sectionOf('B');
    const root: Section = {
      headingText: '',
      headingLevel: 0,
      anchor: '',
      headingPath: [],
      blocks: [],
      children: [sectionA, sectionB],
    };
    const pieces = [pieceFor(sectionA), pieceFor(sectionB)];

    const chunks = service.assemble(pieces, root, 'doc1', 'a.md', 'A Doc');
    const childChunks = chunks.filter((c) => c.metadata.chunkType === 'child');

    expect(childChunks[0]?.relationships.previousChunkId).toBeNull();
    expect(childChunks[0]?.relationships.nextChunkId).toBe(
      childChunks[1]?.chunkId,
    );
    expect(childChunks[1]?.relationships.previousChunkId).toBe(
      childChunks[0]?.chunkId,
    );
    expect(childChunks[1]?.relationships.nextChunkId).toBeNull();
  });

  it('emits one parent chunk per section when includeParentChunks is true, always with null parentChunkId', () => {
    const service = new ChunkAssemblerService(
      buildConfig({ includeParentChunks: true }),
      buildLogger() as never,
    );
    const sectionA = sectionOf('A');
    const root: Section = {
      headingText: '',
      headingLevel: 0,
      anchor: '',
      headingPath: [],
      blocks: [],
      children: [sectionA],
    };
    const pieces = [pieceFor(sectionA)];

    const chunks = service.assemble(pieces, root, 'doc1', 'a.md', 'A Doc');
    const parentChunks = chunks.filter(
      (c) => c.metadata.chunkType === 'parent',
    );

    expect(parentChunks).toHaveLength(1);
    expect(parentChunks[0]?.relationships.parentChunkId).toBeNull();
    expect(parentChunks[0]?.relationships.previousChunkId).toBeNull();
    expect(parentChunks[0]?.relationships.nextChunkId).toBeNull();
  });

  it('links a child chunk to its own section parent chunk, and the parent back to its children', () => {
    const service = new ChunkAssemblerService(
      buildConfig({ includeParentChunks: true }),
      buildLogger() as never,
    );
    const sectionA = sectionOf('A');
    const root: Section = {
      headingText: '',
      headingLevel: 0,
      anchor: '',
      headingPath: [],
      blocks: [],
      children: [sectionA],
    };
    const pieces = [pieceFor(sectionA)];

    const chunks = service.assemble(pieces, root, 'doc1', 'a.md', 'A Doc');
    const parentChunk = chunks.find((c) => c.metadata.chunkType === 'parent')!;
    const childChunk = chunks.find((c) => c.metadata.chunkType === 'child')!;

    expect(childChunk.relationships.parentChunkId).toBe(parentChunk.chunkId);
    expect(parentChunk.relationships.childChunkIds).toEqual([
      childChunk.chunkId,
    ]);
  });

  it('gives a section whose content was merged away an empty parent childChunkIds', () => {
    const service = new ChunkAssemblerService(
      buildConfig({ includeParentChunks: true }),
      buildLogger() as never,
    );
    const sectionA = sectionOf('A');
    const sectionB = sectionOf('B');
    const root: Section = {
      headingText: '',
      headingLevel: 0,
      anchor: '',
      headingPath: [],
      blocks: [],
      children: [sectionA, sectionB],
    };
    // Simulate a merge: one piece whose `section` is sectionA (the "first"
    // section in the merged run) and mergedHeadings includes B's heading.
    const mergedPiece = pieceFor(sectionA, {
      wasMerged: true,
      mergedHeadings: ['B'],
    });

    const chunks = service.assemble(
      [mergedPiece],
      root,
      'doc1',
      'a.md',
      'A Doc',
    );
    const parentOfB = chunks.find(
      (c) =>
        c.metadata.chunkType === 'parent' &&
        c.metadata.headingPath[0]?.text === 'B',
    )!;

    expect(parentOfB.relationships.childChunkIds).toEqual([]);
  });

  it('produces no parent chunks when includeParentChunks is false', () => {
    const service = new ChunkAssemblerService(
      buildConfig({ includeParentChunks: false }),
      buildLogger() as never,
    );
    const sectionA = sectionOf('A');
    const root: Section = {
      headingText: '',
      headingLevel: 0,
      anchor: '',
      headingPath: [],
      blocks: [],
      children: [sectionA],
    };
    const pieces = [pieceFor(sectionA)];

    const chunks = service.assemble(pieces, root, 'doc1', 'a.md', 'A Doc');

    expect(chunks.every((c) => c.metadata.chunkType === 'child')).toBe(true);
    expect(chunks[0]?.relationships.parentChunkId).toBeNull();
  });

  it('prefixes a heading-context breadcrumb on split continuation pieces only', () => {
    const service = new ChunkAssemblerService(
      buildConfig({ overlapStrategy: 'heading-context' }),
      buildLogger() as never,
    );
    const sectionA = sectionOf('A');
    const root: Section = {
      headingText: '',
      headingLevel: 0,
      anchor: '',
      headingPath: [],
      blocks: [],
      children: [sectionA],
    };
    const firstPiece = pieceFor(sectionA, {
      wasSplit: true,
      localSequenceIndex: 0,
    });
    const secondPiece = pieceFor(sectionA, {
      wasSplit: true,
      localSequenceIndex: 1,
    });

    const chunks = service.assemble(
      [firstPiece, secondPiece],
      root,
      'doc1',
      'a.md',
      'A Doc',
    );
    const childChunks = chunks.filter((c) => c.metadata.chunkType === 'child');

    expect(childChunks[0]?.text).not.toContain('continued from');
    expect(childChunks[1]?.text).toContain('continued from');
  });

  it('applies no overlap text when overlapStrategy is none', () => {
    const service = new ChunkAssemblerService(
      buildConfig({ overlapStrategy: 'none' }),
      buildLogger() as never,
    );
    const sectionA = sectionOf('A');
    const root: Section = {
      headingText: '',
      headingLevel: 0,
      anchor: '',
      headingPath: [],
      blocks: [],
      children: [sectionA],
    };
    const secondPiece = pieceFor(sectionA, {
      wasSplit: true,
      localSequenceIndex: 1,
    });

    const chunks = service.assemble(
      [secondPiece],
      root,
      'doc1',
      'a.md',
      'A Doc',
    );

    expect(chunks[0]?.text).not.toContain('continued from');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- chunk-assembler.service.spec.ts`
Expected: FAIL with "Cannot find module './chunk-assembler.service'"

- [ ] **Step 3: Implement `ChunkAssemblerService`**

```typescript
// src/chunking/chunk-assembler.service.ts
import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { deriveChunkId } from './chunk-id.util';
import { ChunkingConfigService } from './chunking-config.service';
import {
  Chunk,
  ChunkMetadata,
  ChunkType,
  ResolvedPiece,
  Section,
} from './chunking.types';

@Injectable()
export class ChunkAssemblerService {
  constructor(
    private readonly config: ChunkingConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ChunkAssemblerService.name);
  }

  assemble(
    pieces: ResolvedPiece[],
    root: Section,
    documentId: string,
    sourcePath: string,
    documentTitle: string,
  ): Chunk[] {
    const chunkedAt = new Date().toISOString();

    const childChunks = pieces.map((piece, index) =>
      this.buildChildChunk(
        piece,
        index,
        documentId,
        sourcePath,
        documentTitle,
        chunkedAt,
      ),
    );
    this.applyOverlap(childChunks, pieces);
    this.linkSequence(childChunks);

    if (!this.config.includeParentChunks) {
      return childChunks;
    }

    const parentChunks = this.buildParentChunks(
      root,
      pieces,
      childChunks,
      documentId,
      sourcePath,
      documentTitle,
      chunkedAt,
    );
    this.linkChildrenToParents(childChunks, pieces, parentChunks, root);

    return [...parentChunks, ...childChunks];
  }

  private buildChildChunk(
    piece: ResolvedPiece,
    sequenceIndex: number,
    documentId: string,
    sourcePath: string,
    documentTitle: string,
    chunkedAt: string,
  ): Chunk {
    const chunkId = deriveChunkId(
      documentId,
      piece.headingPath,
      piece.localSequenceIndex,
    );
    const metadata: ChunkMetadata = {
      documentId,
      sourcePath,
      documentTitle,
      headingPath: piece.headingPath,
      chunkType: 'child',
      contentTypes: piece.contentTypes,
      length: piece.length,
      sequenceIndex,
      wasSplit: piece.wasSplit,
      wasMerged: piece.wasMerged,
      mergedHeadings: piece.mergedHeadings,
      exceedsMaxSize: piece.exceedsMaxSize,
      contentHash: createHash('sha256')
        .update(piece.text, 'utf-8')
        .digest('hex'),
      chunkedAt,
    };

    return {
      chunkId,
      text: piece.text,
      metadata,
      relationships: {
        parentChunkId: null,
        childChunkIds: [],
        previousChunkId: null,
        nextChunkId: null,
      },
    };
  }

  private applyOverlap(childChunks: Chunk[], pieces: ResolvedPiece[]): void {
    if (this.config.overlapStrategy === 'none') {
      return;
    }

    childChunks.forEach((chunk, index) => {
      const piece = pieces[index]!;
      if (!piece.wasSplit || piece.localSequenceIndex === 0) {
        return;
      }

      if (this.config.overlapStrategy === 'heading-context') {
        const breadcrumb = piece.headingPath
          .map((segment) => segment.text)
          .join(' › ');
        chunk.text = `_(continued from "${breadcrumb}")_\n\n${chunk.text}`;
        return;
      }

      // 'sentence-overlap': only across paragraph-to-paragraph boundaries.
      const previousPiece = pieces[index - 1];
      if (
        previousPiece &&
        previousPiece.contentTypes[previousPiece.contentTypes.length - 1] ===
          'paragraph' &&
        piece.contentTypes[0] === 'paragraph'
      ) {
        const sentences = previousPiece.text
          .split(/(?<=[.!?])\s+/)
          .filter((sentence) => sentence.trim().length > 0);
        const overlapText = sentences
          .slice(-this.config.overlapSentences)
          .join(' ');
        if (overlapText) {
          chunk.text = `${overlapText}\n\n${chunk.text}`;
        }
      }
    });
  }

  private linkSequence(childChunks: Chunk[]): void {
    childChunks.forEach((chunk, index) => {
      chunk.relationships.previousChunkId =
        index > 0 ? childChunks[index - 1]!.chunkId : null;
      chunk.relationships.nextChunkId =
        index < childChunks.length - 1 ? childChunks[index + 1]!.chunkId : null;
    });
  }

  private buildParentChunks(
    root: Section,
    pieces: ResolvedPiece[],
    childChunks: Chunk[],
    documentId: string,
    sourcePath: string,
    documentTitle: string,
    chunkedAt: string,
  ): Chunk[] {
    const parentChunks: Chunk[] = [];
    const visit = (section: Section): void => {
      if (section.headingLevel > 0) {
        parentChunks.push(
          this.buildParentChunkFor(
            section,
            documentId,
            sourcePath,
            documentTitle,
            chunkedAt,
          ),
        );
      }
      section.children.forEach(visit);
    };
    root.children.forEach(visit);
    return parentChunks;
  }

  private buildParentChunkFor(
    section: Section,
    documentId: string,
    sourcePath: string,
    documentTitle: string,
    chunkedAt: string,
  ): Chunk {
    const fullText = this.collectFullText(section);
    const chunkId = deriveChunkId(documentId, section.headingPath, 0);
    const contentTypes = Array.from(new Set(this.collectContentTypes(section)));

    const metadata: ChunkMetadata = {
      documentId,
      sourcePath,
      documentTitle,
      headingPath: section.headingPath,
      chunkType: 'parent' as ChunkType,
      contentTypes,
      length: fullText.length,
      sequenceIndex: -1,
      wasSplit: false,
      wasMerged: false,
      mergedHeadings: [],
      exceedsMaxSize: false,
      contentHash: createHash('sha256').update(fullText, 'utf-8').digest('hex'),
      chunkedAt,
    };

    return {
      chunkId,
      text: fullText,
      metadata,
      relationships: {
        parentChunkId: null,
        childChunkIds: [],
        previousChunkId: null,
        nextChunkId: null,
      },
    };
  }

  private collectFullText(section: Section): string {
    const headingLine =
      section.headingLevel > 0
        ? `${'#'.repeat(section.headingLevel)} ${section.headingText}`
        : '';
    const ownText = section.blocks.map((block) => block.text).join('\n\n');
    const childrenText = section.children
      .map((child) => this.collectFullText(child))
      .join('\n\n');
    return [headingLine, ownText, childrenText]
      .filter((part) => part.length > 0)
      .join('\n\n');
  }

  private collectContentTypes(section: Section): ChunkMetadata['contentTypes'] {
    return [
      ...section.blocks.map((block) => block.type),
      ...section.children.flatMap((child) => this.collectContentTypes(child)),
    ];
  }

  private linkChildrenToParents(
    childChunks: Chunk[],
    pieces: ResolvedPiece[],
    parentChunks: Chunk[],
    root: Section,
  ): void {
    const parentChunkBySection = new Map<Section, Chunk>();
    const visit = (section: Section): void => {
      if (section.headingLevel > 0) {
        const chunk = parentChunks.find(
          (c) =>
            deriveChunkId('', section.headingPath, 0) ===
              deriveChunkId('', c.metadata.headingPath, 0) &&
            c.metadata.headingPath.length === section.headingPath.length,
        );
        if (chunk) {
          parentChunkBySection.set(section, chunk);
        }
      }
      section.children.forEach(visit);
    };
    root.children.forEach(visit);

    childChunks.forEach((chunk, index) => {
      const piece = pieces[index]!;
      const parentChunk = parentChunkBySection.get(piece.section);
      if (parentChunk) {
        chunk.relationships.parentChunkId = parentChunk.chunkId;
        parentChunk.relationships.childChunkIds.push(chunk.chunkId);
      }
    });
  }
}
```

**Note on `linkChildrenToParents`:** matching a `ResolvedPiece.section` (a live object reference) back to its `Chunk` requires a `Map<Section, Chunk>` keyed by object identity — the `deriveChunkId(...) === deriveChunkId(...)` comparison above is a correct but roundabout way to key by content; if `pnpm lint`/`pnpm test` surface issues with it (e.g., `no-unnecessary-condition` false positives, or the comparison ends up ambiguous when two different sections coincidentally share a `headingPath`, which cannot happen given how `headingPath` is built in Task 5 but is worth double-checking with a quick fixture test), simplify to keying the `Map` directly by the `Section` object reference (`parentChunkBySection.set(section, chunk)` inside a single combined tree walk that builds both the parent chunk and its map entry together, rather than two separate walks) — this is a safe, mechanical simplification, not a design change.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- chunk-assembler.service.spec.ts`
Expected: PASS (8/8)

- [ ] **Step 5: Commit**

```bash
git add src/chunking/chunk-assembler.service.ts src/chunking/chunk-assembler.service.spec.ts
git commit -m "feat(chunking): add ChunkAssemblerService (Phase 3)"
```

---

### Task 9: `ChunkingPipelineService`, `ChunkingModule`, and wiring into `AppModule`

**Files:**

- Create: `src/chunking/chunking-pipeline.service.ts`
- Test: `src/chunking/chunking-pipeline.service.spec.ts`
- Create: `src/chunking/chunking.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**

- Consumes: `MarkdownSectionParserService` (Task 5), `SectionSizeBounderService` (Task 6), `ChunkAssemblerService` (Task 8), `ChunkingConfigService` (Task 3), `StructuredDocument` (from `src/ingestion/ingestion.types.ts`, type-only), `EmptyDocumentError` (Task 1).
- Produces: `ChunkingPipelineService.chunk(document: StructuredDocument): Promise<ChunkingResult>` — consumed by Task 10.

- [ ] **Step 1: Write the failing tests**

````typescript
// src/chunking/chunking-pipeline.service.spec.ts
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StructuredDocument } from '../ingestion/ingestion.types';
import { ChunkAssemblerService } from './chunk-assembler.service';
import { ChunkingConfigService } from './chunking-config.service';
import { ChunkingPipelineService } from './chunking-pipeline.service';
import { ApproxTokenLengthMeasurer } from './length-measurer';
import { MarkdownSectionParserService } from './markdown-section-parser.service';
import { SectionSizeBounderService } from './section-size-bounder.service';

function buildLogger(): {
  setContext: jest.Mock;
  info: jest.Mock;
  warn: jest.Mock;
} {
  return { setContext: jest.fn(), info: jest.fn(), warn: jest.fn() };
}

function buildDocument(bodyText: string): StructuredDocument {
  return {
    documentId: 'doc1',
    metadata: {
      title: 'Test Doc',
      sourcePath: 'test.md',
      contentHash: 'abc',
      wordCount: 10,
      language: 'en',
      headingOutline: [],
      frontMatter: {},
      extractedAt: new Date(0).toISOString(),
    },
    headings: [],
    bodyText,
    codeBlocks: [],
  };
}

describe('ChunkingPipelineService', () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'chunking-pipeline-test-'));
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  function buildService(
    config: {
      maxChunkSize?: number;
      minChunkSize?: number;
      includeParentChunks?: boolean;
      overlapStrategy?: 'none' | 'heading-context' | 'sentence-overlap';
      overlapSentences?: number;
    } = {},
  ): ChunkingPipelineService {
    const chunkingConfig = {
      maxChunkSize: config.maxChunkSize ?? 500,
      minChunkSize: config.minChunkSize ?? 100,
      lengthStrategy: 'approx-token' as const,
      includeParentChunks: config.includeParentChunks ?? true,
      overlapStrategy: config.overlapStrategy ?? 'heading-context',
      overlapSentences: config.overlapSentences ?? 1,
      outputDir,
    } as ChunkingConfigService;

    const measurer = new ApproxTokenLengthMeasurer();
    const parser = new MarkdownSectionParserService(
      measurer,
      buildLogger() as never,
    );
    const bounder = new SectionSizeBounderService(
      measurer,
      buildLogger() as never,
    );
    const assembler = new ChunkAssemblerService(
      chunkingConfig,
      buildLogger() as never,
    );

    return new ChunkingPipelineService(
      parser,
      bounder,
      assembler,
      chunkingConfig,
      buildLogger() as never,
    );
  }

  it('produces a non-empty ChunkingResult for a realistic document', async () => {
    const service = buildService();
    const doc = buildDocument(
      '# Title\n\nIntro.\n\n## Section\n\nBody text here.',
    );

    const result = await service.chunk(doc);

    expect(result.documentId).toBe('doc1');
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.totalSections).toBeGreaterThan(0);
  });

  it('handles an empty document without throwing, returning zero chunks', async () => {
    const service = buildService();
    const doc = buildDocument('   ');

    const result = await service.chunk(doc);

    expect(result.chunks).toEqual([]);
  });

  it('is deterministic across two runs on the same input, excluding chunkedAt', async () => {
    const service = buildService();
    const doc = buildDocument(
      '# Title\n\n## A\n\nBody A.\n\n## B\n\nBody B.\n\n```bash\ndocker ps\n```',
    );

    const first = await service.chunk(doc);
    const second = await service.chunk(doc);

    const strip = (chunks: typeof first.chunks) =>
      chunks.map((c) => ({
        ...c,
        metadata: { ...c.metadata, chunkedAt: undefined },
      }));

    expect(strip(first.chunks)).toEqual(strip(second.chunks));
  });

  it('writes one {documentId}.chunks.json file to the configured output directory', async () => {
    const service = buildService();
    const doc = buildDocument('# Title\n\nSome text.');

    await service.chunk(doc);

    const files = await readdir(outputDir);
    expect(files).toContain('doc1.chunks.json');
  });
});
````

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- chunking-pipeline.service.spec.ts`
Expected: FAIL with "Cannot find module './chunking-pipeline.service'"

- [ ] **Step 3: Implement `ChunkingPipelineService`**

```typescript
// src/chunking/chunking-pipeline.service.ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { StructuredDocument } from '../ingestion/ingestion.types';
import { ChunkAssemblerService } from './chunk-assembler.service';
import { ChunkingConfigService } from './chunking-config.service';
import { EmptyDocumentError } from './chunking.errors';
import { ChunkingResult } from './chunking.types';
import { MarkdownSectionParserService } from './markdown-section-parser.service';
import { SectionSizeBounderService } from './section-size-bounder.service';

@Injectable()
export class ChunkingPipelineService {
  constructor(
    private readonly sectionParser: MarkdownSectionParserService,
    private readonly sizeBounder: SectionSizeBounderService,
    private readonly assembler: ChunkAssemblerService,
    private readonly config: ChunkingConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ChunkingPipelineService.name);
  }

  async chunk(document: StructuredDocument): Promise<ChunkingResult> {
    const startedAt = Date.now();

    if (document.bodyText.trim().length === 0) {
      const emptyError = new EmptyDocumentError(document.documentId);
      this.logger.warn({ documentId: document.documentId }, emptyError.message);
      return {
        documentId: document.documentId,
        chunks: [],
        totalSections: 0,
        splitSections: 0,
        mergedSections: 0,
        durationMs: Date.now() - startedAt,
      };
    }

    const root = this.sectionParser.parse(document.bodyText);
    const pieces = this.sizeBounder.bound(root, {
      maxChunkSize: this.config.maxChunkSize,
      minChunkSize: this.config.minChunkSize,
    });
    const chunks = this.assembler.assemble(
      pieces,
      root,
      document.documentId,
      document.metadata.sourcePath,
      document.metadata.title,
    );

    await mkdir(this.config.outputDir, { recursive: true });
    await writeFile(
      join(this.config.outputDir, `${document.documentId}.chunks.json`),
      JSON.stringify(chunks, null, 2),
      'utf-8',
    );

    const totalSections = this.countSections(root);
    const splitSections = pieces.filter((p) => p.wasSplit).length;
    const mergedSections = pieces.filter((p) => p.wasMerged).length;

    const result: ChunkingResult = {
      documentId: document.documentId,
      chunks,
      totalSections,
      splitSections,
      mergedSections,
      durationMs: Date.now() - startedAt,
    };

    this.logger.info(
      {
        documentId: document.documentId,
        chunkCount: chunks.length,
        totalSections,
        splitSections,
        mergedSections,
      },
      'Chunking run completed',
    );

    return result;
  }

  private countSections(section: {
    children: { children: unknown[] }[];
  }): number {
    return section.children.reduce(
      (sum, child) => sum + 1 + this.countSections(child as never),
      0,
    );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- chunking-pipeline.service.spec.ts`
Expected: PASS (4/4). If `countSections`'s loosely-typed recursive helper trips `@typescript-eslint/no-unsafe-*` rules in Step 6's lint pass, replace its parameter type with the real `Section` type imported from `./chunking.types` (it was written generically here only to avoid an import-order note; there is no actual reason not to use `Section` directly) — do this now rather than deferring to Task 10.

- [ ] **Step 5: Create `ChunkingModule`**

```typescript
// src/chunking/chunking.module.ts
import { Module } from '@nestjs/common';
import { ChunkAssemblerService } from './chunk-assembler.service';
import { ChunkingConfigService } from './chunking-config.service';
import { ChunkingPipelineService } from './chunking-pipeline.service';
import { LENGTH_MEASURER_PORT, createLengthMeasurer } from './length-measurer';
import { MarkdownSectionParserService } from './markdown-section-parser.service';
import { SectionSizeBounderService } from './section-size-bounder.service';

@Module({
  providers: [
    ChunkingConfigService,
    {
      provide: LENGTH_MEASURER_PORT,
      useFactory: (config: ChunkingConfigService) =>
        createLengthMeasurer(config.lengthStrategy),
      inject: [ChunkingConfigService],
    },
    MarkdownSectionParserService,
    SectionSizeBounderService,
    ChunkAssemblerService,
    ChunkingPipelineService,
  ],
  exports: [ChunkingPipelineService],
})
export class ChunkingModule {}
```

- [ ] **Step 6: Wire `ChunkingModule` into `AppModule`**

Modify `src/app.module.ts` — add the import:

```typescript
import { ChunkingModule } from './chunking/chunking.module';
```

And add `ChunkingModule` to the `imports` array, after `IngestionModule`:

```typescript
    HealthModule,
    IngestionModule,
    ChunkingModule,
  ],
```

- [ ] **Step 7: Run the full unit suite, lint, and build to confirm wiring compiles**

Run: `pnpm lint && pnpm test && pnpm build`
Expected: all existing + new unit tests PASS; lint clean; build succeeds with no TypeScript errors. Fix any real compile/lint issues surfaced here now (per this plan's Global Constraints note on empirically verifying `markdown-it` token shapes) rather than deferring to Task 10.

- [ ] **Step 8: Commit**

```bash
git add src/chunking/chunking-pipeline.service.ts src/chunking/chunking-pipeline.service.spec.ts src/chunking/chunking.module.ts src/app.module.ts
git commit -m "feat(chunking): add ChunkingPipelineService and wire ChunkingModule into AppModule"
```

---

### Task 10: Integration test with a real fixture, final verification, and report

**Files:**

- Create: `test/fixtures/chunking/docker-install-guide.json`
- Create: `test/chunking.e2e-spec.ts`

**Interfaces:**

- Consumes: `ChunkingModule` (Task 9), `ChunkingPipelineService.chunk` (Task 9).

- [ ] **Step 1: Create the fixture `StructuredDocument`**

This is a hand-authored `StructuredDocument` JSON fixture (chunking's input is `StructuredDocument`, not a ZIP — no archive-building step is needed here, unlike the ingestion module's fixture). It exercises every `ContentBlockType`: a heading hierarchy, prose, a code fence, a table, a list, and a note.

````json
{
  "documentId": "fixture-doc-1",
  "metadata": {
    "title": "Install Docker Engine",
    "sourcePath": "install-docker-engine.md",
    "contentHash": "fixture-hash",
    "wordCount": 120,
    "language": "en",
    "headingOutline": [],
    "frontMatter": { "title": "Install Docker Engine" },
    "extractedAt": "2026-01-01T00:00:00.000Z"
  },
  "headings": [],
  "codeBlocks": [],
  "bodyText": "# Install Docker Engine\n\nThis guide explains how to install Docker Engine.\n\n> **Note:** Docker Engine requires a 64-bit kernel.\n\n## Prerequisites\n\nBefore installing, review the supported platforms.\n\n| Platform | Supported |\n| --- | --- |\n| Ubuntu | Yes |\n| Debian | Yes |\n| CentOS | No |\n\n## Install using the convenience script\n\nRun the following commands:\n\n```bash\ncurl -fsSL https://get.docker.com -o get-docker.sh\nsudo sh get-docker.sh\n```\n\n## Post-installation steps\n\nComplete these steps after installing:\n\n- Create the docker group\n- Add your user to the group\n- Log out and back in\n\n## See also\n\nSee the release notes for details."
}
````

- [ ] **Step 2: Write the integration test**

````typescript
// test/chunking.e2e-spec.ts
import { readFile } from 'node:fs/promises';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from '../src/config/env.validation';
import { ChunkingModule } from '../src/chunking/chunking.module';
import { ChunkingPipelineService } from '../src/chunking/chunking-pipeline.service';
import { Chunk } from '../src/chunking/chunking.types';
import { StructuredDocument } from '../src/ingestion/ingestion.types';

describe('Chunking (e2e)', () => {
  let outputDir: string;
  const previousOutputDir = process.env['CHUNKING_OUTPUT_DIR'];

  beforeAll(async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'chunking-e2e-'));
    process.env['CHUNKING_OUTPUT_DIR'] = outputDir;
  });

  afterAll(async () => {
    if (previousOutputDir === undefined) {
      delete process.env['CHUNKING_OUTPUT_DIR'];
    } else {
      process.env['CHUNKING_OUTPUT_DIR'] = previousOutputDir;
    }
    await rm(outputDir, { recursive: true, force: true });
  });

  it('chunks a real fixture document end-to-end with no truncated code fences or table rows', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          validate: validateEnv,
          cache: false,
        }),
        LoggerModule.forRoot(),
        ChunkingModule,
      ],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init();

    const pipeline = app.get(ChunkingPipelineService);
    const fixtureRaw = await readFile(
      join(__dirname, 'fixtures', 'chunking', 'docker-install-guide.json'),
      'utf-8',
    );
    const document = JSON.parse(fixtureRaw) as StructuredDocument;

    const result = await pipeline.chunk(document);

    expect(result.chunks.length).toBeGreaterThan(0);

    for (const chunk of result.chunks) {
      const fenceMarkers = (chunk.text.match(/```/g) ?? []).length;
      expect(fenceMarkers % 2).toBe(0);
    }

    const codeChunk = result.chunks.find((c) =>
      c.text.includes('get-docker.sh'),
    );
    expect(codeChunk?.text).toContain('curl -fsSL https://get.docker.com');
    expect(codeChunk?.text).toContain('sudo sh get-docker.sh');

    const nonRootChunks = result.chunks.filter(
      (c: Chunk) => c.metadata.chunkType === 'child',
    );
    expect(nonRootChunks.every((c) => c.metadata.headingPath.length > 0)).toBe(
      true,
    );

    const tableChunk = result.chunks.find((c) => c.text.includes('| Ubuntu |'));
    expect(tableChunk?.text).toContain('| Platform | Supported |');

    const outputFiles = await readdir(outputDir);
    expect(outputFiles).toContain('fixture-doc-1.chunks.json');

    await app.close();
  });
});
````

- [ ] **Step 3: Run the integration test**

Run: `pnpm test:e2e -- chunking.e2e-spec.ts`
Expected: PASS (1/1)

- [ ] **Step 4: Run full verification suite**

```bash
pnpm lint
pnpm test
pnpm test:e2e
pnpm build
```

Expected: all four succeed with zero errors and zero warnings. If `env-example.spec.ts` fails, this means the manual `.env.example` edit from Task 3 has not been applied yet — expected until the user does that edit; not a code defect.

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/chunking test/chunking.e2e-spec.ts
git commit -m "test(chunking): add end-to-end integration test with a real StructuredDocument fixture"
```

- [ ] **Step 6: Write the implementation report**

Summarize in the final chat response (not a new file): which services were built and what each does, unit + integration test counts, lint/build/test results, the seven new env vars, and the one outstanding manual step (`.env.example` edit) with its exact content.

---

## Self-Review

**Spec coverage** — every item from the design doc's §15 roadmap and the ten "Design:" items requested in the original brief maps to a task: domain model (Task 1), length measurement (Task 2), configuration (Task 3), content classification (Task 4), section-aware parsing (Task 5), size bounding / code / table / list handling / merge strategy (Task 6), chunk IDs (Task 7), parent-child relationships / overlap strategy (Task 8), orchestration + module wiring (Task 9), integration testing + Definition of Done verification (Task 10).

**Placeholder scan** — no "TBD"/"handle edge cases" placeholders; the two spots flagged for empirical verification during execution (markdown-it's exact `tr_open` token shape in Task 5; the `Map`-by-reference simplification note in Task 8) are explicit, actionable fallback instructions, not open-ended placeholders — this mirrors the ingestion plan's own precedent of flagging one real library-API uncertainty (`yauzl`'s promise API) rather than guessing silently.

**Type consistency** — verified `ResolvedPiece`, `Section`, `ContentBlock`, `Chunk`, `ChunkMetadata`, `ChunkRelationships`, `ChunkingResult`, `HeadingPathSegment` are defined once in Task 1 and referenced with identical field names throughout Tasks 5–9 (e.g., `wasSplit`/`wasMerged`/`mergedHeadings`/`exceedsMaxSize` appear with the same names and types in `ResolvedPiece` (Task 1), `SectionSizeBounderService` (Task 6), and `ChunkMetadata` (Task 8)); `LENGTH_MEASURER_PORT` and `LengthMeasurerPort` are defined once in Task 2 and consumed identically in Tasks 5, 6, and 9's `ChunkingModule` factory binding.

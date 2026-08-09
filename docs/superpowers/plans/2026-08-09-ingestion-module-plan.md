# Ingestion Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a concrete, dedicated `IngestionModule` implementing the ZIP→Extract→Clean→Parse→Metadata→Structured-Documents(JSON) pipeline from `docs/architecture/document-ingestion-subsystem-design.md`, as five focused services (`ZipExtractorService`, `DocumentCleanerService`, `MarkdownParserService`, `MetadataGeneratorService`, `IngestionPipelineService`), wired into the existing NestJS app.

**Architecture:** Flat `src/ingestion/` feature folder (matches this project's current flat layout, not the design doc's aspirational `libs/` monorepo paths). Concrete services replace the design doc's port/strategy abstraction layer — justified because this MVP supports exactly one archive format (ZIP) and one document format (Markdown), so an abstraction layer has no second implementation to justify it yet. No BullMQ, no database persistence, no `KnowledgeDomain`/multi-domain concept — none of that exists in this codebase yet; the pipeline's terminal output is `StructuredDocument` JSON files on disk, matching the original request's literal pipeline terminus "(JSON)".

**Tech Stack:** `yauzl` (streaming ZIP reads via its promise API), `markdown-it` (CommonJS-compatible Markdown tokenizer — replaces the design doc's `unified`/`remark-parse`, which is ESM-only and incompatible with this project's CommonJS compilation), `gray-matter` (front-matter extraction), Node's built-in `crypto` (SHA-256 content hashing) and `fs/promises`.

## Global Constraints

- TypeScript strict mode is already enabled project-wide (`strict`, `exactOptionalPropertyTypes`, `noImplicitReturns`, `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`) — all new code must compile under it.
- ESLint config (`eslint.config.mjs`) sets `@typescript-eslint/no-explicit-any: error`, `@typescript-eslint/no-floating-promises: error`, `@typescript-eslint/no-unsafe-argument: error`, plus `tseslint.configs.recommendedTypeChecked` — no `any`, no unhandled promises, no unsafe `any`-flavored operations.
- Jest coverage threshold is 80% branches/functions/lines/statements globally (`package.json` `jest.coverageThreshold`) — every new service needs unit tests covering its branches, not just its happy path.
- Structured logging convention: inject `PinoLogger` from `nestjs-pino`, call `this.logger.setContext(ClassName.name)` in the constructor, then `this.logger.info(obj, msg)` / `.warn(obj, msg)` — see `src/common/filters/global-exception.filter.ts:22-24` for the established pattern.
- Config convention: all environment variables are validated by the single zod schema in `src/config/env.validation.ts`, wrapped by a dedicated `*ConfigService` exposing typed getters (see `src/config/app-config.service.ts`) — never read `process.env` directly in application code.
- `.env.example` **cannot be edited by the assistant in this session** — the user's global `~/.claude/settings.json` denies `Read`/`Write`/`Edit` on any `.env*` path. Task 3 documents the exact lines the user must add by hand; until that happens, `src/config/env-example.spec.ts`'s drift-guard test will fail. This is flagged again at the end of Task 3 and in the final report — it is not something a code change can work around.
- Commit after each task, following this repo's Conventional Commits history (`feat:`, `test:`, `docs:`, etc.).

---

### Task 1: Ingestion DTOs and error taxonomy

**Files:**

- Create: `src/ingestion/ingestion.types.ts`
- Create: `src/ingestion/ingestion.errors.ts`
- Test: `src/ingestion/ingestion.errors.spec.ts`

**Interfaces:**

- Produces: `RawFile`, `CleanedFile`, `HeadingNode`, `CodeBlock`, `ParsedDocument`, `DocumentMetadata`, `StructuredDocument`, `IngestionFailure`, `IngestionResult`, `ExtractionResult` (all plain interfaces, no methods); `ArchiveCorruptError`, `ArchiveSizeLimitExceededError`, `ArchiveEntryPathTraversalError`, `IngestionThresholdExceededError` (all extend `Error`).

- [ ] **Step 1: Create the DTO file**

```typescript
// src/ingestion/ingestion.types.ts

export interface RawFile {
  sourcePath: string;
  content: Buffer;
  uncompressedSize: number;
  compressedSize: number;
  lastModified: Date;
}

export interface ExtractionResult {
  files: RawFile[];
  totalEntries: number;
}

export interface CleanedFile {
  sourcePath: string;
  text: string;
  frontMatter: Record<string, unknown>;
}

export interface HeadingNode {
  level: number;
  text: string;
  anchor: string;
  children: HeadingNode[];
}

export interface CodeBlock {
  language: string | null;
  content: string;
  position: number;
}

export interface ParsedDocument {
  sourcePath: string;
  title: string;
  headings: HeadingNode[];
  bodyText: string;
  codeBlocks: CodeBlock[];
  links: string[];
}

export interface DocumentMetadata {
  title: string;
  sourcePath: string;
  contentHash: string;
  wordCount: number;
  language: string;
  headingOutline: HeadingNode[];
  frontMatter: Record<string, unknown>;
  extractedAt: string;
}

export interface StructuredDocument {
  documentId: string;
  metadata: DocumentMetadata;
  headings: HeadingNode[];
  bodyText: string;
  codeBlocks: CodeBlock[];
}

export interface IngestionFailure {
  sourcePath: string;
  message: string;
}

export interface IngestionResult {
  totalEntries: number;
  matchedEntries: number;
  succeeded: number;
  failed: number;
  failures: IngestionFailure[];
  outputDir: string;
  durationMs: number;
}
```

- [ ] **Step 2: Create the error taxonomy**

```typescript
// src/ingestion/ingestion.errors.ts

export class ArchiveCorruptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ArchiveCorruptError';
  }
}

export class ArchiveSizeLimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveSizeLimitExceededError';
  }
}

export class ArchiveEntryPathTraversalError extends Error {
  constructor(public readonly entryName: string) {
    super(`Archive entry resolves outside the extraction root: ${entryName}`);
    this.name = 'ArchiveEntryPathTraversalError';
  }
}

export class IngestionThresholdExceededError extends Error {
  constructor(
    public readonly failedCount: number,
    public readonly matchedCount: number,
  ) {
    super(
      `Ingestion aborted: ${failedCount}/${matchedCount} files failed, exceeding the 50% failure threshold`,
    );
    this.name = 'IngestionThresholdExceededError';
  }
}
```

- [ ] **Step 3: Write the failing test for the error taxonomy**

```typescript
// src/ingestion/ingestion.errors.spec.ts
import {
  ArchiveCorruptError,
  ArchiveEntryPathTraversalError,
  ArchiveSizeLimitExceededError,
  IngestionThresholdExceededError,
} from './ingestion.errors';

describe('ingestion errors', () => {
  it('ArchiveCorruptError carries name, message, and cause', () => {
    const cause = new Error('zlib failure');
    const err = new ArchiveCorruptError('bad zip', { cause });

    expect(err.name).toBe('ArchiveCorruptError');
    expect(err.message).toBe('bad zip');
    expect(err.cause).toBe(cause);
    expect(err).toBeInstanceOf(Error);
  });

  it('ArchiveSizeLimitExceededError carries name and message', () => {
    const err = new ArchiveSizeLimitExceededError('too big');

    expect(err.name).toBe('ArchiveSizeLimitExceededError');
    expect(err.message).toBe('too big');
  });

  it('ArchiveEntryPathTraversalError formats the entry name into its message', () => {
    const err = new ArchiveEntryPathTraversalError('../../etc/passwd');

    expect(err.name).toBe('ArchiveEntryPathTraversalError');
    expect(err.entryName).toBe('../../etc/passwd');
    expect(err.message).toContain('../../etc/passwd');
  });

  it('IngestionThresholdExceededError reports failed/matched counts in its message', () => {
    const err = new IngestionThresholdExceededError(6, 10);

    expect(err.name).toBe('IngestionThresholdExceededError');
    expect(err.failedCount).toBe(6);
    expect(err.matchedCount).toBe(10);
    expect(err.message).toBe(
      'Ingestion aborted: 6/10 files failed, exceeding the 50% failure threshold',
    );
  });
});
```

- [ ] **Step 4: Run the test**

Run: `pnpm test -- ingestion.errors.spec.ts`
Expected: PASS (this task has no prior implementation to be RED against — the classes are written in Step 2 before the test runs)

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/ingestion.types.ts src/ingestion/ingestion.errors.ts src/ingestion/ingestion.errors.spec.ts
git commit -m "feat(ingestion): add ingestion DTOs and error taxonomy"
```

---

### Task 2: Pure utilities — zip-slip path safety and glob matching

**Files:**

- Create: `src/ingestion/zip-path-safety.ts`
- Test: `src/ingestion/zip-path-safety.spec.ts`
- Create: `src/ingestion/glob-match.util.ts`
- Test: `src/ingestion/glob-match.util.spec.ts`

**Interfaces:**

- Consumes: `ArchiveEntryPathTraversalError` from `./ingestion.errors` (Task 1).
- Produces: `assertSafeEntryName(entryName: string): void` (throws on traversal, returns void otherwise); `matchesGlob(path: string, pattern: string): boolean`.

- [ ] **Step 1: Write the failing test for path safety**

```typescript
// src/ingestion/zip-path-safety.spec.ts
import { ArchiveEntryPathTraversalError } from './ingestion.errors';
import { assertSafeEntryName } from './zip-path-safety';

describe('assertSafeEntryName', () => {
  it('allows a normal relative entry name', () => {
    expect(() => assertSafeEntryName('docs/intro.md')).not.toThrow();
  });

  it('allows a top-level file', () => {
    expect(() => assertSafeEntryName('readme.md')).not.toThrow();
  });

  it('rejects an entry that escapes the root via ../', () => {
    expect(() => assertSafeEntryName('../outside.md')).toThrow(
      ArchiveEntryPathTraversalError,
    );
  });

  it('rejects an entry that escapes the root via a nested ../..', () => {
    expect(() => assertSafeEntryName('a/../../outside.md')).toThrow(
      ArchiveEntryPathTraversalError,
    );
  });

  it('rejects an absolute path entry', () => {
    expect(() => assertSafeEntryName('/etc/passwd')).toThrow(
      ArchiveEntryPathTraversalError,
    );
  });

  it('rejects a backslash-based traversal attempt', () => {
    expect(() => assertSafeEntryName('..\\..\\outside.md')).toThrow(
      ArchiveEntryPathTraversalError,
    );
  });

  it('rejects an entry name containing a null byte', () => {
    expect(() => assertSafeEntryName('docs/intro.md\0.png')).toThrow(
      ArchiveEntryPathTraversalError,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- zip-path-safety.spec.ts`
Expected: FAIL with "Cannot find module './zip-path-safety'"

- [ ] **Step 3: Implement the path-safety validator**

```typescript
// src/ingestion/zip-path-safety.ts
import { resolve, sep } from 'node:path';
import { ArchiveEntryPathTraversalError } from './ingestion.errors';

const VIRTUAL_EXTRACTION_ROOT = resolve('/__ingestion_extraction_root__');

export function assertSafeEntryName(entryName: string): void {
  const normalized = entryName.replace(/\\/g, '/');

  if (normalized.startsWith('/') || normalized.includes('\0')) {
    throw new ArchiveEntryPathTraversalError(entryName);
  }

  const resolved = resolve(VIRTUAL_EXTRACTION_ROOT, normalized);
  const isWithinRoot =
    resolved === VIRTUAL_EXTRACTION_ROOT ||
    resolved.startsWith(VIRTUAL_EXTRACTION_ROOT + sep);

  if (!isWithinRoot) {
    throw new ArchiveEntryPathTraversalError(entryName);
  }
}
```

This validates purely against path strings (resolved against a fixed virtual root), with no real filesystem extraction directory — consistent with the in-memory buffering decision (Task 4).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- zip-path-safety.spec.ts`
Expected: PASS (7/7)

- [ ] **Step 5: Write the failing test for glob matching**

```typescript
// src/ingestion/glob-match.util.spec.ts
import { matchesGlob } from './glob-match.util';

describe('matchesGlob', () => {
  it('matches a nested file against **/*.md', () => {
    expect(matchesGlob('docs/guide/intro.md', '**/*.md')).toBe(true);
  });

  it('matches a top-level file against **/*.md', () => {
    expect(matchesGlob('readme.md', '**/*.md')).toBe(true);
  });

  it('does not match a non-matching extension', () => {
    expect(matchesGlob('docs/intro.txt', '**/*.md')).toBe(false);
  });

  it('matches a single-segment wildcard within one directory level', () => {
    expect(matchesGlob('docs/intro.md', 'docs/*.md')).toBe(true);
  });

  it('does not let a single-segment wildcard cross directories', () => {
    expect(matchesGlob('docs/guide/intro.md', 'docs/*.md')).toBe(false);
  });

  it('matches an exact literal pattern', () => {
    expect(matchesGlob('readme.md', 'readme.md')).toBe(true);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm test -- glob-match.util.spec.ts`
Expected: FAIL with "Cannot find module './glob-match.util'"

- [ ] **Step 7: Implement the glob matcher**

```typescript
// src/ingestion/glob-match.util.ts

const REGEX_SPECIAL_CHARS = new Set([
  '.',
  '+',
  '^',
  '$',
  '{',
  '}',
  '(',
  ')',
  '|',
  '[',
  ']',
  '\\',
]);

export function matchesGlob(path: string, pattern: string): boolean {
  return globToRegExp(pattern).test(path);
}

function globToRegExp(pattern: string): RegExp {
  let result = '';
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === '*' && pattern[i + 1] === '*') {
      result += '.*';
      i += 2;
      if (pattern[i] === '/') {
        i += 1;
      }
      continue;
    }

    if (char === '*') {
      result += '[^/]*';
      i += 1;
      continue;
    }

    if (char === '?') {
      result += '[^/]';
      i += 1;
      continue;
    }

    if (char !== undefined && REGEX_SPECIAL_CHARS.has(char)) {
      result += `\\${char}`;
      i += 1;
      continue;
    }

    result += char;
    i += 1;
  }

  return new RegExp(`^${result}$`);
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm test -- glob-match.util.spec.ts`
Expected: PASS (6/6)

- [ ] **Step 9: Commit**

```bash
git add src/ingestion/zip-path-safety.ts src/ingestion/zip-path-safety.spec.ts src/ingestion/glob-match.util.ts src/ingestion/glob-match.util.spec.ts
git commit -m "feat(ingestion): add zip-slip path safety and glob matching utilities"
```

---

### Task 3: `IngestionConfigService` and env schema extension

**Files:**

- Modify: `src/config/env.validation.ts`
- Create: `src/ingestion/ingestion-config.service.ts`
- Test: `src/ingestion/ingestion-config.service.spec.ts`
- Modify: `README.md` (environment variables table)

**Interfaces:**

- Consumes: `ConfigService<EnvConfig, true>` from `@nestjs/config`.
- Produces: `IngestionConfigService` with getters `outputDir: string`, `maxEntryCount: number`, `maxUncompressedBytes: number`, `includeGlob: string`, `defaultLanguage: string` — consumed by Tasks 4, 6, 7, 8.

- [ ] **Step 1: Extend the env schema**

Modify `src/config/env.validation.ts` — add these five keys inside `envSchema`'s `z.object({...})`, after the existing `LOG_LEVEL` field:

```typescript
  INGESTION_OUTPUT_DIR: z.string().min(1).default('./data/ingestion-output'),
  INGESTION_MAX_ENTRY_COUNT: z.coerce.number().int().positive().default(10000),
  INGESTION_MAX_UNCOMPRESSED_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(524288000),
  INGESTION_INCLUDE_GLOB: z.string().min(1).default('**/*.md'),
  INGESTION_DEFAULT_LANGUAGE: z.string().min(1).default('en'),
```

The full file after this edit:

```typescript
import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  INGESTION_OUTPUT_DIR: z.string().min(1).default('./data/ingestion-output'),
  INGESTION_MAX_ENTRY_COUNT: z.coerce.number().int().positive().default(10000),
  INGESTION_MAX_UNCOMPRESSED_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(524288000),
  INGESTION_INCLUDE_GLOB: z.string().min(1).default('**/*.md'),
  INGESTION_DEFAULT_LANGUAGE: z.string().min(1).default('en'),
});

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

**IMPORTANT — manual step required, cannot be automated in this session:** `.env.example` must gain matching lines, or `src/config/env-example.spec.ts`'s drift-guard test (`.env.example` declares exactly the same keys as the env schema) will fail. The assistant's tooling is denied `Read`/`Write`/`Edit` access to any `.env*` path by the user's global Claude Code settings (`~/.claude/settings.json`), so this file must be edited by hand. Add these five lines to `.env.example` (comment style matching whatever convention the existing three lines use):

```
INGESTION_OUTPUT_DIR=./data/ingestion-output
INGESTION_MAX_ENTRY_COUNT=10000
INGESTION_MAX_UNCOMPRESSED_BYTES=524288000
INGESTION_INCLUDE_GLOB=**/*.md
INGESTION_DEFAULT_LANGUAGE=en
```

- [ ] **Step 2: Update the README environment variable table**

Modify `README.md`'s environment variables table (currently lines 19-23) to add five rows after the `LOG_LEVEL` row:

```markdown
| `INGESTION_OUTPUT_DIR` | `./data/ingestion-output` | Directory where ingested `StructuredDocument` JSON files are written. |
| `INGESTION_MAX_ENTRY_COUNT` | `10000` | Zip-bomb guard: max number of entries an archive may declare before extraction is refused. |
| `INGESTION_MAX_UNCOMPRESSED_BYTES` | `524288000` | Zip-bomb guard: max total uncompressed bytes an archive may contain (default 500 MB). |
| `INGESTION_INCLUDE_GLOB` | `**/*.md` | Glob pattern selecting which archive entries are treated as documents. |
| `INGESTION_DEFAULT_LANGUAGE` | `en` | Fallback `language` metadata value when a document's front matter doesn't specify one. |
```

- [ ] **Step 3: Write the failing test for `IngestionConfigService`**

```typescript
// src/ingestion/ingestion-config.service.spec.ts
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from '../config/env.validation';
import { IngestionConfigService } from './ingestion-config.service';

describe('IngestionConfigService', () => {
  function build(overrides: Partial<EnvConfig> = {}): IngestionConfigService {
    const values: EnvConfig = {
      NODE_ENV: 'test',
      PORT: 3000,
      LOG_LEVEL: 'info',
      INGESTION_OUTPUT_DIR: './data/ingestion-output',
      INGESTION_MAX_ENTRY_COUNT: 10000,
      INGESTION_MAX_UNCOMPRESSED_BYTES: 524288000,
      INGESTION_INCLUDE_GLOB: '**/*.md',
      INGESTION_DEFAULT_LANGUAGE: 'en',
      ...overrides,
    };
    const configService = {
      get: (key: keyof EnvConfig) => values[key],
    } as ConfigService<EnvConfig, true>;
    return new IngestionConfigService(configService);
  }

  it('exposes outputDir from config', () => {
    expect(build({ INGESTION_OUTPUT_DIR: '/tmp/out' }).outputDir).toBe(
      '/tmp/out',
    );
  });

  it('exposes maxEntryCount from config', () => {
    expect(build({ INGESTION_MAX_ENTRY_COUNT: 500 }).maxEntryCount).toBe(500);
  });

  it('exposes maxUncompressedBytes from config', () => {
    expect(
      build({ INGESTION_MAX_UNCOMPRESSED_BYTES: 1024 }).maxUncompressedBytes,
    ).toBe(1024);
  });

  it('exposes includeGlob from config', () => {
    expect(build({ INGESTION_INCLUDE_GLOB: '**/*.mdx' }).includeGlob).toBe(
      '**/*.mdx',
    );
  });

  it('exposes defaultLanguage from config', () => {
    expect(build({ INGESTION_DEFAULT_LANGUAGE: 'fr' }).defaultLanguage).toBe(
      'fr',
    );
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm test -- ingestion-config.service.spec.ts`
Expected: FAIL with "Cannot find module './ingestion-config.service'"

- [ ] **Step 5: Implement `IngestionConfigService`**

```typescript
// src/ingestion/ingestion-config.service.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from '../config/env.validation';

@Injectable()
export class IngestionConfigService {
  constructor(private readonly configService: ConfigService<EnvConfig, true>) {}

  get outputDir(): string {
    return this.configService.get('INGESTION_OUTPUT_DIR', { infer: true });
  }

  get maxEntryCount(): number {
    return this.configService.get('INGESTION_MAX_ENTRY_COUNT', {
      infer: true,
    });
  }

  get maxUncompressedBytes(): number {
    return this.configService.get('INGESTION_MAX_UNCOMPRESSED_BYTES', {
      infer: true,
    });
  }

  get includeGlob(): string {
    return this.configService.get('INGESTION_INCLUDE_GLOB', { infer: true });
  }

  get defaultLanguage(): string {
    return this.configService.get('INGESTION_DEFAULT_LANGUAGE', {
      infer: true,
    });
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test -- ingestion-config.service.spec.ts`
Expected: PASS (5/5)

- [ ] **Step 7: Commit**

```bash
git add src/config/env.validation.ts src/ingestion/ingestion-config.service.ts src/ingestion/ingestion-config.service.spec.ts README.md
git commit -m "feat(ingestion): add IngestionConfigService and extend env schema"
```

Note in the commit body or a follow-up message to the user: `.env.example` still needs the five lines from Step 1 added by hand before `pnpm test` will pass end-to-end (the `env-example.spec.ts` drift-guard will fail until then).

---

### Task 4: `ZipExtractorService`

**Files:**

- Create: `src/ingestion/zip-extractor.service.ts`
- Test: `src/ingestion/zip-extractor.service.spec.ts`
- Modify: `package.json` (add `yauzl` dependency, `@types/yauzl` dev dependency)

**Interfaces:**

- Consumes: `IngestionConfigService` (Task 3), `assertSafeEntryName`/`matchesGlob` (Task 2), `ArchiveCorruptError`/`ArchiveSizeLimitExceededError` (Task 1), `PinoLogger` from `nestjs-pino`.
- Produces: `ZipExtractorService.extract(buffer: Buffer): Promise<ExtractionResult>` — consumed by Task 8.

- [ ] **Step 1: Install dependencies**

```bash
pnpm add yauzl
pnpm add -D @types/yauzl
```

- [ ] **Step 2: Write the failing tests**

```typescript
// src/ingestion/zip-extractor.service.spec.ts
import { ZipFile } from 'yauzl';
import {
  ArchiveCorruptError,
  ArchiveSizeLimitExceededError,
} from './ingestion.errors';
import { ArchiveEntryPathTraversalError } from './ingestion.errors';
import { IngestionConfigService } from './ingestion-config.service';
import { ZipExtractorService } from './zip-extractor.service';

function buildConfig(overrides: {
  maxEntryCount?: number;
  maxUncompressedBytes?: number;
  includeGlob?: string;
}): IngestionConfigService {
  return {
    maxEntryCount: overrides.maxEntryCount ?? 10000,
    maxUncompressedBytes: overrides.maxUncompressedBytes ?? 524288000,
    includeGlob: overrides.includeGlob ?? '**/*.md',
  } as IngestionConfigService;
}

function buildLogger(): {
  setContext: jest.Mock;
  info: jest.Mock;
  warn: jest.Mock;
} {
  return { setContext: jest.fn(), info: jest.fn(), warn: jest.fn() };
}

describe('ZipExtractorService', () => {
  it('extracts entries matching the include glob and skips others', async () => {
    const zip = new (await import('yazl')).ZipFile();
    // placeholder replaced in Step 3 below with a real fixture-building helper
  });
});
```

Building a real ZIP in-memory inside the test needs a ZIP _writer_, which this project does not depend on. Replace the sketch above with a self-contained test that builds fixtures using Node's `zlib` isn't practical for a full ZIP container either — instead, write the fixture ZIP once as bytes using the `zip` CLI (already confirmed available) into a `Buffer` at test-run time via a small helper that shells out, OR — simpler and dependency-free — construct the archive with `yazl` is not installed either. **Use this approach instead:** build the test fixture files on disk under a temp directory and zip them with the `zip` CLI via `child_process.execFileSync`, exactly like Task 9's e2e fixture, but scoped to a smaller in-test fixture. Use this full test file:

```typescript
// src/ingestion/zip-extractor.service.spec.ts
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ArchiveCorruptError,
  ArchiveSizeLimitExceededError,
} from './ingestion.errors';
import { IngestionConfigService } from './ingestion-config.service';
import { ZipExtractorService } from './zip-extractor.service';

function buildConfig(overrides: {
  maxEntryCount?: number;
  maxUncompressedBytes?: number;
  includeGlob?: string;
}): IngestionConfigService {
  return {
    maxEntryCount: overrides.maxEntryCount ?? 10000,
    maxUncompressedBytes: overrides.maxUncompressedBytes ?? 524288000,
    includeGlob: overrides.includeGlob ?? '**/*.md',
  } as IngestionConfigService;
}

function buildLogger(): {
  setContext: jest.Mock;
  info: jest.Mock;
  warn: jest.Mock;
} {
  return { setContext: jest.fn(), info: jest.fn(), warn: jest.fn() };
}

async function buildZipFixture(files: Record<string, string>): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'zip-extractor-test-'));
  const zipPath = join(dir, 'fixture.zip');

  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(dir, relativePath);
    await writeFile(fullPath, content, 'utf-8');
  }

  execFileSync('zip', ['-q', '-r', zipPath, ...Object.keys(files)], {
    cwd: dir,
  });

  const buffer = await readFile(zipPath);
  await rm(dir, { recursive: true, force: true });
  return buffer;
}

describe('ZipExtractorService', () => {
  it('extracts entries matching the include glob and skips non-matching ones', async () => {
    const buffer = await buildZipFixture({
      'intro.md': '# Intro',
      'notes.txt': 'not markdown',
    });
    const service = new ZipExtractorService(
      buildConfig({}),
      buildLogger() as never,
    );

    const result = await service.extract(buffer);

    expect(result.totalEntries).toBe(2);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.sourcePath).toBe('intro.md');
    expect(result.files[0]?.content.toString('utf-8')).toBe('# Intro');
  });

  it('rejects an archive declaring more entries than the configured limit', async () => {
    const buffer = await buildZipFixture({
      'a.md': 'a',
      'b.md': 'b',
      'c.md': 'c',
    });
    const service = new ZipExtractorService(
      buildConfig({ maxEntryCount: 2 }),
      buildLogger() as never,
    );

    await expect(service.extract(buffer)).rejects.toThrow(
      ArchiveSizeLimitExceededError,
    );
  });

  it('rejects an archive exceeding the configured uncompressed size limit', async () => {
    const buffer = await buildZipFixture({
      'big.md': 'x'.repeat(1000),
    });
    const service = new ZipExtractorService(
      buildConfig({ maxUncompressedBytes: 10 }),
      buildLogger() as never,
    );

    await expect(service.extract(buffer)).rejects.toThrow(
      ArchiveSizeLimitExceededError,
    );
  });

  it('rejects a buffer that is not a valid zip archive', async () => {
    const service = new ZipExtractorService(
      buildConfig({}),
      buildLogger() as never,
    );

    await expect(
      service.extract(Buffer.from('not a zip file')),
    ).rejects.toThrow(ArchiveCorruptError);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test -- zip-extractor.service.spec.ts`
Expected: FAIL with "Cannot find module './zip-extractor.service'"

- [ ] **Step 4: Implement `ZipExtractorService`**

```typescript
// src/ingestion/zip-extractor.service.ts
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { fromBuffer, type Entry, type ZipFile } from 'yauzl';
import { promisify } from 'node:util';
import { matchesGlob } from './glob-match.util';
import {
  ArchiveCorruptError,
  ArchiveSizeLimitExceededError,
} from './ingestion.errors';
import { IngestionConfigService } from './ingestion-config.service';
import { ExtractionResult, RawFile } from './ingestion.types';
import { assertSafeEntryName } from './zip-path-safety';

const openZipBuffer = promisify(fromBuffer) as (
  buffer: Buffer,
  options: { lazyEntries: boolean },
) => Promise<ZipFile>;

@Injectable()
export class ZipExtractorService {
  constructor(
    private readonly config: IngestionConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ZipExtractorService.name);
  }

  async extract(buffer: Buffer): Promise<ExtractionResult> {
    const zipfile = await this.openZip(buffer);

    if (zipfile.entryCount > this.config.maxEntryCount) {
      zipfile.close();
      throw new ArchiveSizeLimitExceededError(
        `Archive declares ${zipfile.entryCount} entries, exceeding the configured limit of ${this.config.maxEntryCount}`,
      );
    }

    const files: RawFile[] = [];
    let totalUncompressedBytes = 0;
    let totalEntries = 0;

    for await (const entry of zipfile) {
      totalEntries += 1;

      if (entry.fileName.endsWith('/')) {
        continue;
      }

      assertSafeEntryName(entry.fileName);

      totalUncompressedBytes += entry.uncompressedSize;
      if (totalUncompressedBytes > this.config.maxUncompressedBytes) {
        throw new ArchiveSizeLimitExceededError(
          `Archive uncompressed size exceeds the configured limit of ${this.config.maxUncompressedBytes} bytes`,
        );
      }

      if (!matchesGlob(entry.fileName, this.config.includeGlob)) {
        continue;
      }

      const content = await this.readEntryContent(zipfile, entry);

      files.push({
        sourcePath: entry.fileName,
        content,
        uncompressedSize: entry.uncompressedSize,
        compressedSize: entry.compressedSize,
        lastModified: entry.getLastModDate(),
      });
    }

    this.logger.info(
      { totalEntries, matchedEntries: files.length },
      'Archive extracted',
    );

    return { files, totalEntries };
  }

  private async openZip(buffer: Buffer): Promise<ZipFile> {
    try {
      return await openZipBuffer(buffer, { lazyEntries: true });
    } catch (err) {
      throw new ArchiveCorruptError('Failed to open archive as a valid ZIP', {
        cause: err,
      });
    }
  }

  private readEntryContent(zipfile: ZipFile, entry: Entry): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      zipfile.openReadStream(entry, (err, stream) => {
        if (err || !stream) {
          reject(err ?? new Error('yauzl returned no stream'));
          return;
        }
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
      });
    });
  }
}
```

`@types/yauzl` does not type the promise-returning variants (`fromBufferPromise`, `openReadStreamPromise`) added in yauzl 3.x, so this implementation uses the callback API wrapped with `promisify`/manual `Promise` construction instead — the same net effect, fully typed. If `pnpm build` reveals `@types/yauzl` _does_ type the promise variants (check `node_modules/@types/yauzl/index.d.ts`), simplify to use them directly; this is a build-time check, not a design decision to relitigate.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- zip-extractor.service.spec.ts`
Expected: PASS (4/4)

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/ingestion/zip-extractor.service.ts src/ingestion/zip-extractor.service.spec.ts
git commit -m "feat(ingestion): add ZipExtractorService with zip-slip and zip-bomb guards"
```

---

### Task 5: `DocumentCleanerService`

**Files:**

- Create: `src/ingestion/document-cleaner.service.ts`
- Test: `src/ingestion/document-cleaner.service.spec.ts`
- Modify: `package.json` (add `gray-matter` dependency)

**Interfaces:**

- Consumes: `RawFile` (Task 1), `PinoLogger`.
- Produces: `DocumentCleanerService.clean(raw: RawFile): CleanedFile` — consumed by Task 8.

- [ ] **Step 1: Install dependency**

```bash
pnpm add gray-matter
```

- [ ] **Step 2: Write the failing tests**

```typescript
// src/ingestion/document-cleaner.service.spec.ts
import { DocumentCleanerService } from './document-cleaner.service';
import { RawFile } from './ingestion.types';

function buildLogger(): { setContext: jest.Mock } {
  return { setContext: jest.fn() };
}

function rawFile(content: string): RawFile {
  return {
    sourcePath: 'docs/intro.md',
    content: Buffer.from(content, 'utf-8'),
    uncompressedSize: content.length,
    compressedSize: content.length,
    lastModified: new Date('2026-01-01T00:00:00.000Z'),
  };
}

describe('DocumentCleanerService', () => {
  const service = new DocumentCleanerService(buildLogger() as never);

  it('separates front matter from body text', () => {
    const result = service.clean(
      rawFile('---\ntitle: Intro\nlang: en\n---\n\nHello world.'),
    );

    expect(result.frontMatter).toEqual({ title: 'Intro', lang: 'en' });
    expect(result.text).toBe('Hello world.');
  });

  it('returns an empty front matter object when none is present', () => {
    const result = service.clean(rawFile('Just plain text.'));

    expect(result.frontMatter).toEqual({});
    expect(result.text).toBe('Just plain text.');
  });

  it('normalizes CRLF line endings to LF', () => {
    const result = service.clean(rawFile('Line one.\r\nLine two.'));

    expect(result.text).toBe('Line one.\nLine two.');
  });

  it('collapses three or more consecutive blank lines into one blank line', () => {
    const result = service.clean(rawFile('Para one.\n\n\n\nPara two.'));

    expect(result.text).toBe('Para one.\n\nPara two.');
  });

  it('trims leading and trailing whitespace from the body', () => {
    const result = service.clean(rawFile('\n\n  Hello.  \n\n'));

    expect(result.text).toBe('Hello.');
  });

  it('preserves the source path on the cleaned file', () => {
    const result = service.clean(rawFile('Text.'));

    expect(result.sourcePath).toBe('docs/intro.md');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test -- document-cleaner.service.spec.ts`
Expected: FAIL with "Cannot find module './document-cleaner.service'"

- [ ] **Step 4: Implement `DocumentCleanerService`**

```typescript
// src/ingestion/document-cleaner.service.ts
import { Injectable } from '@nestjs/common';
import matter from 'gray-matter';
import { PinoLogger } from 'nestjs-pino';
import { CleanedFile, RawFile } from './ingestion.types';

@Injectable()
export class DocumentCleanerService {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(DocumentCleanerService.name);
  }

  clean(raw: RawFile): CleanedFile {
    const { data, content } = matter(raw.content.toString('utf-8'));

    const normalized = content
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return {
      sourcePath: raw.sourcePath,
      text: normalized,
      frontMatter: data,
    };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- document-cleaner.service.spec.ts`
Expected: PASS (6/6)

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/ingestion/document-cleaner.service.ts src/ingestion/document-cleaner.service.spec.ts
git commit -m "feat(ingestion): add DocumentCleanerService"
```

---

### Task 6: `MarkdownParserService`

**Files:**

- Create: `src/ingestion/markdown-parser.service.ts`
- Test: `src/ingestion/markdown-parser.service.spec.ts`
- Modify: `package.json` (add `markdown-it` dependency)

**Interfaces:**

- Consumes: `PinoLogger`.
- Produces: `MarkdownParserService.parse(sourcePath: string, text: string): ParsedDocument` — consumed by Task 8.

- [ ] **Step 1: Install dependency**

```bash
pnpm add markdown-it
```

`markdown-it@15` bundles its own CommonJS type declarations (`dist/markdown-it.d.cts`, referenced via its package.json `exports` map) — no `@types/markdown-it` package is needed.

- [ ] **Step 2: Write the failing tests**

````typescript
// src/ingestion/markdown-parser.service.spec.ts
import { MarkdownParserService } from './markdown-parser.service';

function buildLogger(): { setContext: jest.Mock } {
  return { setContext: jest.fn() };
}

describe('MarkdownParserService', () => {
  const service = new MarkdownParserService(buildLogger() as never);

  it('extracts the title from the first H1 heading', () => {
    const result = service.parse('a.md', '# My Title\n\nBody text.');

    expect(result.title).toBe('My Title');
  });

  it('falls back to the source path as title when there is no H1', () => {
    const result = service.parse('a.md', 'No headings here.');

    expect(result.title).toBe('a.md');
  });

  it('builds a nested heading tree respecting heading levels', () => {
    const result = service.parse(
      'a.md',
      '# Top\n\n## Child\n\n### Grandchild\n\n## Second Child',
    );

    expect(result.headings).toHaveLength(1);
    expect(result.headings[0]?.text).toBe('Top');
    expect(result.headings[0]?.children).toHaveLength(2);
    expect(result.headings[0]?.children[0]?.text).toBe('Child');
    expect(result.headings[0]?.children[0]?.children[0]?.text).toBe(
      'Grandchild',
    );
    expect(result.headings[0]?.children[1]?.text).toBe('Second Child');
  });

  it('slugifies heading text into an anchor', () => {
    const result = service.parse('a.md', '# Hello, World! Docker Setup');

    expect(result.headings[0]?.anchor).toBe('hello-world-docker-setup');
  });

  it('extracts fenced code blocks with their language and position', () => {
    const result = service.parse(
      'a.md',
      '```bash\necho hi\n```\n\nText.\n\n```\nno lang\n```',
    );

    expect(result.codeBlocks).toHaveLength(2);
    expect(result.codeBlocks[0]).toEqual({
      language: 'bash',
      content: 'echo hi\n',
      position: 0,
    });
    expect(result.codeBlocks[1]?.language).toBeNull();
    expect(result.codeBlocks[1]?.position).toBe(1);
  });

  it('extracts link hrefs', () => {
    const result = service.parse(
      'a.md',
      'See [Docker docs](https://docs.docker.com) for more.',
    );

    expect(result.links).toEqual(['https://docs.docker.com']);
  });

  it('preserves the source path and full cleaned text as bodyText', () => {
    const result = service.parse('a.md', '# T\n\nBody.');

    expect(result.sourcePath).toBe('a.md');
    expect(result.bodyText).toBe('# T\n\nBody.');
  });
});
````

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test -- markdown-parser.service.spec.ts`
Expected: FAIL with "Cannot find module './markdown-parser.service'"

- [ ] **Step 4: Implement `MarkdownParserService`**

```typescript
// src/ingestion/markdown-parser.service.ts
import { Injectable } from '@nestjs/common';
import MarkdownIt from 'markdown-it';
import { PinoLogger } from 'nestjs-pino';
import { CodeBlock, HeadingNode, ParsedDocument } from './ingestion.types';

interface HeadingStackEntry {
  level: number;
  node: HeadingNode;
}

@Injectable()
export class MarkdownParserService {
  private readonly markdownIt = new MarkdownIt();

  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(MarkdownParserService.name);
  }

  parse(sourcePath: string, text: string): ParsedDocument {
    const tokens = this.markdownIt.parse(text, {});

    const headings: HeadingNode[] = [];
    const stack: HeadingStackEntry[] = [];
    const codeBlocks: CodeBlock[] = [];
    const links: string[] = [];
    let title = '';
    let codePosition = 0;

    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (!token) {
        continue;
      }

      if (token.type === 'heading_open') {
        const level = Number(token.tag.slice(1));
        const inline = tokens[i + 1];
        const headingText = inline?.type === 'inline' ? inline.content : '';
        const node: HeadingNode = {
          level,
          text: headingText,
          anchor: this.slugify(headingText),
          children: [],
        };

        while (stack.length > 0 && stack[stack.length - 1]!.level >= level) {
          stack.pop();
        }

        if (stack.length === 0) {
          headings.push(node);
        } else {
          stack[stack.length - 1]!.node.children.push(node);
        }
        stack.push({ level, node });

        if (title === '' && level === 1) {
          title = headingText;
        }
      }

      if (token.type === 'fence') {
        codeBlocks.push({
          language: token.info.trim() || null,
          content: token.content,
          position: codePosition,
        });
        codePosition += 1;
      }

      if (token.type === 'inline' && token.children) {
        for (const child of token.children) {
          if (child.type === 'link_open') {
            const href = child.attrGet('href');
            if (href) {
              links.push(href);
            }
          }
        }
      }
    }

    return {
      sourcePath,
      title: title || sourcePath,
      headings,
      bodyText: text,
      codeBlocks,
      links,
    };
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

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- markdown-parser.service.spec.ts`
Expected: PASS (7/7)

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/ingestion/markdown-parser.service.ts src/ingestion/markdown-parser.service.spec.ts
git commit -m "feat(ingestion): add MarkdownParserService"
```

---

### Task 7: `MetadataGeneratorService`

**Files:**

- Create: `src/ingestion/metadata-generator.service.ts`
- Test: `src/ingestion/metadata-generator.service.spec.ts`

**Interfaces:**

- Consumes: `ParsedDocument` (Task 1), `IngestionConfigService.defaultLanguage` (Task 3), `PinoLogger`.
- Produces: `MetadataGeneratorService.generate(parsed: ParsedDocument, cleanedText: string, frontMatter: Record<string, unknown>): DocumentMetadata` — consumed by Task 8.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/ingestion/metadata-generator.service.spec.ts
import { createHash } from 'node:crypto';
import { IngestionConfigService } from './ingestion-config.service';
import { MetadataGeneratorService } from './metadata-generator.service';
import { ParsedDocument } from './ingestion.types';

function buildLogger(): { setContext: jest.Mock } {
  return { setContext: jest.fn() };
}

function buildConfig(defaultLanguage = 'en'): IngestionConfigService {
  return { defaultLanguage } as IngestionConfigService;
}

function parsedDoc(overrides: Partial<ParsedDocument> = {}): ParsedDocument {
  return {
    sourcePath: 'docs/intro.md',
    title: 'Intro',
    headings: [],
    bodyText: 'Hello world.',
    codeBlocks: [],
    links: [],
    ...overrides,
  };
}

describe('MetadataGeneratorService', () => {
  const service = new MetadataGeneratorService(
    buildConfig(),
    buildLogger() as never,
  );

  it('computes a SHA-256 hash of the cleaned text', () => {
    const cleanedText = 'Hello world.';
    const expectedHash = createHash('sha256')
      .update(cleanedText, 'utf-8')
      .digest('hex');

    const metadata = service.generate(parsedDoc(), cleanedText, {});

    expect(metadata.contentHash).toBe(expectedHash);
  });

  it('counts words in the cleaned text', () => {
    const metadata = service.generate(parsedDoc(), 'one two three four', {});

    expect(metadata.wordCount).toBe(4);
  });

  it('uses the front-matter lang field when present', () => {
    const metadata = service.generate(parsedDoc(), 'text', { lang: 'fr' });

    expect(metadata.language).toBe('fr');
  });

  it('uses the front-matter language field when lang is absent', () => {
    const metadata = service.generate(parsedDoc(), 'text', {
      language: 'de',
    });

    expect(metadata.language).toBe('de');
  });

  it('falls back to the configured default language when front matter has none', () => {
    const metadata = service.generate(parsedDoc(), 'text', {});

    expect(metadata.language).toBe('en');
  });

  it('copies title, sourcePath, and headingOutline from the parsed document', () => {
    const parsed = parsedDoc({
      title: 'My Doc',
      sourcePath: 'x.md',
      headings: [{ level: 1, text: 'My Doc', anchor: 'my-doc', children: [] }],
    });

    const metadata = service.generate(parsed, 'text', {});

    expect(metadata.title).toBe('My Doc');
    expect(metadata.sourcePath).toBe('x.md');
    expect(metadata.headingOutline).toBe(parsed.headings);
  });

  it('passes front matter through unchanged', () => {
    const frontMatter = { title: 'X', tags: ['a', 'b'] };

    const metadata = service.generate(parsedDoc(), 'text', frontMatter);

    expect(metadata.frontMatter).toEqual(frontMatter);
  });

  it('stamps extractedAt as an ISO timestamp', () => {
    const metadata = service.generate(parsedDoc(), 'text', {});

    expect(() => new Date(metadata.extractedAt).toISOString()).not.toThrow();
    expect(new Date(metadata.extractedAt).toISOString()).toBe(
      metadata.extractedAt,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- metadata-generator.service.spec.ts`
Expected: FAIL with "Cannot find module './metadata-generator.service'"

- [ ] **Step 3: Implement `MetadataGeneratorService`**

```typescript
// src/ingestion/metadata-generator.service.ts
import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { IngestionConfigService } from './ingestion-config.service';
import { DocumentMetadata, ParsedDocument } from './ingestion.types';

@Injectable()
export class MetadataGeneratorService {
  constructor(
    private readonly config: IngestionConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(MetadataGeneratorService.name);
  }

  generate(
    parsed: ParsedDocument,
    cleanedText: string,
    frontMatter: Record<string, unknown>,
  ): DocumentMetadata {
    const contentHash = createHash('sha256')
      .update(cleanedText, 'utf-8')
      .digest('hex');

    const wordCount = cleanedText
      .trim()
      .split(/\s+/)
      .filter((word) => word.length > 0).length;

    return {
      title: parsed.title,
      sourcePath: parsed.sourcePath,
      contentHash,
      wordCount,
      language: this.resolveLanguage(frontMatter),
      headingOutline: parsed.headings,
      frontMatter,
      extractedAt: new Date().toISOString(),
    };
  }

  private resolveLanguage(frontMatter: Record<string, unknown>): string {
    const candidate = frontMatter['lang'] ?? frontMatter['language'];
    return typeof candidate === 'string' && candidate.length > 0
      ? candidate
      : this.config.defaultLanguage;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- metadata-generator.service.spec.ts`
Expected: PASS (8/8)

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/metadata-generator.service.ts src/ingestion/metadata-generator.service.spec.ts
git commit -m "feat(ingestion): add MetadataGeneratorService"
```

---

### Task 8: `IngestionPipelineService`, `IngestionModule`, and wiring into `AppModule`

**Files:**

- Create: `src/ingestion/ingestion-pipeline.service.ts`
- Test: `src/ingestion/ingestion-pipeline.service.spec.ts`
- Create: `src/ingestion/ingestion.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**

- Consumes: `ZipExtractorService` (Task 4), `DocumentCleanerService` (Task 5), `MarkdownParserService` (Task 6), `MetadataGeneratorService` (Task 7), `IngestionConfigService` (Task 3), `PinoLogger`.
- Produces: `IngestionPipelineService.run(archiveBuffer: Buffer): Promise<IngestionResult>` — consumed by Task 9's integration test.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/ingestion/ingestion-pipeline.service.spec.ts
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentCleanerService } from './document-cleaner.service';
import { IngestionConfigService } from './ingestion-config.service';
import { IngestionPipelineService } from './ingestion-pipeline.service';
import { IngestionThresholdExceededError } from './ingestion.errors';
import { ExtractionResult, StructuredDocument } from './ingestion.types';
import { MarkdownParserService } from './markdown-parser.service';
import { MetadataGeneratorService } from './metadata-generator.service';
import { ZipExtractorService } from './zip-extractor.service';

function buildLogger(): {
  setContext: jest.Mock;
  info: jest.Mock;
  warn: jest.Mock;
} {
  return { setContext: jest.fn(), info: jest.fn(), warn: jest.fn() };
}

describe('IngestionPipelineService', () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'ingestion-pipeline-test-'));
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  function buildService(config: Partial<IngestionConfigService> = {}) {
    const ingestionConfig = {
      outputDir,
      defaultLanguage: 'en',
      ...config,
    } as IngestionConfigService;

    return new IngestionPipelineService(
      new ZipExtractorServiceStub() as never,
      new DocumentCleanerService(buildLogger() as never),
      new MarkdownParserService(buildLogger() as never),
      new MetadataGeneratorService(ingestionConfig, buildLogger() as never),
      ingestionConfig,
      buildLogger() as never,
    );
  }

  class ZipExtractorServiceStub {
    extract(): Promise<ExtractionResult> {
      return Promise.resolve({
        totalEntries: 2,
        files: [
          {
            sourcePath: 'a.md',
            content: Buffer.from('# A\n\nBody A.'),
            uncompressedSize: 12,
            compressedSize: 12,
            lastModified: new Date('2026-01-01T00:00:00.000Z'),
          },
          {
            sourcePath: 'b.md',
            content: Buffer.from('# B\n\nBody B.'),
            uncompressedSize: 12,
            compressedSize: 12,
            lastModified: new Date('2026-01-01T00:00:00.000Z'),
          },
        ],
      });
    }
  }

  it('writes one StructuredDocument JSON file per extracted file', async () => {
    const service = buildService();

    const result = await service.run(Buffer.from(''));

    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);

    const outputFiles = await readdir(outputDir);
    expect(outputFiles).toHaveLength(2);

    const firstFile = await readFile(join(outputDir, outputFiles[0]!), 'utf-8');
    const parsed = JSON.parse(firstFile) as StructuredDocument;
    expect(parsed.metadata.title).toMatch(/^[AB]$/);
    expect(parsed.documentId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('isolates a per-file failure without failing the whole run', async () => {
    class FailingCleaner extends DocumentCleanerService {
      override clean(): never {
        throw new Error('boom');
      }
    }

    const ingestionConfig = {
      outputDir,
      defaultLanguage: 'en',
    } as IngestionConfigService;

    const service = new IngestionPipelineService(
      new ZipExtractorServiceStub() as never,
      new FailingCleaner(buildLogger() as never),
      new MarkdownParserService(buildLogger() as never),
      new MetadataGeneratorService(ingestionConfig, buildLogger() as never),
      ingestionConfig,
      buildLogger() as never,
    );

    const result = await service.run(Buffer.from(''));

    expect(result.failed).toBe(2);
    expect(result.succeeded).toBe(0);
  });

  it('throws IngestionThresholdExceededError when more than half of matched files fail', async () => {
    class SometimesFailingCleaner extends DocumentCleanerService {
      private callCount = 0;

      override clean(raw: Parameters<DocumentCleanerService['clean']>[0]) {
        this.callCount += 1;
        if (this.callCount === 1) {
          throw new Error('boom');
        }
        return super.clean(raw);
      }
    }

    const ingestionConfig = {
      outputDir,
      defaultLanguage: 'en',
    } as IngestionConfigService;

    class TwoFailuresExtractorStub {
      extract(): Promise<ExtractionResult> {
        return Promise.resolve({
          totalEntries: 1,
          files: [
            {
              sourcePath: 'only.md',
              content: Buffer.from('# Only'),
              uncompressedSize: 6,
              compressedSize: 6,
              lastModified: new Date('2026-01-01T00:00:00.000Z'),
            },
          ],
        });
      }
    }

    const service = new IngestionPipelineService(
      new TwoFailuresExtractorStub() as never,
      new SometimesFailingCleaner(buildLogger() as never),
      new MarkdownParserService(buildLogger() as never),
      new MetadataGeneratorService(ingestionConfig, buildLogger() as never),
      ingestionConfig,
      buildLogger() as never,
    );

    await expect(service.run(Buffer.from(''))).rejects.toThrow(
      IngestionThresholdExceededError,
    );
  });

  it('reports zero matched/succeeded/failed when the archive has no matching files', async () => {
    class EmptyExtractorStub {
      extract(): Promise<ExtractionResult> {
        return Promise.resolve({ totalEntries: 3, files: [] });
      }
    }

    const ingestionConfig = {
      outputDir,
      defaultLanguage: 'en',
    } as IngestionConfigService;

    const service = new IngestionPipelineService(
      new EmptyExtractorStub() as never,
      new DocumentCleanerService(buildLogger() as never),
      new MarkdownParserService(buildLogger() as never),
      new MetadataGeneratorService(ingestionConfig, buildLogger() as never),
      ingestionConfig,
      buildLogger() as never,
    );

    const result = await service.run(Buffer.from(''));

    expect(result.totalEntries).toBe(3);
    expect(result.matchedEntries).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- ingestion-pipeline.service.spec.ts`
Expected: FAIL with "Cannot find module './ingestion-pipeline.service'"

- [ ] **Step 3: Implement `IngestionPipelineService`**

```typescript
// src/ingestion/ingestion-pipeline.service.ts
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { DocumentCleanerService } from './document-cleaner.service';
import { IngestionConfigService } from './ingestion-config.service';
import { IngestionThresholdExceededError } from './ingestion.errors';
import {
  IngestionFailure,
  IngestionResult,
  StructuredDocument,
} from './ingestion.types';
import { MarkdownParserService } from './markdown-parser.service';
import { MetadataGeneratorService } from './metadata-generator.service';
import { ZipExtractorService } from './zip-extractor.service';

const FAILURE_THRESHOLD_RATIO = 0.5;

@Injectable()
export class IngestionPipelineService {
  constructor(
    private readonly extractor: ZipExtractorService,
    private readonly cleaner: DocumentCleanerService,
    private readonly parser: MarkdownParserService,
    private readonly metadataGenerator: MetadataGeneratorService,
    private readonly config: IngestionConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(IngestionPipelineService.name);
  }

  async run(archiveBuffer: Buffer): Promise<IngestionResult> {
    const startedAt = Date.now();
    const { files, totalEntries } = await this.extractor.extract(archiveBuffer);

    await mkdir(this.config.outputDir, { recursive: true });

    const failures: IngestionFailure[] = [];
    let succeeded = 0;

    for (const raw of files) {
      try {
        const structuredDocument = this.buildStructuredDocument(raw);
        await writeFile(
          join(this.config.outputDir, `${structuredDocument.documentId}.json`),
          JSON.stringify(structuredDocument, null, 2),
          'utf-8',
        );
        succeeded += 1;
        this.logger.info(
          {
            sourcePath: raw.sourcePath,
            documentId: structuredDocument.documentId,
          },
          'Document ingested',
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push({ sourcePath: raw.sourcePath, message });
        this.logger.warn(
          { sourcePath: raw.sourcePath, err },
          'Failed to ingest file',
        );
      }
    }

    const matchedEntries = files.length;
    if (
      matchedEntries > 0 &&
      failures.length / matchedEntries > FAILURE_THRESHOLD_RATIO
    ) {
      throw new IngestionThresholdExceededError(
        failures.length,
        matchedEntries,
      );
    }

    const result: IngestionResult = {
      totalEntries,
      matchedEntries,
      succeeded,
      failed: failures.length,
      failures,
      outputDir: this.config.outputDir,
      durationMs: Date.now() - startedAt,
    };

    this.logger.info(result, 'Ingestion run completed');
    return result;
  }

  private buildStructuredDocument(
    raw: Parameters<DocumentCleanerService['clean']>[0],
  ): StructuredDocument {
    const cleaned = this.cleaner.clean(raw);
    const parsed = this.parser.parse(cleaned.sourcePath, cleaned.text);
    const metadata = this.metadataGenerator.generate(
      parsed,
      cleaned.text,
      cleaned.frontMatter,
    );
    const documentId = createHash('sha256')
      .update(cleaned.sourcePath, 'utf-8')
      .digest('hex');

    return {
      documentId,
      metadata,
      headings: parsed.headings,
      bodyText: parsed.bodyText,
      codeBlocks: parsed.codeBlocks,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- ingestion-pipeline.service.spec.ts`
Expected: PASS (4/4)

- [ ] **Step 5: Create `IngestionModule`**

```typescript
// src/ingestion/ingestion.module.ts
import { Module } from '@nestjs/common';
import { DocumentCleanerService } from './document-cleaner.service';
import { IngestionConfigService } from './ingestion-config.service';
import { IngestionPipelineService } from './ingestion-pipeline.service';
import { MarkdownParserService } from './markdown-parser.service';
import { MetadataGeneratorService } from './metadata-generator.service';
import { ZipExtractorService } from './zip-extractor.service';

@Module({
  providers: [
    IngestionConfigService,
    ZipExtractorService,
    DocumentCleanerService,
    MarkdownParserService,
    MetadataGeneratorService,
    IngestionPipelineService,
  ],
  exports: [IngestionPipelineService],
})
export class IngestionModule {}
```

- [ ] **Step 6: Wire `IngestionModule` into `AppModule`**

Modify `src/app.module.ts` — add the import:

```typescript
import { IngestionModule } from './ingestion/ingestion.module';
```

And add `IngestionModule` to the `imports` array, after `HealthModule`:

```typescript
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      cache: true,
    }),
    LoggerModule.forRootAsync({
      providers: [AppConfigService],
      inject: [AppConfigService],
      useFactory: (appConfig: AppConfigService) => ({
        pinoHttp: buildPinoHttpOptions(appConfig),
      }),
    }),
    HealthModule,
    IngestionModule,
  ],
```

- [ ] **Step 7: Run the full unit suite and build to confirm wiring compiles**

Run: `pnpm test && pnpm build`
Expected: all existing + new unit tests PASS; build succeeds with no TypeScript errors

- [ ] **Step 8: Commit**

```bash
git add src/ingestion/ingestion-pipeline.service.ts src/ingestion/ingestion-pipeline.service.spec.ts src/ingestion/ingestion.module.ts src/app.module.ts
git commit -m "feat(ingestion): add IngestionPipelineService and wire IngestionModule into AppModule"
```

---

### Task 9: Integration test with a real fixture ZIP, final verification, and report

**Files:**

- Create: `test/fixtures/ingestion/source/intro.md`
- Create: `test/fixtures/ingestion/source/guide/setup.md`
- Create: `test/fixtures/ingestion/source/notes.txt`
- Create: `test/fixtures/ingestion/sample-docs.zip` (built from the three files above)
- Create: `test/ingestion.e2e-spec.ts`

**Interfaces:**

- Consumes: `IngestionModule` (Task 8), `IngestionPipelineService.run` (Task 8), `validateEnv` (Task 3).

- [ ] **Step 1: Create the fixture source files**

````markdown
<!-- test/fixtures/ingestion/source/intro.md -->

---

title: Introduction
lang: en
---

# Introduction

Welcome to the docs. See the [setup guide](./guide/setup.md) for details.

```bash
docker --version
```
````

````

```markdown
<!-- test/fixtures/ingestion/source/guide/setup.md -->
# Setup

## Prerequisites

Install Docker before continuing.

## Steps

1. Download the installer.
2. Run it.
````

```
<!-- test/fixtures/ingestion/source/notes.txt -->
These are internal notes, not documentation, and must not be ingested.
```

- [ ] **Step 2: Build the fixture ZIP**

```bash
cd test/fixtures/ingestion/source
zip -q -r ../sample-docs.zip .
cd -
```

Verify it contains the expected entries:

```bash
unzip -l test/fixtures/ingestion/sample-docs.zip
```

Expected output lists `intro.md`, `guide/setup.md`, and `notes.txt`.

- [ ] **Step 3: Write the integration test**

```typescript
// test/ingestion.e2e-spec.ts
import { readFile as readFileAsync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from '../src/config/env.validation';
import { IngestionModule } from '../src/ingestion/ingestion.module';
import { IngestionPipelineService } from '../src/ingestion/ingestion-pipeline.service';
import { StructuredDocument } from '../src/ingestion/ingestion.types';

describe('Ingestion (e2e)', () => {
  let outputDir: string;
  const previousOutputDir = process.env.INGESTION_OUTPUT_DIR;

  beforeAll(async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'ingestion-e2e-'));
    process.env.INGESTION_OUTPUT_DIR = outputDir;
  });

  afterAll(async () => {
    if (previousOutputDir === undefined) {
      delete process.env.INGESTION_OUTPUT_DIR;
    } else {
      process.env.INGESTION_OUTPUT_DIR = previousOutputDir;
    }
    await rm(outputDir, { recursive: true, force: true });
  });

  it('ingests a real ZIP fixture end-to-end into StructuredDocument JSON files', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ validate: validateEnv, cache: false }),
        LoggerModule.forRoot(),
        IngestionModule,
      ],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init();

    const pipeline = app.get(IngestionPipelineService);
    const archiveBuffer = readFileSync(
      join(__dirname, 'fixtures', 'ingestion', 'sample-docs.zip'),
    );

    const result = await pipeline.run(archiveBuffer);

    expect(result.matchedEntries).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);

    const outputFiles = await readdir(outputDir);
    expect(outputFiles).toHaveLength(2);

    const documents = await Promise.all(
      outputFiles.map(async (file) => {
        const contents = await readFile(join(outputDir, file), 'utf-8');
        return JSON.parse(contents) as StructuredDocument;
      }),
    );

    const introDoc = documents.find(
      (doc) => doc.metadata.sourcePath === 'intro.md',
    );
    expect(introDoc).toBeDefined();
    expect(introDoc?.metadata.title).toBe('Introduction');
    expect(introDoc?.metadata.language).toBe('en');
    expect(introDoc?.codeBlocks).toEqual([
      { language: 'bash', content: 'docker --version\n', position: 0 },
    ]);

    const setupDoc = documents.find(
      (doc) => doc.metadata.sourcePath === 'guide/setup.md',
    );
    expect(setupDoc).toBeDefined();
    expect(setupDoc?.headings[0]?.text).toBe('Setup');
    expect(setupDoc?.headings[0]?.children).toHaveLength(2);

    await app.close();
  });
});
```

Note: the unused `readFile as readFileAsync` import in the sketch above must not actually be included — the final file only imports what it uses (`readFileSync` from `node:fs`; `mkdtemp`, `readdir`, `readFile`, `rm` from `node:fs/promises`). Remove the stray import line before running; it was left in only to flag the naming collision between `node:fs`'s sync `readFile`-adjacent API and `node:fs/promises`'s `readFile` if both were imported unaliased.

- [ ] **Step 4: Run the integration test**

Run: `pnpm test:e2e -- ingestion.e2e-spec.ts`
Expected: PASS (1/1)

- [ ] **Step 5: Run full verification suite**

```bash
pnpm lint
pnpm test
pnpm test:e2e
pnpm build
```

Expected: all four succeed with zero errors and zero warnings. If `env-example.spec.ts` fails, this means the manual `.env.example` edit from Task 3 has not been applied yet — this is expected until the user does that edit; it is not a code defect.

- [ ] **Step 6: Commit**

```bash
git add test/fixtures/ingestion test/ingestion.e2e-spec.ts
git commit -m "test(ingestion): add end-to-end integration test with a real ZIP fixture"
```

- [ ] **Step 7: Write the implementation report**

Summarize in the final chat response (not a new file): which services were built, what they do, test counts (unit + integration), lint/build/test results, the five new env vars, and the one outstanding manual step (`.env.example` edit) with its exact content, matching the user's explicit request for "an implementation report."

---

## Out of Scope (explicitly, per the user's request)

- Chunking, embeddings, vector databases, retrieval, LLM integration.
- BullMQ / job queues — not requested; the pipeline runs synchronously via `IngestionPipelineService.run()`.
- The design doc's port/strategy abstraction layer (`DocumentLoaderPort`, `ArchiveFormatPort`, `CleaningStrategyPort`, `ParsingStrategyPort`, etc.) — premature for a single-format MVP; concrete services match the user's exact requested names instead.
- HTML parsing/cleaning (`HtmlParsingAdapter`, `HtmlCleaningAdapter`) — Markdown-only, per the user's `MarkdownParserService` naming.
- Database persistence (`Document`, `IngestionJob`, `IngestionArchive` entities) — no database exists in this project yet; output is JSON files on disk, matching the pipeline's literal requested terminus.
- Archive download — the pipeline accepts an in-memory `Buffer` (the caller is responsible for obtaining archive bytes, e.g., from an upload or a future HTTP endpoint); no HTTP controller or download step is implemented, since none was requested.

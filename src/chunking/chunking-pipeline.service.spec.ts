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

  it('counts mergedSections as the number of original sections absorbed, not the number of merged output pieces', async () => {
    // Three tiny undersized sibling sections should merge into one output
    // chunk, but mergedSections should report 2 (the two sections folded
    // away), not 1 (the single surviving merged chunk).
    const service = buildService({ maxChunkSize: 1000, minChunkSize: 50 });
    const doc = buildDocument(
      '# Title\n\n## A\n\ntiny\n\n## B\n\ntiny too\n\n## C\n\nalso tiny',
    );

    const result = await service.chunk(doc);

    expect(result.mergedSections).toBe(2);
    expect(result.splitSections).toBe(0);
  });

  it('counts splitSections as the number of distinct sections split, not the number of resulting pieces', async () => {
    // One oversized section split into several pieces should count as 1
    // split section, not N pieces.
    const service = buildService({ maxChunkSize: 15, minChunkSize: 2 });
    const doc = buildDocument('# Title\n\n' + 'word '.repeat(40).trim());

    const result = await service.chunk(doc);

    expect(result.splitSections).toBe(1);
    expect(result.mergedSections).toBe(0);
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

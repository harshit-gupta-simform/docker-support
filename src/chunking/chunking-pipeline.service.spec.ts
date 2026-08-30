import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StructuredDocument } from '../ingestion/ingestion.types';
import { ChunkAssemblerService } from './chunk-assembler.service';
import { ChunkingConfigService } from './chunking-config.service';
import { ChunkingThresholdExceededError } from './chunking.errors';
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
      measurer,
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

  describe('run', () => {
    let inputDir: string;

    beforeEach(async () => {
      inputDir = await mkdtemp(join(tmpdir(), 'chunking-pipeline-input-'));
    });

    afterEach(async () => {
      await rm(inputDir, { recursive: true, force: true });
    });

    async function writeDocument(
      fileName: string,
      document: StructuredDocument,
    ): Promise<void> {
      await writeFile(
        join(inputDir, fileName),
        JSON.stringify(document),
        'utf-8',
      );
    }

    it('reads a directory and calls chunk() once per .json file found', async () => {
      const service = buildService();
      await writeDocument('doc1.json', buildDocument('# Title\n\nBody one.'));
      await writeDocument('doc2.json', buildDocument('# Title\n\nBody two.'));
      await writeFile(join(inputDir, 'notes.txt'), 'ignore me', 'utf-8');

      const result = await service.run(inputDir);

      expect(result.totalDocuments).toBe(2);
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.failures).toEqual([]);
      expect(result.outputDir).toBe(outputDir);

      const outputFiles = await readdir(outputDir);
      expect(outputFiles).toContain('doc1.chunks.json');
    });

    it('isolates a single bad file (malformed JSON) without aborting the run', async () => {
      const service = buildService();
      await writeDocument('doc1.json', buildDocument('# Title\n\nBody one.'));
      await writeFile(join(inputDir, 'doc2.json'), '{ not valid json', 'utf-8');

      const result = await service.run(inputDir);

      expect(result.totalDocuments).toBe(2);
      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.failures).toEqual([
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() is typed `any` by @types/jest
        { documentId: 'doc2', message: expect.any(String) },
      ]);
    });

    it('aborts with ChunkingThresholdExceededError when more than half the files fail', async () => {
      const service = buildService();
      await writeDocument('doc1.json', buildDocument('# Title\n\nBody one.'));
      await writeFile(join(inputDir, 'doc2.json'), '{ bad', 'utf-8');
      await writeFile(join(inputDir, 'doc3.json'), '{ bad too', 'utf-8');

      await expect(service.run(inputDir)).rejects.toThrow(
        ChunkingThresholdExceededError,
      );
    });

    it('returns the correct summary shape on full success', async () => {
      const service = buildService();
      await writeDocument('doc1.json', buildDocument('# Title\n\nBody one.'));

      const result = await service.run(inputDir);

      expect(result).toEqual({
        totalDocuments: 1,
        succeeded: 1,
        failed: 0,
        failures: [],
        outputDir,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any() is typed `any` by @types/jest
        durationMs: expect.any(Number),
      });
    });
  });
});

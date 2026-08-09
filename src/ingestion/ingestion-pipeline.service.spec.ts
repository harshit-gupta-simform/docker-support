import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentCleanerService } from './document-cleaner.service';
import { IngestionConfigService } from './ingestion-config.service';
import { IngestionPipelineService } from './ingestion-pipeline.service';
import { IngestionThresholdExceededError } from './ingestion.errors';
import {
  ExtractionResult,
  RawFile,
  StructuredDocument,
} from './ingestion.types';
import { MarkdownParserService } from './markdown-parser.service';
import { MetadataGeneratorService } from './metadata-generator.service';

function buildLogger(): {
  setContext: jest.Mock;
  info: jest.Mock;
  warn: jest.Mock;
} {
  return { setContext: jest.fn(), info: jest.fn(), warn: jest.fn() };
}

function rawFile(sourcePath: string, content: string): RawFile {
  return {
    sourcePath,
    content: Buffer.from(content, 'utf-8'),
    uncompressedSize: content.length,
    compressedSize: content.length,
    lastModified: new Date('2026-01-01T00:00:00.000Z'),
  };
}

class TwoFileExtractorStub {
  extract(): Promise<ExtractionResult> {
    return Promise.resolve({
      totalEntries: 2,
      files: [
        rawFile('a.md', '# A\n\nBody A.'),
        rawFile('b.md', '# B\n\nBody B.'),
      ],
    });
  }
}

describe('IngestionPipelineService', () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'ingestion-pipeline-test-'));
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  function buildIngestionConfig(): IngestionConfigService {
    return { outputDir, defaultLanguage: 'en' } as IngestionConfigService;
  }

  it('writes one StructuredDocument JSON file per extracted file', async () => {
    const ingestionConfig = buildIngestionConfig();
    const service = new IngestionPipelineService(
      new TwoFileExtractorStub() as never,
      new DocumentCleanerService(buildLogger() as never),
      new MarkdownParserService(buildLogger() as never),
      new MetadataGeneratorService(ingestionConfig, buildLogger() as never),
      ingestionConfig,
      buildLogger() as never,
    );

    const result = await service.run(Buffer.from(''));

    expect(result.totalEntries).toBe(2);
    expect(result.matchedEntries).toBe(2);
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
    class OnceFailingCleaner extends DocumentCleanerService {
      private callCount = 0;

      override clean(raw: RawFile) {
        this.callCount += 1;
        if (this.callCount === 1) {
          throw new Error('boom');
        }
        return super.clean(raw);
      }
    }

    class ThreeFileExtractorStub {
      extract(): Promise<ExtractionResult> {
        return Promise.resolve({
          totalEntries: 3,
          files: [
            rawFile('a.md', '# A'),
            rawFile('b.md', '# B'),
            rawFile('c.md', '# C'),
          ],
        });
      }
    }

    const ingestionConfig = buildIngestionConfig();
    const service = new IngestionPipelineService(
      new ThreeFileExtractorStub() as never,
      new OnceFailingCleaner(buildLogger() as never),
      new MarkdownParserService(buildLogger() as never),
      new MetadataGeneratorService(ingestionConfig, buildLogger() as never),
      ingestionConfig,
      buildLogger() as never,
    );

    const result = await service.run(Buffer.from(''));

    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(2);
    expect(result.failures[0]?.message).toBe('boom');
  });

  it('throws IngestionThresholdExceededError when more than half of matched files fail', async () => {
    class SometimesFailingCleaner extends DocumentCleanerService {
      private callCount = 0;

      override clean(raw: RawFile) {
        this.callCount += 1;
        if (this.callCount <= 2) {
          throw new Error('boom');
        }
        return super.clean(raw);
      }
    }

    class ThreeFileExtractorStub {
      extract(): Promise<ExtractionResult> {
        return Promise.resolve({
          totalEntries: 3,
          files: [
            rawFile('a.md', '# A'),
            rawFile('b.md', '# B'),
            rawFile('c.md', '# C'),
          ],
        });
      }
    }

    const ingestionConfig = buildIngestionConfig();
    const service = new IngestionPipelineService(
      new ThreeFileExtractorStub() as never,
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

    const ingestionConfig = buildIngestionConfig();
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

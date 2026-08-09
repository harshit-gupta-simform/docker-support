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
  RawFile,
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

  private buildStructuredDocument(raw: RawFile): StructuredDocument {
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

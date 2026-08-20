import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { StructuredDocument } from '../ingestion/ingestion.types';
import { ChunkAssemblerService } from './chunk-assembler.service';
import { ChunkingConfigService } from './chunking-config.service';
import {
  ChunkingThresholdExceededError,
  EmptyDocumentError,
} from './chunking.errors';
import {
  ChunkingBatchFailure,
  ChunkingBatchResult,
  ChunkingResult,
  Section,
} from './chunking.types';
import { MarkdownSectionParserService } from './markdown-section-parser.service';
import { SectionSizeBounderService } from './section-size-bounder.service';

const FAILURE_THRESHOLD_RATIO = 0.5;

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
    // Counts distinct *original* sections affected, not output pieces — a
    // section split into 3 pieces counts once here, and a merged group that
    // absorbed 2 sibling sections counts 2 (the sections that no longer have
    // their own chunk), not 1 (the surviving merged piece). This was found
    // to matter during a real validation run: counting merged *pieces*
    // silently understated how many sections actually got folded away.
    const splitSections = new Set(
      pieces.filter((piece) => piece.wasSplit).map((piece) => piece.section),
    ).size;
    const mergedSections = pieces
      .filter((piece) => piece.wasMerged)
      .reduce((sum, piece) => sum + piece.mergedHeadings.length, 0);

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

  async run(inputDir: string): Promise<ChunkingBatchResult> {
    const startedAt = Date.now();
    const entries = await readdir(inputDir);
    const jsonFiles = entries.filter((entry) => extname(entry) === '.json');

    const failures: ChunkingBatchFailure[] = [];
    let succeeded = 0;

    for (const fileName of jsonFiles) {
      const fallbackDocumentId = basename(fileName, '.json');
      let documentId = fallbackDocumentId;
      try {
        const raw = await readFile(join(inputDir, fileName), 'utf-8');
        const document = JSON.parse(raw) as StructuredDocument;
        documentId = document.documentId ?? fallbackDocumentId;
        await this.chunk(document);
        succeeded += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push({ documentId, message });
        this.logger.warn({ documentId, err }, 'Failed to chunk document');
      }
    }

    const attemptedCount = jsonFiles.length;
    if (
      attemptedCount > 0 &&
      failures.length / attemptedCount > FAILURE_THRESHOLD_RATIO
    ) {
      throw new ChunkingThresholdExceededError(failures.length, attemptedCount);
    }

    const result: ChunkingBatchResult = {
      totalDocuments: attemptedCount,
      succeeded,
      failed: failures.length,
      failures,
      outputDir: this.config.outputDir,
      durationMs: Date.now() - startedAt,
    };

    this.logger.info(result, 'Chunking batch run completed');
    return result;
  }

  private countSections(section: Section): number {
    return section.children.reduce(
      (sum, child) => sum + 1 + this.countSections(child),
      0,
    );
  }
}

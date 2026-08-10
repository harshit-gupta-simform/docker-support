import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { StructuredDocument } from '../ingestion/ingestion.types';
import { ChunkAssemblerService } from './chunk-assembler.service';
import { ChunkingConfigService } from './chunking-config.service';
import { EmptyDocumentError } from './chunking.errors';
import { ChunkingResult, Section } from './chunking.types';
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

  private countSections(section: Section): number {
    return section.children.reduce(
      (sum, child) => sum + 1 + this.countSections(child),
      0,
    );
  }
}

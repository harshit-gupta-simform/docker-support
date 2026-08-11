import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { deriveChunkId } from './chunk-id.util';
import { ChunkingConfigService } from './chunking-config.service';
import {
  LENGTH_MEASURER_PORT,
  type LengthMeasurerPort,
} from './length-measurer';
import {
  Chunk,
  ChunkMetadata,
  ContentBlockType,
  HeadingPathSegment,
  ResolvedPiece,
  Section,
} from './chunking.types';

@Injectable()
export class ChunkAssemblerService {
  constructor(
    @Inject(LENGTH_MEASURER_PORT)
    private readonly lengthMeasurer: LengthMeasurerPort,
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

    const occurrenceIndices = this.computeOccurrenceIndices(pieces);
    const childChunks = pieces.map((piece, index) =>
      this.buildChildChunk(
        piece,
        index,
        occurrenceIndices[index]!,
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

    const { parentChunks, parentChunkBySection } = this.buildParentChunks(
      root,
      documentId,
      sourcePath,
      documentTitle,
      chunkedAt,
    );
    this.linkChildrenToParents(childChunks, pieces, parentChunkBySection);

    return [...parentChunks, ...childChunks];
  }

  // Real-corpus fix: two structurally distinct sections can share the exact
  // same headingPath (identical heading text at the identical nesting
  // depth — e.g. separate, un-nested "## From the GUI" subsections under
  // two different platform tabs). occurrenceIndex counts how many times a
  // given pathKey has already started a new section-run (localSequenceIndex
  // === 0) earlier in the document, so each occurrence gets a distinct
  // chunkId. Pieces continuing an existing run (localSequenceIndex > 0,
  // i.e. split pieces of one oversized section) reuse that run's
  // occurrence index rather than starting a new one.
  private computeOccurrenceIndices(pieces: ResolvedPiece[]): number[] {
    const nextOccurrence = new Map<string, number>();
    const currentOccurrence = new Map<string, number>();

    return pieces.map((piece) => {
      const pathKey = this.pathKeyFor(piece.headingPath);
      if (piece.localSequenceIndex === 0) {
        const occurrence = nextOccurrence.get(pathKey) ?? 0;
        nextOccurrence.set(pathKey, occurrence + 1);
        currentOccurrence.set(pathKey, occurrence);
      }
      return currentOccurrence.get(pathKey) ?? 0;
    });
  }

  private pathKeyFor(headingPath: HeadingPathSegment[]): string {
    return headingPath.map((segment) => segment.anchor).join('/');
  }

  private buildChildChunk(
    piece: ResolvedPiece,
    sequenceIndex: number,
    occurrenceIndex: number,
    documentId: string,
    sourcePath: string,
    documentTitle: string,
    chunkedAt: string,
  ): Chunk {
    const chunkId = deriveChunkId(
      documentId,
      'child',
      piece.headingPath,
      occurrenceIndex,
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
      const previousLastType =
        previousPiece?.contentTypes[previousPiece.contentTypes.length - 1];
      if (
        previousPiece &&
        previousLastType === 'paragraph' &&
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
    documentId: string,
    sourcePath: string,
    documentTitle: string,
    chunkedAt: string,
  ): { parentChunks: Chunk[]; parentChunkBySection: Map<Section, Chunk> } {
    const parentChunks: Chunk[] = [];
    const parentChunkBySection = new Map<Section, Chunk>();
    const occurrenceCounts = new Map<string, number>();

    const visit = (section: Section): void => {
      if (section.headingLevel > 0) {
        const pathKey = this.pathKeyFor(section.headingPath);
        const occurrenceIndex = occurrenceCounts.get(pathKey) ?? 0;
        occurrenceCounts.set(pathKey, occurrenceIndex + 1);

        const chunk = this.buildParentChunkFor(
          section,
          occurrenceIndex,
          documentId,
          sourcePath,
          documentTitle,
          chunkedAt,
        );
        parentChunks.push(chunk);
        parentChunkBySection.set(section, chunk);
      }
      section.children.forEach(visit);
    };
    root.children.forEach(visit);

    return { parentChunks, parentChunkBySection };
  }

  private buildParentChunkFor(
    section: Section,
    occurrenceIndex: number,
    documentId: string,
    sourcePath: string,
    documentTitle: string,
    chunkedAt: string,
  ): Chunk {
    const fullText = this.collectFullText(section);
    const chunkId = deriveChunkId(
      documentId,
      'parent',
      section.headingPath,
      occurrenceIndex,
      0,
    );
    const contentTypes = Array.from(new Set(this.collectContentTypes(section)));
    const length = this.lengthMeasurer.measure(fullText);

    const metadata: ChunkMetadata = {
      documentId,
      sourcePath,
      documentTitle,
      headingPath: section.headingPath,
      chunkType: 'parent',
      contentTypes,
      length,
      sequenceIndex: -1,
      wasSplit: false,
      wasMerged: false,
      mergedHeadings: [],
      // Parent chunks are deliberately uncapped by design (they hold a
      // section's full subtree for context expansion), but that doesn't mean
      // "too large to be useful" isn't a real, checkable condition — flagging
      // it against the same maxChunkSize threshold as children gives callers
      // a real signal instead of a hardcoded `false` that lies about size.
      exceedsMaxSize: length > this.config.maxChunkSize,
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

  private collectContentTypes(section: Section): ContentBlockType[] {
    return [
      ...section.blocks.map((block) => block.type),
      ...section.children.flatMap((child) => this.collectContentTypes(child)),
    ];
  }

  private linkChildrenToParents(
    childChunks: Chunk[],
    pieces: ResolvedPiece[],
    parentChunkBySection: Map<Section, Chunk>,
  ): void {
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

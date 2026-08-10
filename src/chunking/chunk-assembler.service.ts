import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { deriveChunkId } from './chunk-id.util';
import { ChunkingConfigService } from './chunking-config.service';
import {
  Chunk,
  ChunkMetadata,
  ContentBlockType,
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

    const visit = (section: Section): void => {
      if (section.headingLevel > 0) {
        const chunk = this.buildParentChunkFor(
          section,
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
      chunkType: 'parent',
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

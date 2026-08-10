import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import {
  LENGTH_MEASURER_PORT,
  type LengthMeasurerPort,
} from './length-measurer';
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
      return this.splitTableByRow(block.headerText, block.rowTexts, config);
    }
    if (block.type === 'list' && block.itemTexts) {
      return this.splitListByItem(block.itemTexts, config);
    }
    return [block];
  }

  private splitTableByRow(
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

      const candidateLength = pendingLength + singlePiece.length;
      if (pendingRun.length > 0 && candidateLength > config.maxChunkSize) {
        flush();
      }
      pendingRun.push(index);
      pendingLength += singlePiece.length;
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

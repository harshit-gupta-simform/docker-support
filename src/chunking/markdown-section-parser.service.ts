import { Inject, Injectable } from '@nestjs/common';
import MarkdownIt from 'markdown-it';
import { PinoLogger } from 'nestjs-pino';
import { classifyRange } from './content-block-classifier.util';
import {
  LENGTH_MEASURER_PORT,
  type LengthMeasurerPort,
} from './length-measurer';
import { ContentBlock, HeadingPathSegment, Section } from './chunking.types';

type Token = MarkdownIt.Token;

interface HeadingStackEntry {
  level: number;
  section: Section;
}

@Injectable()
export class MarkdownSectionParserService {
  private readonly markdownIt = new MarkdownIt();

  constructor(
    @Inject(LENGTH_MEASURER_PORT)
    private readonly lengthMeasurer: LengthMeasurerPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(MarkdownSectionParserService.name);
  }

  parse(bodyText: string): Section {
    const tokens = this.markdownIt.parse(bodyText, {});
    const lines = bodyText.split('\n');

    const root: Section = {
      headingText: '',
      headingLevel: 0,
      anchor: '',
      headingPath: [],
      blocks: [],
      children: [],
    };

    const stack: HeadingStackEntry[] = [{ level: 0, section: root }];

    let i = 0;
    while (i < tokens.length) {
      const token = tokens[i];
      if (!token) {
        i += 1;
        continue;
      }

      if (token.type === 'heading_open') {
        const level = Number(token.tag.slice(1));
        const inline = tokens[i + 1];
        const headingText = inline?.type === 'inline' ? inline.content : '';
        const anchor = this.slugify(headingText);

        while (stack.length > 1 && stack[stack.length - 1]!.level >= level) {
          stack.pop();
        }

        const parent = stack[stack.length - 1]!.section;
        const headingPath: HeadingPathSegment[] = [
          ...parent.headingPath,
          { level, text: headingText, anchor },
        ];
        const newSection: Section = {
          headingText,
          headingLevel: level,
          anchor,
          headingPath,
          blocks: [],
          children: [],
        };
        parent.children.push(newSection);
        stack.push({ level, section: newSection });

        i += 3; // heading_open, inline, heading_close
        continue;
      }

      const classified = classifyRange(tokens, i);
      if (!classified) {
        i += 1;
        continue;
      }

      const currentSection = stack[stack.length - 1]!.section;
      const block = this.buildBlock(
        classified.type,
        tokens,
        i,
        classified.endIndex,
        lines,
      );
      currentSection.blocks.push(block);
      i = classified.endIndex + 1;
    }

    return root;
  }

  private buildBlock(
    type: ContentBlock['type'],
    tokens: Token[],
    startIndex: number,
    endIndex: number,
    lines: string[],
  ): ContentBlock {
    const openToken = tokens[startIndex]!;
    const text = this.sliceByMap(openToken.map, lines);

    if (type === 'code') {
      return {
        type,
        text,
        language: openToken.info.trim() || null,
        length: this.lengthMeasurer.measure(text),
      };
    }

    if (type === 'list') {
      const itemTexts = this.extractListItems(
        tokens,
        startIndex,
        endIndex,
        lines,
      );
      return {
        type,
        text,
        language: null,
        length: this.lengthMeasurer.measure(text),
        itemTexts,
      };
    }

    if (type === 'table') {
      const { headerText, rowTexts } = this.extractTableRows(
        tokens,
        startIndex,
        endIndex,
        lines,
      );
      return {
        type,
        text,
        language: null,
        length: this.lengthMeasurer.measure(text),
        headerText,
        rowTexts,
      };
    }

    return {
      type,
      text,
      language: null,
      length: this.lengthMeasurer.measure(text),
    };
  }

  private extractListItems(
    tokens: Token[],
    startIndex: number,
    endIndex: number,
    lines: string[],
  ): string[] {
    const itemTexts: string[] = [];
    let depth = 0;

    for (let i = startIndex; i <= endIndex; i += 1) {
      const token = tokens[i];
      if (!token) {
        continue;
      }
      if (
        token.type === 'bullet_list_open' ||
        token.type === 'ordered_list_open'
      ) {
        depth += 1;
      }
      if (
        token.type === 'bullet_list_close' ||
        token.type === 'ordered_list_close'
      ) {
        depth -= 1;
      }
      if (token.type === 'list_item_open' && depth === 1) {
        itemTexts.push(this.sliceByMap(token.map, lines));
      }
    }

    return itemTexts;
  }

  private extractTableRows(
    tokens: Token[],
    startIndex: number,
    endIndex: number,
    lines: string[],
  ): { headerText: string; rowTexts: string[] } {
    // The GFM separator row (e.g. "| --- | --- |") is a delimiter consumed
    // during parsing — it never gets its own token, so `thead_open`'s own
    // `.map` only spans the header text row, not the separator beneath it.
    // A valid table's separator row always immediately follows the header
    // row in the source, so the header block is derived from the table's
    // own start line (table_open's map) plus the next line, rather than
    // from thead's token range.
    const tableStartLine = tokens[startIndex]?.map?.[0] ?? startIndex;
    const headerText = lines
      .slice(tableStartLine, tableStartLine + 2)
      .join('\n');

    const rowTexts: string[] = [];
    let inTbody = false;

    for (let i = startIndex; i <= endIndex; i += 1) {
      const token = tokens[i];
      if (!token) {
        continue;
      }
      if (token.type === 'tbody_open') {
        inTbody = true;
      }
      if (token.type === 'tbody_close') {
        inTbody = false;
      }
      if (token.type === 'tr_open' && inTbody) {
        rowTexts.push(this.sliceByMap(token.map, lines));
      }
    }

    return { headerText, rowTexts };
  }

  private sliceByMap(map: [number, number] | null, lines: string[]): string {
    if (!map) {
      return '';
    }
    return lines.slice(map[0], map[1]).join('\n');
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
}

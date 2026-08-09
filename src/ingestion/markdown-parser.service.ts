import { Injectable } from '@nestjs/common';
import MarkdownIt from 'markdown-it';
import { PinoLogger } from 'nestjs-pino';
import { CodeBlock, HeadingNode, ParsedDocument } from './ingestion.types';

interface HeadingStackEntry {
  level: number;
  node: HeadingNode;
}

@Injectable()
export class MarkdownParserService {
  private readonly markdownIt = new MarkdownIt();

  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(MarkdownParserService.name);
  }

  parse(sourcePath: string, text: string): ParsedDocument {
    const tokens = this.markdownIt.parse(text, {});

    const headings: HeadingNode[] = [];
    const stack: HeadingStackEntry[] = [];
    const codeBlocks: CodeBlock[] = [];
    const links: string[] = [];
    let title = '';
    let codePosition = 0;

    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (!token) {
        continue;
      }

      if (token.type === 'heading_open') {
        const level = Number(token.tag.slice(1));
        const inline = tokens[i + 1];
        const headingText = inline?.type === 'inline' ? inline.content : '';
        const node: HeadingNode = {
          level,
          text: headingText,
          anchor: this.slugify(headingText),
          children: [],
        };

        while (stack.length > 0 && stack[stack.length - 1]!.level >= level) {
          stack.pop();
        }

        if (stack.length === 0) {
          headings.push(node);
        } else {
          stack[stack.length - 1]!.node.children.push(node);
        }
        stack.push({ level, node });

        if (title === '' && level === 1) {
          title = headingText;
        }
      }

      if (token.type === 'fence') {
        codeBlocks.push({
          language: token.info.trim() || null,
          content: token.content,
          position: codePosition,
        });
        codePosition += 1;
      }

      if (token.type === 'inline' && token.children) {
        for (const child of token.children) {
          if (child.type === 'link_open') {
            const href = child.attrGet('href');
            if (typeof href === 'string' && href.length > 0) {
              links.push(href);
            }
          }
        }
      }
    }

    return {
      sourcePath,
      title: title || sourcePath,
      headings,
      bodyText: text,
      codeBlocks,
      links,
    };
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
}

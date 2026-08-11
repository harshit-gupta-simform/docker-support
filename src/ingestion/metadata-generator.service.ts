import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { IngestionConfigService } from './ingestion-config.service';
import { DocumentMetadata, ParsedDocument } from './ingestion.types';

@Injectable()
export class MetadataGeneratorService {
  constructor(
    private readonly config: IngestionConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(MetadataGeneratorService.name);
  }

  generate(
    parsed: ParsedDocument,
    cleanedText: string,
    frontMatter: Record<string, unknown>,
  ): DocumentMetadata {
    const contentHash = createHash('sha256')
      .update(cleanedText, 'utf-8')
      .digest('hex');

    const wordCount = cleanedText
      .trim()
      .split(/\s+/)
      .filter((word) => word.length > 0).length;

    return {
      title: this.resolveTitle(parsed.title, frontMatter),
      sourcePath: parsed.sourcePath,
      contentHash,
      wordCount,
      language: this.resolveLanguage(frontMatter),
      headingOutline: parsed.headings,
      frontMatter,
      extractedAt: new Date().toISOString(),
    };
  }

  // Hugo-based documentation sites (like Docker's real docs) put the
  // canonical title only in front matter and rarely repeat it as a body
  // H1, so front matter must win when present. parsedTitle is already
  // H1-or-sourcePath (MarkdownParserService's own contract), so this
  // naturally collapses to the full frontMatter.title -> H1 -> sourcePath
  // fallback chain.
  private resolveTitle(
    parsedTitle: string,
    frontMatter: Record<string, unknown>,
  ): string {
    const candidate = frontMatter['title'];
    return typeof candidate === 'string' && candidate.length > 0
      ? candidate
      : parsedTitle;
  }

  private resolveLanguage(frontMatter: Record<string, unknown>): string {
    const candidate = frontMatter['lang'] ?? frontMatter['language'];
    return typeof candidate === 'string' && candidate.length > 0
      ? candidate
      : this.config.defaultLanguage;
  }
}

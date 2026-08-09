import { Injectable } from '@nestjs/common';
import matter from 'gray-matter';
import { PinoLogger } from 'nestjs-pino';
import { CleanedFile, RawFile } from './ingestion.types';

@Injectable()
export class DocumentCleanerService {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(DocumentCleanerService.name);
  }

  clean(raw: RawFile): CleanedFile {
    const { data, content } = matter(raw.content.toString('utf-8'));

    const normalized = content
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return {
      sourcePath: raw.sourcePath,
      text: normalized,
      frontMatter: data,
    };
  }
}

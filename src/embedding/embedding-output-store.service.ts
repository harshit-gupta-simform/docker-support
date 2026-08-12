import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { EmbeddingConfigService } from './embedding-config.service';
import { EmbeddingRecord } from './embedding.types';

@Injectable()
export class EmbeddingOutputStoreService {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: EmbeddingConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(EmbeddingOutputStoreService.name);
  }

  outputFilePath(): string {
    return join(this.config.outputDir, 'embeddings.jsonl');
  }

  async loadExistingEmbeddingIds(): Promise<Set<string>> {
    const filePath = this.outputFilePath();
    const ids = new Set<string>();

    let raw: string;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return ids;
      }
      throw err;
    }

    const lines = raw.split('\n').filter((line) => line.trim().length > 0);
    lines.forEach((line, index) => {
      try {
        const record = JSON.parse(line) as EmbeddingRecord;
        ids.add(record.embeddingId);
      } catch (err) {
        if (index === lines.length - 1) {
          this.logger.warn(
            { filePath },
            'Ignoring truncated final line in embedding output (likely an interrupted previous run)',
          );
        } else {
          throw new Error(
            `Corrupt embedding output at ${filePath}, line ${index + 1}`,
            { cause: err },
          );
        }
      }
    });

    return ids;
  }

  append(record: EmbeddingRecord): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(this.config.outputDir, { recursive: true });
      await appendFile(
        this.outputFilePath(),
        `${JSON.stringify(record)}\n`,
        'utf-8',
      );
    });
    return this.writeQueue;
  }
}

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

    type ExistingConfig = Pick<
      EmbeddingRecord,
      'provider' | 'model' | 'modelVersion' | 'dimensions'
    >;
    let existingConfig: ExistingConfig | null = null;

    const lines = raw.split('\n').filter((line) => line.trim().length > 0);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      try {
        const record = JSON.parse(line) as EmbeddingRecord;
        ids.add(record.embeddingId);
        if (existingConfig === null) {
          existingConfig = {
            provider: record.provider,
            model: record.model,
            modelVersion: record.modelVersion,
            dimensions: record.dimensions,
          };
        }
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
    }

    const config: ExistingConfig | null = existingConfig;
    if (
      config !== null &&
      (config.provider !== this.config.provider ||
        config.model !== this.config.model ||
        config.modelVersion !== this.config.modelVersion ||
        config.dimensions !== this.config.dimensions)
    ) {
      throw new Error(
        `Existing embedding output at ${filePath} was written with provider=${config.provider}/model=${config.model}/modelVersion=${config.modelVersion}/dimensions=${config.dimensions}, but the current configuration is provider=${this.config.provider}/model=${this.config.model}/modelVersion=${this.config.modelVersion}/dimensions=${this.config.dimensions}. Use a different EMBEDDING_OUTPUT_DIR, or clear the existing output, before switching providers/models.`,
      );
    }

    return ids;
  }

  append(record: EmbeddingRecord): Promise<void> {
    const write = this.writeQueue.then(
      () => this.doWrite(record),
      () => this.doWrite(record),
    );
    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  private async doWrite(record: EmbeddingRecord): Promise<void> {
    await mkdir(this.config.outputDir, { recursive: true });
    await appendFile(
      this.outputFilePath(),
      `${JSON.stringify(record)}\n`,
      'utf-8',
    );
  }
}

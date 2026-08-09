import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { fromBufferPromise, type ZipFile } from 'yauzl';
import { matchesGlob } from './glob-match.util';
import {
  ArchiveCorruptError,
  ArchiveSizeLimitExceededError,
} from './ingestion.errors';
import { IngestionConfigService } from './ingestion-config.service';
import { ExtractionResult, RawFile } from './ingestion.types';
import { assertSafeEntryName } from './zip-path-safety';

@Injectable()
export class ZipExtractorService {
  constructor(
    private readonly config: IngestionConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ZipExtractorService.name);
  }

  async extract(buffer: Buffer): Promise<ExtractionResult> {
    const zipfile = await this.openZip(buffer);

    if (zipfile.entryCount > this.config.maxEntryCount) {
      zipfile.close();
      throw new ArchiveSizeLimitExceededError(
        `Archive declares ${zipfile.entryCount} entries, exceeding the configured limit of ${this.config.maxEntryCount}`,
      );
    }

    const files: RawFile[] = [];
    let totalUncompressedBytes = 0;
    let totalEntries = 0;

    for await (const entry of zipfile.eachEntry()) {
      totalEntries += 1;

      if (entry.fileName.endsWith('/')) {
        continue;
      }

      assertSafeEntryName(entry.fileName);

      totalUncompressedBytes += entry.uncompressedSize;
      if (totalUncompressedBytes > this.config.maxUncompressedBytes) {
        throw new ArchiveSizeLimitExceededError(
          `Archive uncompressed size exceeds the configured limit of ${this.config.maxUncompressedBytes} bytes`,
        );
      }

      if (!matchesGlob(entry.fileName, this.config.includeGlob)) {
        continue;
      }

      const stream = await zipfile.openReadStreamPromise(entry);
      const content = await this.readStreamToBuffer(stream);

      files.push({
        sourcePath: entry.fileName,
        content,
        uncompressedSize: entry.uncompressedSize,
        compressedSize: entry.compressedSize,
        lastModified: entry.getLastModDate(),
      });
    }

    this.logger.info(
      { totalEntries, matchedEntries: files.length },
      'Archive extracted',
    );

    return { files, totalEntries };
  }

  private async openZip(buffer: Buffer): Promise<ZipFile> {
    try {
      return await fromBufferPromise(buffer, { lazyEntries: true });
    } catch (err) {
      throw new ArchiveCorruptError('Failed to open archive as a valid ZIP', {
        cause: err,
      });
    }
  }

  private readStreamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }
}

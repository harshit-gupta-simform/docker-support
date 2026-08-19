import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import pLimit from 'p-limit';
import { Chunk } from '../chunking/chunking.types';
import { EmbeddingRecord } from '../embedding/embedding.types';
import { EmbeddingConfigService } from '../embedding/embedding-config.service';
import { IndexingBatchProcessorService } from './indexing-batch-processor.service';
import { VectorStoreConfigService } from './vector-store-config.service';
import { VECTOR_STORE_PORT, type VectorStorePort } from './vector-store.port';
import { validateRecordForIndexing } from './vector-store-record-validator.util';
import { transformToVectorPoint } from './vector-store-record-transformer.util';
import { VectorStoreThresholdExceededError } from './vector-store.errors';
import {
  IndexFailure,
  IndexRunResult,
  VectorPoint,
} from './vector-store.types';

function chunkArray<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

@Injectable()
export class IndexingPipelineService {
  constructor(
    private readonly config: VectorStoreConfigService,
    @Inject(VECTOR_STORE_PORT) private readonly store: VectorStorePort,
    private readonly batchProcessor: IndexingBatchProcessorService,
    private readonly embeddingConfig: EmbeddingConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(IndexingPipelineService.name);
  }

  async run(
    embeddingsFile: string,
    chunksDir: string,
    collection: string,
  ): Promise<IndexRunResult> {
    const startedAt = Date.now();
    const jobId = randomUUID();

    const records = await this.readEmbeddingRecords(embeddingsFile);
    const chunksById = await this.readChunksById(chunksDir);

    this.logger.info(
      { jobId, collection, recordCount: records.length },
      'Indexing run started',
    );

    const dimensions =
      records[0]?.dimensions ?? this.inferDimensionsFallback(records);
    await this.store.ensureCollection(collection, dimensions);
    const info = await this.store.collectionInfo(collection);
    if (info && info.dimensions !== dimensions) {
      throw new Error(
        `Collection "${collection}" was created with dimensions=${info.dimensions}, but these records have dimensions=${dimensions}`,
      );
    }

    let skippedByProvenanceMismatch = 0;
    let skippedFakeProvider = 0;
    const points: VectorPoint[] = [];

    const target = {
      provider: this.embeddingConfig.provider,
      model: this.embeddingConfig.model,
      modelVersion: this.embeddingConfig.modelVersion,
      dimensions: this.embeddingConfig.dimensions,
    };

    for (const record of records) {
      try {
        validateRecordForIndexing(record, target, {
          allowFakeProvider: this.config.allowFakeProvider,
        });
      } catch (err) {
        if (record.provider === 'fake' && !this.config.allowFakeProvider) {
          skippedFakeProvider += 1;
        } else {
          skippedByProvenanceMismatch += 1;
        }
        this.logger.debug(
          { chunkId: record.chunkId, error: (err as Error).message },
          'Skipping record during indexing validation',
        );
        continue;
      }

      const chunk = chunksById.get(record.chunkId);
      if (!chunk) {
        skippedByProvenanceMismatch += 1;
        this.logger.warn(
          { chunkId: record.chunkId },
          'No matching chunk found for embedding record — skipping',
        );
        continue;
      }

      const parentChunk = chunk.relationships.parentChunkId
        ? (chunksById.get(chunk.relationships.parentChunkId) ?? null)
        : null;
      if (chunk.relationships.parentChunkId && !parentChunk) {
        this.logger.warn(
          {
            chunkId: chunk.chunkId,
            parentChunkId: chunk.relationships.parentChunkId,
          },
          'Parent chunk not found — indexing without parent context',
        );
      }

      points.push(
        transformToVectorPoint(record, chunk, parentChunk, this.config.domain),
      );
    }

    const batches = chunkArray(points, this.config.batchSize);
    const limit = pLimit(this.config.maxConcurrentBatches);
    let succeededCount = 0;
    const failures: IndexFailure[] = [];

    await Promise.all(
      batches.map((batchPoints, index) =>
        limit(async () => {
          const batchId = `${jobId}-${index}`;
          const outcome = await this.batchProcessor.processBatch(
            batchId,
            collection,
            batchPoints,
          );
          succeededCount += outcome.succeededIds.length;
          failures.push(...outcome.failed);

          this.logger.info(
            {
              jobId,
              batchId,
              pointCount: batchPoints.length,
              succeeded: outcome.succeededIds.length,
              failed: outcome.failed.length,
            },
            'Index batch completed',
          );
        }),
      ),
    );

    const attempted = points.length;
    if (
      attempted > 0 &&
      failures.length / attempted > this.config.failureThreshold
    ) {
      throw new VectorStoreThresholdExceededError(failures.length, attempted);
    }

    const result: IndexRunResult = {
      jobId,
      collection,
      totalRecordsScanned: records.length,
      skippedByProvenanceMismatch,
      skippedFakeProvider,
      attempted,
      succeeded: succeededCount,
      failed: failures.length,
      failures,
      totalBatches: batches.length,
      durationMs: Date.now() - startedAt,
    };

    this.logger.info(
      { ...result, failures: undefined },
      'Indexing run completed',
    );
    return result;
  }

  private inferDimensionsFallback(records: EmbeddingRecord[]): number {
    return records[0]?.vector.length ?? 0;
  }

  private async readEmbeddingRecords(
    embeddingsFile: string,
  ): Promise<EmbeddingRecord[]> {
    const raw = await readFile(embeddingsFile, 'utf-8');
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as EmbeddingRecord);
  }

  private async readChunksById(chunksDir: string): Promise<Map<string, Chunk>> {
    const byId = new Map<string, Chunk>();
    const files = (await readdir(chunksDir)).filter((file) =>
      file.endsWith('.chunks.json'),
    );
    for (const file of files) {
      const raw = await readFile(join(chunksDir, file), 'utf-8');
      const chunks = JSON.parse(raw) as Chunk[];
      for (const chunk of chunks) {
        byId.set(chunk.chunkId, chunk);
      }
    }
    return byId;
  }
}

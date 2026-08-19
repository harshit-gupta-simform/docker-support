import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { withRetry } from '../common/retry.util';
import { VectorStoreConfigService } from './vector-store-config.service';
import { VECTOR_STORE_PORT, type VectorStorePort } from './vector-store.port';
import { TransientVectorStoreError } from './vector-store.errors';
import { IndexFailure, VectorPoint } from './vector-store.types';

export interface IndexBatchOutcome {
  batchId: string;
  succeededIds: string[];
  failed: IndexFailure[];
}

@Injectable()
export class IndexingBatchProcessorService {
  constructor(
    @Inject(VECTOR_STORE_PORT) private readonly store: VectorStorePort,
    private readonly config: VectorStoreConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(IndexingBatchProcessorService.name);
  }

  async processBatch(
    batchId: string,
    collection: string,
    points: VectorPoint[],
  ): Promise<IndexBatchOutcome> {
    try {
      await withRetry(() => this.upsertWithTimeout(collection, points), {
        maxAttempts: this.config.maxRetries,
        baseDelayMs: this.config.retryBaseDelayMs,
        maxDelayMs: this.config.retryMaxDelayMs,
        isRetryable: (err) => err instanceof TransientVectorStoreError,
        getRetryAfterMs: () => null,
      });
      return {
        batchId,
        succeededIds: points.map((p) => p.id),
        failed: [],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        { batchId, pointCount: points.length, error: message },
        'Index batch failed permanently after retries',
      );
      return {
        batchId,
        succeededIds: [],
        failed: points.map((p) => ({
          chunkId: p.payload.chunkId,
          message,
        })),
      };
    }
  }

  private upsertWithTimeout(
    collection: string,
    points: VectorPoint[],
  ): Promise<void> {
    let timeoutHandle!: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(
          new TransientVectorStoreError(
            `Vector store upsert timed out after ${this.config.requestTimeoutMs}ms`,
          ),
        );
      }, this.config.requestTimeoutMs);
    });

    return Promise.race([
      this.store.upsert(collection, points),
      timeoutPromise,
    ]).finally(() => {
      clearTimeout(timeoutHandle);
    });
  }
}

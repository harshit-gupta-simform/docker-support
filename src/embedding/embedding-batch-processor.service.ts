import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { EmbeddingConfigService } from './embedding-config.service';
import {
  EMBEDDING_PROVIDER_PORT,
  type EmbeddingProviderPort,
  type EmbeddingProviderRequestItem,
  type EmbeddingProviderResponseItem,
} from './embedding-provider.port';
import { validateProviderResponse } from './embedding-response-validator.util';
import { deriveEmbeddingId } from './embedding-id.util';
import { withRetry } from '../common/retry.util';
import {
  RateLimitEmbeddingProviderError,
  TransientEmbeddingProviderError,
} from './embedding.errors';
import {
  EmbeddingFailure,
  EmbeddingInput,
  EmbeddingRecord,
} from './embedding.types';

export interface EmbeddingBatchOutcome {
  batchId: string;
  succeeded: EmbeddingRecord[];
  failed: EmbeddingFailure[];
}

@Injectable()
export class EmbeddingBatchProcessorService {
  constructor(
    @Inject(EMBEDDING_PROVIDER_PORT)
    private readonly provider: EmbeddingProviderPort,
    private readonly config: EmbeddingConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(EmbeddingBatchProcessorService.name);
  }

  async processBatch(
    batchId: string,
    inputs: EmbeddingInput[],
  ): Promise<EmbeddingBatchOutcome> {
    const requestItems: EmbeddingProviderRequestItem[] = inputs.map(
      (input) => ({
        id: input.chunkId,
        text: input.text,
      }),
    );

    try {
      const responseItems = await withRetry(
        () => this.embedWithTimeout(requestItems),
        {
          maxAttempts: this.config.maxRetries,
          baseDelayMs: this.config.retryBaseDelayMs,
          maxDelayMs: this.config.retryMaxDelayMs,
          isRetryable: (err) => err instanceof TransientEmbeddingProviderError,
          getRetryAfterMs: (err) =>
            err instanceof RateLimitEmbeddingProviderError
              ? err.retryAfterMs
              : null,
        },
      );

      validateProviderResponse(
        requestItems,
        responseItems,
        this.provider.metadata.dimensions,
      );

      const succeeded = inputs.map((input, index) =>
        this.toRecord(input, responseItems[index]!.vector),
      );
      return { batchId, succeeded, failed: [] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        { batchId, chunkCount: inputs.length, error: message },
        'Embedding batch failed permanently after retries',
      );
      return {
        batchId,
        succeeded: [],
        failed: inputs.map((input) => ({
          chunkId: input.chunkId,
          sourcePath: input.sourcePath,
          message,
        })),
      };
    }
  }

  private embedWithTimeout(
    items: EmbeddingProviderRequestItem[],
  ): Promise<EmbeddingProviderResponseItem[]> {
    const controller = new AbortController();
    let timeoutHandle!: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(
          new TransientEmbeddingProviderError(
            `Embedding request timed out after ${this.config.requestTimeoutMs}ms`,
          ),
        );
      }, this.config.requestTimeoutMs);
    });

    return Promise.race([
      this.provider.embed(items, controller.signal),
      timeoutPromise,
    ]).finally(() => {
      clearTimeout(timeoutHandle);
    });
  }

  private toRecord(input: EmbeddingInput, vector: number[]): EmbeddingRecord {
    const modelMetadata = this.provider.metadata;
    return {
      embeddingId: deriveEmbeddingId(
        input.chunkId,
        input.contentHash,
        modelMetadata,
      ),
      chunkId: input.chunkId,
      documentId: input.documentId,
      sourcePath: input.sourcePath,
      vector,
      dimensions: modelMetadata.dimensions,
      provider: modelMetadata.provider,
      model: modelMetadata.model,
      modelVersion: modelMetadata.modelVersion,
      contentHash: input.contentHash,
      inputHash: input.inputHash,
      inputTokenCount: input.tokenCount,
      truncated: input.truncated,
      createdAt: new Date().toISOString(),
    };
  }
}

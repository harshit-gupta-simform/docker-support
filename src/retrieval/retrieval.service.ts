import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { withRetry } from '../common/retry.util';
import {
  EMBEDDING_PROVIDER_PORT,
  type EmbeddingProviderPort,
} from '../embedding/embedding-provider.port';
import { TransientEmbeddingProviderError } from '../embedding/embedding.errors';
import {
  VECTOR_STORE_PORT,
  type VectorStorePort,
} from '../vector-store/vector-store.port';
import { RetrievalConfigService } from './retrieval-config.service';
import {
  RetrievalConfigMismatchError,
  RetrievalValidationError,
} from './retrieval.errors';
import { RetrievalQuery, RetrievalResult } from './retrieval.types';

@Injectable()
export class RetrievalService {
  constructor(
    @Inject(EMBEDDING_PROVIDER_PORT)
    private readonly embeddingProvider: EmbeddingProviderPort,
    @Inject(VECTOR_STORE_PORT) private readonly store: VectorStorePort,
    private readonly config: RetrievalConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RetrievalService.name);
  }

  async retrieve(
    query: RetrievalQuery,
    collection: string,
  ): Promise<RetrievalResult[]> {
    const startedAt = Date.now();
    const text = query.text.trim();
    if (text.length === 0) {
      throw new RetrievalValidationError('Query text must not be empty');
    }

    const topK = query.topK ?? this.config.defaultTopK;
    if (topK > this.config.maxTopK) {
      throw new RetrievalValidationError(
        `Requested topK=${topK} exceeds RETRIEVAL_MAX_TOP_K=${this.config.maxTopK}`,
      );
    }

    const collectionInfo = await this.store.collectionInfo(collection);
    if (collectionInfo === null) {
      throw new RetrievalValidationError(
        `Collection "${collection}" does not exist — run "pnpm index" first`,
      );
    }
    if (
      collectionInfo.dimensions !== this.embeddingProvider.metadata.dimensions
    ) {
      throw new RetrievalConfigMismatchError(collectionInfo.dimensions, {
        provider: this.embeddingProvider.metadata.provider,
        model: this.embeddingProvider.metadata.model,
        dimensions: this.embeddingProvider.metadata.dimensions,
      });
    }

    const embedded = await withRetry(() => this.embedQueryWithTimeout(text), {
      maxAttempts: this.config.maxRetries,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      isRetryable: (err) => err instanceof TransientEmbeddingProviderError,
    });
    const { vector } = embedded[0]!;

    const expandToParent = query.expandToParent ?? this.config.expandToParent;

    const matches = await this.store.search({
      collection,
      vector,
      topK,
      scoreThreshold: query.scoreThreshold ?? this.config.scoreThreshold,
      filter: {
        domain: query.domain,
        ...(query.filter?.documentId !== undefined
          ? { documentId: query.filter.documentId }
          : {}),
        ...(query.filter?.sourcePath !== undefined
          ? { sourcePath: query.filter.sourcePath }
          : {}),
      },
    });

    const results: RetrievalResult[] = matches.map((match) => ({
      chunkId: match.payload.chunkId,
      documentId: match.payload.documentId,
      parentChunkId: match.payload.parentChunkId,
      chunkType: match.payload.chunkType,
      score: match.score,
      text: match.payload.text,
      parentText: expandToParent ? match.payload.parentText : null,
      headingPath: match.payload.headingPath,
      documentTitle: match.payload.documentTitle,
      sourcePath: match.payload.sourcePath,
      domain: match.payload.domain,
    }));

    this.logger.info(
      {
        domain: query.domain,
        collection,
        topK,
        resultCount: results.length,
        highestScore: results[0]?.score ?? null,
        provider: this.embeddingProvider.metadata.provider,
        model: this.embeddingProvider.metadata.model,
        durationMs: Date.now() - startedAt,
      },
      'Retrieval query executed',
    );

    return results;
  }

  private embedQueryWithTimeout(
    text: string,
  ): Promise<Array<{ id: string; vector: number[] }>> {
    let timeoutHandle!: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(
          new TransientEmbeddingProviderError(
            `Query embedding timed out after ${this.config.requestTimeoutMs}ms`,
          ),
        );
      }, this.config.requestTimeoutMs);
    });

    return Promise.race([
      this.embeddingProvider.embed([{ id: 'query', text }]),
      timeoutPromise,
    ]).finally(() => clearTimeout(timeoutHandle));
  }
}

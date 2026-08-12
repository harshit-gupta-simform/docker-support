import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from '../config/env.validation';
import { ChunkType } from './embedding.types';

@Injectable()
export class EmbeddingConfigService {
  constructor(private readonly configService: ConfigService<EnvConfig, true>) {}

  get provider(): EnvConfig['EMBEDDING_PROVIDER'] {
    return this.configService.get('EMBEDDING_PROVIDER', { infer: true });
  }

  get model(): string {
    return this.configService.get('EMBEDDING_MODEL', { infer: true });
  }

  get modelVersion(): string {
    return this.configService.get('EMBEDDING_MODEL_VERSION', { infer: true });
  }

  get dimensions(): number {
    return this.configService.get('EMBEDDING_DIMENSIONS', { infer: true });
  }

  get apiKey(): string {
    return this.configService.get('EMBEDDING_API_KEY', { infer: true });
  }

  get baseUrl(): string {
    return this.configService.get('EMBEDDING_BASE_URL', { infer: true });
  }

  get batchSize(): number {
    return this.configService.get('EMBEDDING_BATCH_SIZE', { infer: true });
  }

  get maxConcurrentBatches(): number {
    return this.configService.get('EMBEDDING_MAX_CONCURRENT_BATCHES', {
      infer: true,
    });
  }

  get maxRetries(): number {
    return this.configService.get('EMBEDDING_MAX_RETRIES', { infer: true });
  }

  get retryBaseDelayMs(): number {
    return this.configService.get('EMBEDDING_RETRY_BASE_DELAY_MS', {
      infer: true,
    });
  }

  get retryMaxDelayMs(): number {
    return this.configService.get('EMBEDDING_RETRY_MAX_DELAY_MS', {
      infer: true,
    });
  }

  get requestTimeoutMs(): number {
    return this.configService.get('EMBEDDING_REQUEST_TIMEOUT_MS', {
      infer: true,
    });
  }

  get inputMaxTokens(): number {
    return this.configService.get('EMBEDDING_INPUT_MAX_TOKENS', {
      infer: true,
    });
  }

  get includeHeadingContext(): boolean {
    return this.configService.get('EMBEDDING_INCLUDE_HEADING_CONTEXT', {
      infer: true,
    });
  }

  get chunkTypes(): ChunkType[] {
    return this.configService.get('EMBEDDING_CHUNK_TYPES', { infer: true });
  }

  get outputDir(): string {
    return this.configService.get('EMBEDDING_OUTPUT_DIR', { infer: true });
  }

  get failureThreshold(): number {
    return this.configService.get('EMBEDDING_FAILURE_THRESHOLD', {
      infer: true,
    });
  }
}

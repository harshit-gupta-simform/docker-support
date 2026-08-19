import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from '../config/env.validation';

@Injectable()
export class VectorStoreConfigService {
  constructor(private readonly configService: ConfigService<EnvConfig, true>) {}

  get provider(): EnvConfig['VECTOR_STORE_PROVIDER'] {
    return this.configService.get('VECTOR_STORE_PROVIDER', { infer: true });
  }

  get url(): string {
    return this.configService.get('VECTOR_STORE_URL', { infer: true });
  }

  get apiKey(): string {
    return this.configService.get('VECTOR_STORE_API_KEY', { infer: true });
  }

  get domain(): string {
    return this.configService.get('VECTOR_STORE_DOMAIN', { infer: true });
  }

  get batchSize(): number {
    return this.configService.get('VECTOR_STORE_BATCH_SIZE', { infer: true });
  }

  get maxConcurrentBatches(): number {
    return this.configService.get('VECTOR_STORE_MAX_CONCURRENT_BATCHES', {
      infer: true,
    });
  }

  get maxRetries(): number {
    return this.configService.get('VECTOR_STORE_MAX_RETRIES', {
      infer: true,
    });
  }

  get retryBaseDelayMs(): number {
    return this.configService.get('VECTOR_STORE_RETRY_BASE_DELAY_MS', {
      infer: true,
    });
  }

  get retryMaxDelayMs(): number {
    return this.configService.get('VECTOR_STORE_RETRY_MAX_DELAY_MS', {
      infer: true,
    });
  }

  get requestTimeoutMs(): number {
    return this.configService.get('VECTOR_STORE_REQUEST_TIMEOUT_MS', {
      infer: true,
    });
  }

  get failureThreshold(): number {
    return this.configService.get('VECTOR_STORE_FAILURE_THRESHOLD', {
      infer: true,
    });
  }

  get skipExisting(): boolean {
    return this.configService.get('VECTOR_STORE_SKIP_EXISTING', {
      infer: true,
    });
  }

  get allowFakeProvider(): boolean {
    return this.configService.get('VECTOR_STORE_ALLOW_FAKE_PROVIDER', {
      infer: true,
    });
  }
}

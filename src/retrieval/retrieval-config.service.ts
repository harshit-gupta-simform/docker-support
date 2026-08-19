import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from '../config/env.validation';

@Injectable()
export class RetrievalConfigService {
  constructor(private readonly configService: ConfigService<EnvConfig, true>) {}

  get defaultTopK(): number {
    return this.configService.get('RETRIEVAL_DEFAULT_TOP_K', { infer: true });
  }

  get maxTopK(): number {
    return this.configService.get('RETRIEVAL_MAX_TOP_K', { infer: true });
  }

  get scoreThreshold(): number {
    return this.configService.get('RETRIEVAL_SCORE_THRESHOLD', {
      infer: true,
    });
  }

  get expandToParent(): boolean {
    return this.configService.get('RETRIEVAL_EXPAND_TO_PARENT', {
      infer: true,
    });
  }

  get requestTimeoutMs(): number {
    return this.configService.get('RETRIEVAL_REQUEST_TIMEOUT_MS', {
      infer: true,
    });
  }

  get maxRetries(): number {
    return this.configService.get('RETRIEVAL_MAX_RETRIES', { infer: true });
  }
}

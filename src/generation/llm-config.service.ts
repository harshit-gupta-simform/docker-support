import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from '../config/env.validation';

@Injectable()
export class LlmConfigService {
  constructor(private readonly configService: ConfigService<EnvConfig, true>) {}

  get provider(): EnvConfig['LLM_PROVIDER'] {
    return this.configService.get('LLM_PROVIDER', { infer: true });
  }

  get model(): string {
    return this.configService.get('LLM_MODEL', { infer: true });
  }

  get apiKey(): string {
    return this.configService.get('LLM_API_KEY', { infer: true });
  }

  get timeoutMs(): number {
    return this.configService.get('LLM_TIMEOUT_MS', { infer: true });
  }

  get maxRetries(): number {
    return this.configService.get('LLM_MAX_RETRIES', { infer: true });
  }

  get maxOutputTokens(): number {
    return this.configService.get('LLM_MAX_OUTPUT_TOKENS', { infer: true });
  }

  get temperature(): number {
    return this.configService.get('LLM_TEMPERATURE', { infer: true });
  }

  get maxContextChunks(): number {
    return this.configService.get('LLM_MAX_CONTEXT_CHUNKS', { infer: true });
  }

  get minRetrievalScore(): number {
    return this.configService.get('LLM_MIN_RETRIEVAL_SCORE', { infer: true });
  }

  get maxContextChars(): number {
    return this.configService.get('LLM_MAX_CONTEXT_CHARS', { infer: true });
  }

  get thinkingLevel(): EnvConfig['LLM_THINKING_LEVEL'] {
    return this.configService.get('LLM_THINKING_LEVEL', { infer: true });
  }
}

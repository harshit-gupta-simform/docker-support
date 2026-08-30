import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { EnvConfig } from '../config/env.validation';
import { LlmConfigService } from './llm-config.service';

function buildModule(overrides: Partial<EnvConfig> = {}) {
  const defaults: Partial<EnvConfig> = {
    LLM_PROVIDER: 'google',
    LLM_MODEL: 'gemini-2.5-flash',
    LLM_API_KEY: '',
    LLM_TIMEOUT_MS: 15000,
    LLM_MAX_RETRIES: 2,
    LLM_MAX_OUTPUT_TOKENS: 1024,
    LLM_TEMPERATURE: 0.2,
    LLM_MAX_CONTEXT_CHUNKS: 5,
    LLM_MIN_RETRIEVAL_SCORE: 0,
    LLM_MAX_CONTEXT_CHARS: 12000,
    LLM_THINKING_LEVEL: '',
    LLM_MAX_PROMPT_TOKENS: 8000,
    LLM_INPUT_PRICE_PER_1M_TOKENS: 0.75,
    LLM_OUTPUT_PRICE_PER_1M_TOKENS: 3.75,
  };
  return Test.createTestingModule({
    providers: [
      LlmConfigService,
      {
        provide: ConfigService,
        useValue: {
          get: (key: keyof EnvConfig) => ({ ...defaults, ...overrides })[key],
        },
      },
    ],
  }).compile();
}

describe('LlmConfigService', () => {
  it('exposes every LLM_* env var through a typed getter', async () => {
    const moduleRef = await buildModule({
      LLM_PROVIDER: 'fake',
      LLM_MODEL: 'fake-model',
      LLM_API_KEY: 'secret',
      LLM_TIMEOUT_MS: 5000,
      LLM_MAX_RETRIES: 3,
      LLM_MAX_OUTPUT_TOKENS: 512,
      LLM_TEMPERATURE: 0.5,
      LLM_MAX_CONTEXT_CHUNKS: 8,
      LLM_MIN_RETRIEVAL_SCORE: 0.3,
      LLM_MAX_CONTEXT_CHARS: 8000,
      LLM_THINKING_LEVEL: 'LOW',
      LLM_MAX_PROMPT_TOKENS: 4000,
      LLM_INPUT_PRICE_PER_1M_TOKENS: 1.5,
      LLM_OUTPUT_PRICE_PER_1M_TOKENS: 7.5,
    });
    const config = moduleRef.get(LlmConfigService);

    expect(config.provider).toBe('fake');
    expect(config.model).toBe('fake-model');
    expect(config.apiKey).toBe('secret');
    expect(config.timeoutMs).toBe(5000);
    expect(config.maxRetries).toBe(3);
    expect(config.maxOutputTokens).toBe(512);
    expect(config.temperature).toBe(0.5);
    expect(config.maxContextChunks).toBe(8);
    expect(config.minRetrievalScore).toBe(0.3);
    expect(config.maxContextChars).toBe(8000);
    expect(config.thinkingLevel).toBe('LOW');
    expect(config.maxPromptTokens).toBe(4000);
    expect(config.inputPricePerMillionTokens).toBe(1.5);
    expect(config.outputPricePerMillionTokens).toBe(7.5);
  });
});

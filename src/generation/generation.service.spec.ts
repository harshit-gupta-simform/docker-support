import { PinoLogger } from 'nestjs-pino';
import {
  GenerationService,
  INSUFFICIENT_CONTEXT_ANSWER,
} from './generation.service';
import { ContextPolicyService } from './context-policy.service';
import { PromptBuilderService } from './prompt-builder.service';
import { LlmConfigService } from './llm-config.service';
import { LlmProviderPort } from './llm-provider.port';
import { RetrievalResult } from '../retrieval/retrieval.types';
import {
  TransientLlmProviderError,
  GenerationProviderError,
  LlmResponseValidationError,
  RateLimitLlmProviderError,
  PermanentLlmProviderError,
  PromptTokenLimitExceededError,
} from './llm.errors';

function buildLogger(): PinoLogger {
  return {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as PinoLogger;
}

function buildConfig(
  overrides: Partial<LlmConfigService> = {},
): LlmConfigService {
  return {
    minRetrievalScore: 0,
    maxContextChunks: 5,
    maxContextChars: 12000,
    maxRetries: 2,
    maxOutputTokens: 100,
    temperature: 0.2,
    timeoutMs: 200,
    maxPromptTokens: 100000,
    inputPricePerMillionTokens: 0.75,
    outputPricePerMillionTokens: 3.75,
    ...overrides,
  } as LlmConfigService;
}

function buildResult(
  overrides: Partial<RetrievalResult> = {},
): RetrievalResult {
  return {
    chunkId: 'c1',
    documentId: 'd1',
    parentChunkId: null,
    chunkType: 'child',
    score: 0.9,
    text: 'text',
    parentText: null,
    headingPath: 'Install',
    documentTitle: 'Install Docker',
    sourcePath: 'install.md',
    domain: 'docker',
    ...overrides,
  };
}

function buildService(llm: LlmProviderPort, config = buildConfig()) {
  return new GenerationService(
    llm,
    new ContextPolicyService(config),
    new PromptBuilderService(),
    config,
    buildLogger(),
  );
}

describe('GenerationService', () => {
  it('returns the controlled answer without calling the LLM when there are no results', async () => {
    const generate = jest.fn();
    const service = buildService({
      metadata: { provider: 'fake', model: 'fake' },
      generate,
    });

    const result = await service.generate('question', []);

    expect(result.answer).toBe(INSUFFICIENT_CONTEXT_ANSWER);
    expect(result.sources).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
  });

  it('returns the controlled answer without calling the LLM when all results are below threshold', async () => {
    const generate = jest.fn();
    const config = buildConfig({ minRetrievalScore: 0.9 });
    const service = buildService(
      { metadata: { provider: 'fake', model: 'fake' }, generate },
      config,
    );

    const result = await service.generate('question', [
      buildResult({ score: 0.1 }),
    ]);

    expect(result.answer).toBe(INSUFFICIENT_CONTEXT_ANSWER);
    expect(generate).not.toHaveBeenCalled();
  });

  it('calls the LLM and returns a grounded answer with extracted sources', async () => {
    const generate = jest
      .fn()
      .mockResolvedValue({ text: 'The answer is X [S1].' });
    const service = buildService({
      metadata: { provider: 'google', model: 'gemini-2.5-flash' },
      generate,
    });

    const result = await service.generate('question', [buildResult()]);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.answer).toBe('The answer is X [S1].');
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]!.chunkId).toBe('c1');
    expect(result.metadata).toEqual({
      provider: 'google',
      framework: 'langchain',
      model: 'gemini-2.5-flash',
      retrievedCount: 1,
    });
  });

  it('retries a transient failure and succeeds', async () => {
    const generate = jest
      .fn()
      .mockRejectedValueOnce(new TransientLlmProviderError('flaky'))
      .mockResolvedValueOnce({ text: 'ok [S1].' });
    const service = buildService({
      metadata: { provider: 'google', model: 'gemini-2.5-flash' },
      generate,
    });

    const result = await service.generate('question', [buildResult()]);

    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.answer).toBe('ok [S1].');
  });

  it('throws GenerationProviderError after retries are exhausted', async () => {
    const generate = jest
      .fn()
      .mockRejectedValue(new TransientLlmProviderError('always fails'));
    const service = buildService({
      metadata: { provider: 'google', model: 'gemini-2.5-flash' },
      generate,
    });

    await expect(
      service.generate('question', [buildResult()]),
    ).rejects.toBeInstanceOf(GenerationProviderError);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('throws GenerationProviderError with classification timeout when the LLM call hangs', async () => {
    const generate = jest.fn().mockImplementation(() => new Promise(() => {}));
    const config = buildConfig({ timeoutMs: 20, maxRetries: 1 });
    const service = buildService(
      { metadata: { provider: 'google', model: 'gemini-2.5-flash' }, generate },
      config,
    );

    await expect(
      service.generate('question', [buildResult()]),
    ).rejects.toMatchObject({
      classification: 'timeout',
    });
  });

  it('throws GenerationProviderError with classification internal for a response validation failure', async () => {
    const generate = jest
      .fn()
      .mockRejectedValue(new LlmResponseValidationError('empty response'));
    const service = buildService({
      metadata: { provider: 'google', model: 'gemini-2.5-flash' },
      generate,
    });

    await expect(
      service.generate('question', [buildResult()]),
    ).rejects.toMatchObject({
      classification: 'internal',
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('throws GenerationProviderError with classification quota after retries are exhausted on a rate limit error', async () => {
    const generate = jest
      .fn()
      .mockRejectedValue(new RateLimitLlmProviderError('rate limited'));
    const service = buildService({
      metadata: { provider: 'google', model: 'gemini-2.5-flash' },
      generate,
    });

    await expect(
      service.generate('question', [buildResult()]),
    ).rejects.toMatchObject({
      classification: 'quota',
    });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('throws GenerationProviderError with classification authentication for a permanent auth error', async () => {
    const generate = jest
      .fn()
      .mockRejectedValue(
        new PermanentLlmProviderError(
          'Gemini authentication failed: invalid api key',
        ),
      );
    const service = buildService({
      metadata: { provider: 'google', model: 'gemini-2.5-flash' },
      generate,
    });

    await expect(
      service.generate('question', [buildResult()]),
    ).rejects.toMatchObject({
      classification: 'authentication',
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('throws GenerationProviderError with classification internal as a fallback for unrecognized permanent errors', async () => {
    const generate = jest
      .fn()
      .mockRejectedValue(
        new PermanentLlmProviderError('Gemini request failed: model not found'),
      );
    const service = buildService({
      metadata: { provider: 'google', model: 'gemini-2.5-flash' },
      generate,
    });

    await expect(
      service.generate('question', [buildResult()]),
    ).rejects.toMatchObject({
      classification: 'internal',
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('throws PromptTokenLimitExceededError without calling the LLM when the estimated prompt exceeds the configured limit', async () => {
    const generate = jest.fn();
    const config = buildConfig({ maxPromptTokens: 1 });
    const service = buildService(
      {
        metadata: { provider: 'google', model: 'gemini-3.6-flash' },
        generate,
      },
      config,
    );

    await expect(
      service.generate('question', [buildResult()]),
    ).rejects.toBeInstanceOf(PromptTokenLimitExceededError);
    expect(generate).not.toHaveBeenCalled();
  });

  it('attaches real usage and computed cost to the result metadata when the provider reports usage', async () => {
    const generate = jest.fn().mockResolvedValue({
      text: 'The answer is X [S1].',
      usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
    });
    const config = buildConfig({
      inputPricePerMillionTokens: 0.75,
      outputPricePerMillionTokens: 3.75,
    });
    const service = buildService(
      {
        metadata: { provider: 'google', model: 'gemini-3.6-flash' },
        generate,
      },
      config,
    );

    const result = await service.generate('question', [buildResult()]);

    expect(result.metadata.usage).toEqual({
      inputTokens: 100,
      outputTokens: 200,
      totalTokens: 300,
    });
    expect(result.metadata.costUsd).toBeCloseTo(
      (100 / 1_000_000) * 0.75 + (200 / 1_000_000) * 3.75,
      10,
    );
  });

  it('omits usage and cost from the result metadata when the provider reports no usage', async () => {
    const generate = jest
      .fn()
      .mockResolvedValue({ text: 'The answer is X [S1].' });
    const service = buildService({
      metadata: { provider: 'google', model: 'gemini-3.6-flash' },
      generate,
    });

    const result = await service.generate('question', [buildResult()]);

    expect(result.metadata.usage).toBeUndefined();
    expect(result.metadata.costUsd).toBeUndefined();
  });
});

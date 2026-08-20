import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import { withRetry } from '../common/retry.util';
import { RetrievalResult } from '../retrieval/retrieval.types';
import { extractCitations } from './citation-extractor.util';
import { ContextPolicyService } from './context-policy.service';
import { BuiltPrompt, PromptBuilderService } from './prompt-builder.service';
import { GenerationResult } from './generation.types';
import {
  GenerationFailureClassification,
  GenerationProviderError,
  LlmResponseValidationError,
  PermanentLlmProviderError,
  RateLimitLlmProviderError,
  TransientLlmProviderError,
} from './llm.errors';
import { LlmConfigService } from './llm-config.service';
import { LLM_PROVIDER_PORT, type LlmProviderPort } from './llm-provider.port';

export const INSUFFICIENT_CONTEXT_ANSWER =
  "I couldn't find enough relevant information in the Docker documentation to answer this question reliably.";

@Injectable()
export class GenerationService {
  constructor(
    @Inject(LLM_PROVIDER_PORT) private readonly llm: LlmProviderPort,
    private readonly contextPolicy: ContextPolicyService,
    private readonly promptBuilder: PromptBuilderService,
    private readonly config: LlmConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(GenerationService.name);
  }

  async generate(
    question: string,
    results: RetrievalResult[],
  ): Promise<GenerationResult> {
    const queryId = randomUUID();
    const startedAt = Date.now();

    const metadata = {
      provider: this.llm.metadata.provider,
      framework: 'langchain' as const,
      model: this.llm.metadata.model,
      retrievedCount: results.length,
    };

    const selection = this.contextPolicy.select(results);
    if (!selection.ok) {
      this.logger.info(
        { queryId, reason: selection.reason },
        'Context rejected',
      );
      return { answer: INSUFFICIENT_CONTEXT_ANSWER, sources: [], metadata };
    }

    this.logger.info(
      { queryId, contextChunks: selection.chunks.length },
      'Generation started',
    );

    const prompt = await this.promptBuilder.build(question, selection.chunks);

    try {
      const response = await withRetry(() => this.invokeWithTimeout(prompt), {
        maxAttempts: this.config.maxRetries,
        baseDelayMs: 200,
        maxDelayMs: 2000,
        isRetryable: (err) => err instanceof TransientLlmProviderError,
        onRetry: (err, attempt) =>
          this.logger.warn(
            { queryId, attempt, err: err instanceof Error ? err.message : err },
            'LLM provider retry',
          ),
      });

      const sources = extractCitations(response.text, selection.chunks);

      this.logger.info(
        {
          queryId,
          durationMs: Date.now() - startedAt,
          sourceCount: sources.length,
        },
        'Generation completed',
      );

      return { answer: response.text, sources, metadata };
    } catch (err) {
      const classification = this.classify(err);
      this.logger.error(
        {
          queryId,
          classification,
          err: err instanceof Error ? err.message : err,
        },
        'Generation failed',
      );
      throw new GenerationProviderError(
        'LLM generation failed — see logs for details',
        classification,
      );
    }
  }

  private invokeWithTimeout(prompt: BuiltPrompt) {
    let timeoutHandle!: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(
          new TransientLlmProviderError(
            `LLM generation timed out after ${this.config.timeoutMs}ms`,
          ),
        );
      }, this.config.timeoutMs);
    });

    return Promise.race([
      this.llm.generate({
        systemPrompt: prompt.systemPrompt,
        userPrompt: prompt.userPrompt,
        maxOutputTokens: this.config.maxOutputTokens,
        temperature: this.config.temperature,
        ...(this.config.thinkingLevel
          ? { thinkingLevel: this.config.thinkingLevel }
          : {}),
      }),
      timeoutPromise,
    ]).finally(() => clearTimeout(timeoutHandle));
  }

  private classify(err: unknown): GenerationFailureClassification {
    if (err instanceof LlmResponseValidationError) {
      return 'internal';
    }
    if (err instanceof RateLimitLlmProviderError) {
      return 'quota';
    }
    if (err instanceof TransientLlmProviderError) {
      return /timed out/i.test(err.message) ? 'timeout' : 'provider';
    }
    if (
      err instanceof PermanentLlmProviderError &&
      /authentication/i.test(err.message)
    ) {
      return 'authentication';
    }
    return 'internal';
  }
}

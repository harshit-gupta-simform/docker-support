import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import {
  LlmGenerationRequest,
  LlmGenerationResponse,
  LlmModelMetadata,
  LlmProviderPort,
} from '../llm-provider.port';
import {
  LlmResponseValidationError,
  PermanentLlmProviderError,
  RateLimitLlmProviderError,
  TransientLlmProviderError,
} from '../llm.errors';

interface MessageContentPart {
  text?: string;
}

export class LangChainGoogleGenerativeAiProvider implements LlmProviderPort {
  constructor(
    private readonly apiKey: string,
    public readonly metadata: LlmModelMetadata,
  ) {}

  async generate(
    request: LlmGenerationRequest,
  ): Promise<LlmGenerationResponse> {
    const chatModel = new ChatGoogleGenerativeAI({
      apiKey: this.apiKey,
      model: this.metadata.model,
      temperature: request.temperature,
      maxOutputTokens: request.maxOutputTokens,
    });

    let response: { content: unknown; response_metadata?: unknown };
    try {
      response = await chatModel.invoke([
        ['system', request.systemPrompt],
        ['human', request.userPrompt],
      ]);
    } catch (err) {
      throw this.toError(err);
    }

    const finishReason = (
      response.response_metadata as { finishReason?: string } | undefined
    )?.finishReason;
    if (finishReason === 'SAFETY' || finishReason === 'RECITATION') {
      throw new LlmResponseValidationError(
        `Gemini declined to answer (finishReason=${finishReason})`,
      );
    }

    const text = this.extractText(response.content);
    if (text.trim().length === 0) {
      throw new LlmResponseValidationError('Gemini returned an empty response');
    }

    return { text };
  }

  private extractText(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return (content as MessageContentPart[])
        .map((part) => part.text ?? '')
        .join('');
    }
    return '';
  }

  private toError(err: unknown): Error {
    const status = this.extractStatus(err);
    const message = err instanceof Error ? err.message : String(err);

    if (status === 429 || /rate.?limit|quota/i.test(message)) {
      return new RateLimitLlmProviderError(
        `Gemini rate limit or quota exceeded: ${message}`,
      );
    }
    if (
      status === 401 ||
      status === 403 ||
      /api key|unauthenticated|permission/i.test(message)
    ) {
      return new PermanentLlmProviderError(
        `Gemini authentication failed: ${message}`,
      );
    }
    if (status !== undefined && status >= 500) {
      return new TransientLlmProviderError(
        `Gemini service error (status ${status}): ${message}`,
      );
    }
    if (/overloaded|unavailable|network|ECONNRESET|ETIMEDOUT/i.test(message)) {
      return new TransientLlmProviderError(
        `Gemini request failed: ${message}`,
        { cause: err },
      );
    }
    return new PermanentLlmProviderError(`Gemini request failed: ${message}`, {
      cause: err,
    });
  }

  private extractStatus(err: unknown): number | undefined {
    if (typeof err !== 'object' || err === null) {
      return undefined;
    }
    const candidate = err as {
      status?: unknown;
      response?: { status?: unknown };
    };
    if (typeof candidate.status === 'number') {
      return candidate.status;
    }
    if (typeof candidate.response?.status === 'number') {
      return candidate.response.status;
    }
    return undefined;
  }
}
